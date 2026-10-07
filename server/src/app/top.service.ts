/**
 * Топ мерчантов. Тонкая обёртка над доменным генератором: валидирует период и
 * метрику, отдаёт таблицу лидеров. Пул бирж берём из набора, известного фиду.
 */
import type { ExchangeFeed } from '../ports.js';
import { buildLeaderboard, isMetric, isPeriod, type TopEntry } from '../domain/leaderboard.js';
import { err } from '../domain/errors.js';

export class TopService {
  private readonly exchanges: string[];
  constructor(feed: ExchangeFeed) {
    this.exchanges = [...feed.knownExchanges()];
  }

  leaderboard(periodRaw: string, metricRaw: string, limit = 30): { period: string; metric: string; entries: TopEntry[] } {
    const period = periodRaw || 'week';
    const metric = metricRaw || 'volume';
    if (!isPeriod(period)) throw err('validation', 'period ∈ {week, month, all}');
    if (!isMetric(metric)) throw err('validation', 'metric ∈ {volume, orders}');
    const n = Math.max(3, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 30));
    return { period, metric, entries: buildLeaderboard(this.exchanges, period, metric, n) };
  }
}
