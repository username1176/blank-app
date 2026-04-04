import { createLogger } from '@dentalai/core';

const log = createLogger('dentrix');

/** PHI fields that must be redacted in logs */
const PHI_FIELDS = new Set([
  'firstName',
  'lastName',
  'dateOfBirth',
  'phone',
  'email',
  'ssn',
  'memberId',
  'groupNumber',
  'subscriberName',
  'street',
  'address',
]);

const REDACTED = '[REDACTED]';

/** Deep-clone an object and replace PHI field values with [REDACTED] */
export function redactPhi(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactPhi);
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (PHI_FIELDS.has(key)) {
      redacted[key] = REDACTED;
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactPhi(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export function logRequest(method: string, url: string, body?: unknown): void {
  const safeBody = body ? redactPhi(body) : undefined;
  log.info(`→ ${method.toUpperCase()} ${url}`, safeBody ? JSON.stringify(safeBody) : '');
}

export function logResponse(method: string, url: string, status: number, body?: unknown): void {
  const safeBody = body ? redactPhi(body) : undefined;
  log.info(`← ${status} ${method.toUpperCase()} ${url}`, safeBody ? JSON.stringify(safeBody) : '');
}

export function logRetry(attempt: number, maxRetries: number, delayMs: number, reason: string): void {
  log.warn(`Retry ${attempt}/${maxRetries} in ${delayMs}ms: ${reason}`);
}

export function logError(message: string, error?: unknown): void {
  log.error(message, error instanceof Error ? error.message : error);
}

export { log };
