import type { DoneCallback, Job } from 'bee-queue';

import compression from '@fastify/compress';
import helmet from '@fastify/helmet';
import { fastifyJwt } from '@fastify/jwt';
import * as _cluster from 'cluster';
import fastify from 'fastify';
import { readFile } from 'fs/promises';
import { InternalServerError, NotFound } from 'http-errors';
import httpStatus = require('http-status');
import yaml = require('js-yaml');
import uniq = require('lodash.uniq');
import minimist = require('minimist');
import { match } from 'node-match-path';
import { cpus } from 'os';
import { resolve } from 'path';
import { URL } from 'url';

import daos from './dao';
import { DaoHelper } from './dao/base';
import {
  Dependencies,
  HttpMethods,
  IBodyRequest,
  IConfig,
  IMapper,
  IMasterConfig,
  IRequest,
  IResponse,
  IResult,
  IWorkerConfig,
} from './interface';
import { ServerType } from './interface';
import logger from './logger';
import { connect as connectDB } from './sequelize';
import { applyCache, connectQueue, logSection, wait } from './utils';
import RateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';

const cluster = _cluster as unknown as _cluster.Cluster;

const base = true;

const argv = minimist(process.argv.slice(2));

const NODE_ENV = (process.env.NODE_ENV =
  argv.env || argv.E || process.env.NODE_ENV || 'development');

function masterMain(config: IMasterConfig) {
  logSection('Initialize Server', logger('Server'), async () => {
    const port = config.port || 8080;
    const redisConfig = config.redis || {};

    const mapperPath = resolve(
      __dirname,
      base ? '../templates/mapper.js' : 'mapper.js',
    );
    const mapper: IMapper[] = (await import(mapperPath)).default;

    const app = fastify({ logger: true });

    app.register(helmet);
    app.register(compression);

    // rate limit
    if (config.limit) {
      app.register(RateLimit, {
        max: config.limit.count,
        timeWindow: config.limit.window,
        keyGenerator: (req) =>
          (req.headers['x-real-ip'] as string) || // nginx
          (req.headers['x-client-ip'] as string) || // apache
          req.ip,
        skipOnError: true,
        redis: new Redis(redisConfig),
      });
    }

    // jwt plugin
    if (!config.auth.access_token.secret) {
      throw new InternalServerError('Missing Access Token Secret');
    }
    app.register(fastifyJwt, {
      secret: config.auth.access_token.secret,
    });

    // custom plugins
    const plugins = await import('./plugin');
    for (const key of Object.keys(plugins)) app.register(plugins[key], config);

    // health check
    app.get('/health', async (request, reply): Promise<IResponse> => {
      // no cache
      reply.header('cache-control', 'no-cache, no-store');

      const start = Date.now();
      const keys = uniq(mapper.map((m) => m.queue));
      let statusCode = httpStatus.OK;
      const result = await Promise.all(
        keys.map<Promise<IResponse>>(async (key) => {
          let job: Job<IRequest>;
          try {
            const queue = connectQueue('server', key, redisConfig, request.log);
            const data: IRequest = {
              method: 'HEALTH',
              url: '',
              headers: request.headers,
              query: {},
              params: {},
            };
            job = await queue.createJob(data).save();
            const result = await wait(queue, job, 3 * 1000); // healthy server can return within 3 seconds
            return {
              ...result,
              result: undefined,
              queue: key,
              elapsed: Date.now() - start,
            };
          } catch (e) {
            return {
              statusCode: e.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
              error: e.message,
              queue: key,
              elapsed: Date.now() - start,
            };
          }
        }),
      );
      const unavailable = result.find((r) => r.statusCode !== httpStatus.OK);
      if (unavailable) statusCode = httpStatus.SERVICE_UNAVAILABLE;
      reply.status(statusCode);
      return unavailable
        ? /* eslint-disable */ {
          statusCode,
          error: httpStatus['500_NAME'],
          elapsed: Date.now() - start,
        }
        : {
          statusCode,
          result,
          elapsed: Date.now() - start,
        }; /* eslint-enable */

    });

    // RESTful api call
    app.all('*', async (request, reply): Promise<IResponse> => {
      // default cache
      if (config.cache) applyCache(reply, config.cache);

      let job: Job<IRequest>;
      const start = Date.now();
      try {
        const url = new URL(request.url, `http://localhost:${port}`);
        for (const { method, path, pre, post, queue: key } of mapper) {
          const REQ_METHOD = request.method.toLocaleUpperCase();
          const MAP_METHOD = method.toLocaleUpperCase();
          if (REQ_METHOD === MAP_METHOD || 'ALL' === MAP_METHOD) {
            const { matches } = match(path, url.pathname);
            if (matches) {
              const data: IRequest = {
                method: REQ_METHOD as HttpMethods,
                url: request.url,
                headers: request.headers,
                query: request.query,
                params: request.params,
              };

              if (pre) await pre(request, data);

              const queue = connectQueue(
                'server',
                key,
                redisConfig,
                request.log,
              );
              if (['POST', 'PUT', 'PATCH'].indexOf(REQ_METHOD) > -1) {
                (data as IBodyRequest).body = request.body;
              }
              job = await queue.createJob(data).save();
              const result = await wait<IRequest>(
                queue,
                job,
                config.timeout || 30 * 1000,
              );
              reply.status(result.statusCode);

              // post-process
              if (post) await post(request, reply, result);

              if ('cache' in result) {
                applyCache(reply, result.cache);
                delete result.cache;
              }

              return {
                ...result,
                elapsed: Date.now() - start,
              };
            }
          }
        }
        reply.status(httpStatus.NOT_FOUND);
        throw new NotFound();
      } catch (e) {
        const statusCode = e.statusCode || httpStatus.INTERNAL_SERVER_ERROR;
        reply.status(statusCode);
        return {
          statusCode,
          error: e.message,
          extra: e.extra,
          elapsed: Date.now() - start,
        };
      }
    });

    await app.listen({ host: '0.0.0.0', port });
  });
}

function workerMain(config: IWorkerConfig) {
  const myLogger = logger('Worker');
  logSection('Initialize Worker', myLogger, async () => {
    const redisConfig = config.redis || {};

    const dependencies = new Dependencies();

    if (config.database) {
      const sequelize = await connectDB(config);
      dependencies.register(sequelize); // Sequelize

      const daoHelper = new DaoHelper(sequelize);
      for (const [daoClass, customDao, options] of daos) {
        daoHelper.register(
          daoClass,
          new customDao(sequelize, daoHelper, options),
        );
      }
      dependencies.register(daoHelper); // DaoHelper
    }

    const dependencies_ = require('./dependency') || {};
    await Promise.all(
      Object.keys(dependencies_).map(async (key) => {
        dependencies.register(await dependencies_[key](config));
      }),
    );

    Promise.all(
      config.modules.map((key) => {
        const queueLogger = logger(`Queue:${key}`);
        return import(resolve(__dirname, 'queue', key)).then(
          async ({ default: module }) => {
            const queue = await connectQueue(
              'worker',
              key,
              redisConfig,
              queueLogger,
            );
            const queueInst = new module(config, dependencies);
            return queue.process(
              (job: Job<IRequest>, done: DoneCallback<IResult>) => {
                queueLogger.info(job.data);
                queueInst
                  .run(job.data)
                  .then((result) => done(null, result))
                  .catch((e) => {
                    queueLogger.error(e, e.message);
                    done(e.statusCode ? new Error(e.statusCode) : e);
                  });
              },
            );
          },
        );
      }),
    );
  });
}

async function main() {
  const content = await readFile(
    resolve(base ? 'templates' : 'configs', `config.${NODE_ENV}.yaml`),
    'utf8',
  );
  const config = yaml.load(content) as IConfig;
  let clusters: number;
  if (config.clusters === true) {
    clusters = cpus().length;
  } else if (config.clusters === false) {
    clusters = 0;
  } else {
    clusters = config.clusters;
  }

  let serverType: ServerType;
  switch (true) {
    case 'port' in config && 'modules' in config:
      serverType = ServerType.HYBRID;
      break;
    case 'port' in config:
      serverType = ServerType.MASTER;
      break;
    case 'modules' in config:
      serverType = ServerType.WORKER;
      break;
  }

  if (!clusters) {
    if (serverType !== ServerType.WORKER) {
      masterMain(config as IMasterConfig);
    }
    if (serverType !== ServerType.MASTER) {
      workerMain(config as IWorkerConfig);
    }
    return;
  }

  if (cluster.isPrimary) {
    for (let i = 0; i < clusters; i++) {
      cluster.fork();
    }
    if (serverType === ServerType.HYBRID) {
      masterMain(config as IMasterConfig);
    }
  } else if (serverType === ServerType.MASTER) {
    masterMain(config as IMasterConfig);
  } else {
    workerMain(config as IWorkerConfig);
  }
}

main();
