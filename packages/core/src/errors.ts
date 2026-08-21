/** Error codes are part of the API contract — docs/plan/credits-mvp.md §6.7. */
export type ErrorCode =
  | 'validation_failed'
  | 'idempotency_key_required'
  | 'idempotency_key_reuse'
  | 'unauthorized'
  | 'not_found'
  | 'authorization_closed'
  | 'authorization_matured'
  | 'cost_table_version_exists'
  | 'integer_required'
  | 'rate_limited'
  | 'internal';

export class TegataError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TegataError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const err = {
  validation: (message: string, details: Record<string, unknown> = {}) =>
    new TegataError('validation_failed', 400, message, details),
  idempotencyRequired: () =>
    new TegataError('idempotency_key_required', 400, 'Idempotency-Key header is required'),
  idempotencyReuse: (key: string) =>
    new TegataError('idempotency_key_reuse', 409, 'Idempotency key reused with a different body', { key }),
  unauthorized: () => new TegataError('unauthorized', 401, 'Invalid or missing API key'),
  notFound: (what: string, id: string) =>
    new TegataError('not_found', 404, `${what} not found`, { id }),
  authorizationClosed: (id: string, state: string) =>
    new TegataError('authorization_closed', 409, `Authorization is already ${state}`, { authorization_id: id, state }),
  authorizationMatured: (id: string, maturity: string) =>
    new TegataError('authorization_matured', 409,
      'Authorization passed its maturity; record the usage as a direct settlement instead',
      { authorization_id: id, maturity }),
  costTableExists: (version: string) =>
    new TegataError('cost_table_version_exists', 409, 'Cost table version already exists; versions are append-only', { version }),
  integerRequired: (field: string, value: unknown) =>
    new TegataError('integer_required', 422, `${field} must be a safe integer`, { field, value }),
};
