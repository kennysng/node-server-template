import type { Logger } from 'pino';
import type { Includeable } from 'sequelize';

import { InternalServerError } from 'http-errors';

export class Dependencies {
  private static instance: Dependencies;
  private readonly dependencies: Record<string, any> = {};

  constructor() {
    if (!Dependencies.instance) Dependencies.instance = this;
    return Dependencies.instance;
  }

  register<T>(dependency: T) {
    this.dependencies[dependency.constructor.name] = dependency;
  }

  get<T>(dependency: new (...args: any[]) => T): T {
    const key = dependency.name;
    const result = this.dependencies[key];
    if (!result) throw new InternalServerError(`Dependency ${key} Not Found`);
    return result;
  }
}

export interface IBaseConfig {
  clusters?: boolean | number;
  timeout?: number;
  redis?: {
    secure?: boolean;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };
  database?: {
    dialect?: string;
    host?: string;
    port?: number;
    username: string;
    password: string;
    database: string;
    sync?: boolean;
  };
}

interface ITokenOptions {
  secret?: string;
  expires_in?: string;
}

export interface ICache {
  private?: boolean;
  noCache?: boolean;
  noStore?: boolean;
  maxAge?: number;
  lastModified?: string;
}

export interface IMasterConfig extends IBaseConfig {
  port?: number;
  package?: string;
  cache?: ICache;
  limit?: {
    count: number;
    window: number;
    perEndpoint: boolean;
  };
  auth: {
    cookie?: ITokenOptions;
    access_token: ITokenOptions;
    refresh_token: ITokenOptions;
  };
  mapper: IMapper[];
}

export interface IWorkerConfig extends IBaseConfig {
  modules: string[];
}

export type IConfig = IMasterConfig | IWorkerConfig;

export enum ServerType {
  MASTER = 'master',
  WORKER = 'worker',
  HYBRID = 'hybrid',
}

export interface IMapper {
  method?: HttpMethods;
  path: string;
  queue: string;
  plugins?: string[];
}

export interface IJwtPayload {
  i: number; // id
  // TODO
}

export interface IUser {
  id: number;
  // TODO
}

/* eslint-disable */
export type HttpMethods =
  | 'ALL'
  | 'HEALTH'
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'CONNECT'
  | 'OPTIONS'
  | 'TRACE'
  | 'PATCH';
/* eslint-enable */

interface IBaseRequest<Q, P, E> {
  method: HttpMethods;
  url: string;
  headers: Record<string, string | string[]>;
  query: Q;
  params: P;
  user?: IUser;
  extra: E;
}

export interface IBodyRequest<B = any, Q = any, P = any, E = any>
  extends IBaseRequest<Q, P, E> {
  method: 'ALL' | 'POST' | 'PUT' | 'PATCH';
  body?: B;
}

export type IRequest<B = any, Q = any, P = any, E = any> =
  | IBaseRequest<Q, P, E>
  | IBodyRequest<B, Q, P>;

export type IResponse<T = any> = IResult<T> | IError<T>;

interface IBaseResponse {
  statusCode: number;
  elapsed?: number;
}

export interface IResult<T = any> extends IBaseResponse {
  result?: T;
  cache?: ICache;
}

export type IJwtResult = IResult<IUser>;

export interface IError<T = any> extends IBaseResponse {
  error: string;
  stack?: string;
  extra?: T;
}

export type Options = {
  logger?: Logger;
  defaultInclude?: Includeable[];
  deleteMode?: 'deletedAt' | 'destroy';
};
