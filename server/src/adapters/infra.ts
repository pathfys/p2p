/**
 * Инфраструктурные адаптеры: системные часы, генератор id, JSON-логгер.
 * Тривиальны, но живут за портами — в тестах подменяются на фиктивные.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { Clock, IdGen, Logger, LogLevel } from '../ports.js';

export const systemClock: Clock = { now: () => Date.now() };

export const cryptoIdGen: IdGen = {
  uid(prefix: string): string {
    return `${prefix}_${randomBytes(9).toString('base64url')}`;
  },
  random(): number {
    // равномерное [0,1) из криптоисточника (без смещения модуло)
    return randomInt(0, 2 ** 31) / 2 ** 31;
  },
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Структурный логгер в stdout (JSON-строки). PII сюда не пишем. */
export class JsonLogger implements Logger {
  private readonly base: Record<string, unknown>;
  private readonly min: number;

  constructor(minLevel: LogLevel = 'info', base: Record<string, unknown> = {}) {
    this.min = LEVEL_RANK[minLevel];
    this.base = base;
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_RANK[level] < this.min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...this.base, ...fields });
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  child(fields: Record<string, unknown>): Logger {
    const minName = (Object.keys(LEVEL_RANK) as LogLevel[]).find((k) => LEVEL_RANK[k] === this.min) ?? 'info';
    return new JsonLogger(minName, { ...this.base, ...fields });
  }
}
