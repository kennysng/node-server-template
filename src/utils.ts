import { Logger } from 'pino';
import { Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

import { MyException } from './exceptions';

type Result<T> = {
  result?: T;
  error?: any;
  start: number;
  end: number;
};

export async function logElapsed<T>(
  callback: () => T | Promise<T>,
): Promise<Result<T>> {
  const now = Date.now();
  try {
    const result = await callback();
    return { result, start: now, end: Date.now() };
  } catch (error) {
    return { error, start: now, end: Date.now() };
  }
}

export async function logSection<T>(
  func: string,
  logger: Logger,
  callback: () => T | Promise<T>,
) {
  logger.debug(`${func} start`);
  const { result, error, start, end } = await logElapsed(callback);
  if (error) {
    MyException.throw(func, error);
  } else {
    logger.debug(`${func} end: ${end - start}ms`);
    return result;
  }
}

export async function inTransaction<T>(
  sequelize: Sequelize,
  callback: (transaction: Transaction) => Promise<T>,
  transaction?: Transaction,
): Promise<T> {
  const withTransaction = !!transaction;
  let rollback = false;
  if (!withTransaction) transaction = await sequelize.transaction();
  try {
    return await callback(transaction);
  } catch (e) {
    if (!withTransaction) {
      await transaction.rollback();
      rollback = true;
    }
    MyException.throw('inTransaction', e);
  } finally {
    if (!withTransaction && !rollback) await transaction.commit();
  }
}
