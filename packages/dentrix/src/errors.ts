/** Dentrix-specific error codes returned by the API */
export enum DentrixErrorCode {
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  PATIENT_NOT_FOUND = 'PATIENT_NOT_FOUND',
  PROVIDER_NOT_FOUND = 'PROVIDER_NOT_FOUND',
  APPOINTMENT_NOT_FOUND = 'APPOINTMENT_NOT_FOUND',
  APPOINTMENT_CONFLICT = 'APPOINTMENT_CONFLICT',
  SLOT_UNAVAILABLE = 'SLOT_UNAVAILABLE',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TOKEN_REFRESH_FAILED = 'TOKEN_REFRESH_FAILED',
  UNKNOWN = 'UNKNOWN',
}

export class DentrixError extends Error {
  constructor(
    message: string,
    public readonly code: DentrixErrorCode,
    public readonly statusCode: number | null,
    public readonly retryable: boolean,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DentrixError';
  }
}

const RETRYABLE_STATUS_CODES = new Set([401, 408, 429, 500, 502, 503, 504]);

/** Map an HTTP status + Dentrix error code string to a typed DentrixError */
export function mapApiError(
  statusCode: number,
  apiCode: string | undefined,
  apiMessage: string | undefined,
  details?: unknown,
): DentrixError {
  const code = mapErrorCode(statusCode, apiCode);
  const retryable = RETRYABLE_STATUS_CODES.has(statusCode);
  const message = apiMessage ?? `Dentrix API error: ${code} (HTTP ${statusCode})`;
  return new DentrixError(message, code, statusCode, retryable, details);
}

function mapErrorCode(statusCode: number, apiCode?: string): DentrixErrorCode {
  // Prefer Dentrix-specific codes when present
  if (apiCode) {
    const mapped = CODE_MAP[apiCode];
    if (mapped) return mapped;
  }

  // Fall back to HTTP status
  switch (statusCode) {
    case 401:
      return DentrixErrorCode.UNAUTHORIZED;
    case 403:
      return DentrixErrorCode.FORBIDDEN;
    case 404:
      return DentrixErrorCode.PATIENT_NOT_FOUND;
    case 409:
      return DentrixErrorCode.APPOINTMENT_CONFLICT;
    case 422:
      return DentrixErrorCode.VALIDATION_ERROR;
    case 429:
      return DentrixErrorCode.RATE_LIMITED;
    case 503:
      return DentrixErrorCode.SERVICE_UNAVAILABLE;
    default:
      return statusCode >= 500 ? DentrixErrorCode.INTERNAL_ERROR : DentrixErrorCode.UNKNOWN;
  }
}

/** Mapping from Dentrix API error code strings to our enum */
const CODE_MAP: Record<string, DentrixErrorCode> = {
  UNAUTHORIZED: DentrixErrorCode.UNAUTHORIZED,
  FORBIDDEN: DentrixErrorCode.FORBIDDEN,
  PATIENT_NOT_FOUND: DentrixErrorCode.PATIENT_NOT_FOUND,
  PROVIDER_NOT_FOUND: DentrixErrorCode.PROVIDER_NOT_FOUND,
  APPOINTMENT_NOT_FOUND: DentrixErrorCode.APPOINTMENT_NOT_FOUND,
  APPOINTMENT_CONFLICT: DentrixErrorCode.APPOINTMENT_CONFLICT,
  SLOT_UNAVAILABLE: DentrixErrorCode.SLOT_UNAVAILABLE,
  VALIDATION_ERROR: DentrixErrorCode.VALIDATION_ERROR,
  RATE_LIMITED: DentrixErrorCode.RATE_LIMITED,
  SERVICE_UNAVAILABLE: DentrixErrorCode.SERVICE_UNAVAILABLE,
  INTERNAL_ERROR: DentrixErrorCode.INTERNAL_ERROR,
};

export function networkError(cause: unknown): DentrixError {
  const message = cause instanceof Error ? cause.message : 'Network error';
  return new DentrixError(message, DentrixErrorCode.NETWORK_ERROR, null, true);
}
