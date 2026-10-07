/**
 * Таксономия доменных ошибок. HTTP/WS-адаптеры превращают их в коды ответов,
 * но сам домен ничего не знает про транспорт. `code` — машиночитаемый,
 * `message` безопасен для показа клиенту (без утечки внутренностей).
 */
export type ErrorCode =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'plan_required'
  | 'kyc_required'
  | 'limit_exceeded'
  | 'insufficient_funds'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  plan_required: 402,
  kyc_required: 403,
  limit_exceeded: 422,
  insufficient_funds: 422,
  internal: 500,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Необязательные детали (например, ошибки по полям) — тоже безопасны для клиента. */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const err = (code: ErrorCode, message: string, details?: Record<string, unknown>): DomainError =>
  new DomainError(code, message, details);
