/**
 * KYC: уровни, лимиты и переходы статуса верификации. Лимиты — серверный
 * источник истины (клиентский preflight лишь для UX). Персональные данные
 * здесь НЕ хранятся: домен оперирует только уровнем и статусом; в проде анкета
 * и документы уходят напрямую провайдеру (Sumsub/Shufti), бэкенд видит вердикт.
 */
import type { KycState } from './types.js';
import { err } from './errors.js';

export interface KycLevel {
  level: number;
  name: string;
  dayLimitUsdt: number; // Infinity → без лимита
  monthLimitUsdt: number;
  steps: readonly string[];
}

export const KYC_LEVELS: readonly KycLevel[] = [
  { level: 0, name: 'Не верифицирован', dayLimitUsdt: 0, monthLimitUsdt: 0, steps: [] },
  { level: 1, name: 'Базовый', dayLimitUsdt: 10_000, monthLimitUsdt: 100_000, steps: ['personal', 'document'] },
  { level: 2, name: 'Расширенный', dayLimitUsdt: 100_000, monthLimitUsdt: 1_500_000, steps: ['personal', 'document', 'selfie', 'address'] },
  { level: 3, name: 'Корпоративный', dayLimitUsdt: Infinity, monthLimitUsdt: Infinity, steps: ['personal', 'document', 'selfie', 'address', 'company'] },
];

export const levelInfo = (level: number): KycLevel => KYC_LEVELS[Math.max(0, Math.min(3, level))]!;

export const dayLimitFor = (level: number): number => levelInfo(level).dayLimitUsdt;

export function initialKyc(): KycState {
  return { status: 'none', level: 0, pendingLevel: null, submittedAt: null, reviewedAt: null, rejectReason: null };
}

/** Можно ли сейчас подавать заявку на указанный уровень. */
export function assertCanSubmit(state: KycState, targetLevel: number): void {
  if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 3) {
    throw err('validation', 'Некорректный уровень KYC (1..3)');
  }
  if (state.status === 'pending') throw err('conflict', 'Заявка уже на проверке');
  if (state.status === 'approved' && state.level >= targetLevel) {
    throw err('conflict', `Уровень ${targetLevel} уже подтверждён`);
  }
  if (targetLevel > state.level + 1) {
    throw err('validation', `Нельзя перепрыгнуть уровень: доступен ${state.level + 1}`);
  }
}

export function toPending(state: KycState, targetLevel: number, now: number): KycState {
  return { ...state, status: 'pending', pendingLevel: targetLevel, submittedAt: now, rejectReason: null };
}

export function toApproved(state: KycState, now: number): KycState {
  const level = state.pendingLevel ?? Math.max(1, state.level);
  return { ...state, status: 'approved', level, pendingLevel: null, reviewedAt: now, rejectReason: null };
}

export function toRejected(state: KycState, reason: string, now: number): KycState {
  return { ...state, status: 'rejected', pendingLevel: null, reviewedAt: now, rejectReason: reason };
}

export const canTrade = (state: KycState): boolean => state.status === 'approved' && state.level >= 1;
