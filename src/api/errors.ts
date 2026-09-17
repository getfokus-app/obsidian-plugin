/**
 * The failures the sync has to tell apart, because each needs a different
 * response: retry, stop, wait, or ask the user for something.
 */
export type FokusErrorKind =
  | 'unauthorized' // token revoked or expired — stop and prompt
  | 'pro-required' // the account has no Pro entitlement — stop, never retry
  | 'client-id' // our own header is wrong — a bug, stop
  | 'forbidden'
  | 'not-found'
  | 'conflict' // duplicate external id, or someone holds the edit lock
  | 'unrepresentable' // markdown cannot carry what this note holds
  | 'rate-limited'
  | 'validation'
  | 'server'
  | 'offline';

export class FokusApiError extends Error {
  constructor(
    readonly kind: FokusErrorKind,
    readonly status: number,
    message: string,
    /** The parsed response body, which carries `noteId` / `lockedBy` / `unrepresentable`. */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FokusApiError';
  }
}

export function classify(
  status: number,
  body: Record<string, unknown> | undefined,
): FokusErrorKind {
  const message = String(body?.message ?? '');

  if (status === 401) return 'unauthorized';
  if (status === 403) {
    if (body?.code === 'PRO_REQUIRED' || /pro subscription/i.test(message)) return 'pro-required';
    if (/client id/i.test(message)) return 'client-id';
    return 'forbidden';
  }
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'unrepresentable';
  if (status === 429) return 'rate-limited';
  if (status === 400) return 'validation';
  return 'server';
}
