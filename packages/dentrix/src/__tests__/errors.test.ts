import { DentrixError, DentrixErrorCode, mapApiError, networkError } from '../errors';

describe('mapApiError', () => {
  it('should map PATIENT_NOT_FOUND from API code', () => {
    const err = mapApiError(404, 'PATIENT_NOT_FOUND', 'Patient not found');
    expect(err).toBeInstanceOf(DentrixError);
    expect(err.code).toBe(DentrixErrorCode.PATIENT_NOT_FOUND);
    expect(err.statusCode).toBe(404);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Patient not found');
  });

  it('should map APPOINTMENT_CONFLICT from API code', () => {
    const err = mapApiError(409, 'APPOINTMENT_CONFLICT', 'Slot taken');
    expect(err.code).toBe(DentrixErrorCode.APPOINTMENT_CONFLICT);
    expect(err.retryable).toBe(false);
  });

  it('should mark 429 as retryable', () => {
    const err = mapApiError(429, 'RATE_LIMITED', 'Too many requests');
    expect(err.code).toBe(DentrixErrorCode.RATE_LIMITED);
    expect(err.retryable).toBe(true);
  });

  it('should mark 500 as retryable', () => {
    const err = mapApiError(500, undefined, undefined);
    expect(err.code).toBe(DentrixErrorCode.INTERNAL_ERROR);
    expect(err.retryable).toBe(true);
  });

  it('should mark 503 as retryable', () => {
    const err = mapApiError(503, 'SERVICE_UNAVAILABLE', 'Maintenance');
    expect(err.code).toBe(DentrixErrorCode.SERVICE_UNAVAILABLE);
    expect(err.retryable).toBe(true);
  });

  it('should fall back to HTTP status when API code is unknown', () => {
    const err = mapApiError(401, undefined, 'Auth failed');
    expect(err.code).toBe(DentrixErrorCode.UNAUTHORIZED);
  });

  it('should fall back to UNKNOWN for unrecognized 4xx', () => {
    const err = mapApiError(418, undefined, "I'm a teapot");
    expect(err.code).toBe(DentrixErrorCode.UNKNOWN);
    expect(err.retryable).toBe(false);
  });

  it('should include details when provided', () => {
    const details = { field: 'dateTime', reason: 'must be in the future' };
    const err = mapApiError(422, 'VALIDATION_ERROR', 'Invalid', details);
    expect(err.details).toEqual(details);
  });
});

describe('networkError', () => {
  it('should create a retryable NETWORK_ERROR from an Error', () => {
    const err = networkError(new Error('ECONNREFUSED'));
    expect(err.code).toBe(DentrixErrorCode.NETWORK_ERROR);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBeNull();
    expect(err.message).toBe('ECONNREFUSED');
  });

  it('should handle non-Error causes', () => {
    const err = networkError('timeout');
    expect(err.code).toBe(DentrixErrorCode.NETWORK_ERROR);
    expect(err.message).toBe('Network error');
  });
});

describe('DentrixError', () => {
  it('should have the correct name', () => {
    const err = new DentrixError('test', DentrixErrorCode.UNKNOWN, 500, false);
    expect(err.name).toBe('DentrixError');
    expect(err).toBeInstanceOf(Error);
  });
});
