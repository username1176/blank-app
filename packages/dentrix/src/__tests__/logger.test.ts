import { redactPhi } from '../logger';

describe('redactPhi', () => {
  it('should redact top-level PHI fields', () => {
    const input = {
      id: 'pat-001',
      firstName: 'John',
      lastName: 'Doe',
      dateOfBirth: '1990-01-15',
      phone: '555-123-4567',
      email: 'john@example.com',
      ssn: '123-45-6789',
    };

    const result = redactPhi(input) as Record<string, unknown>;

    expect(result.id).toBe('pat-001');
    expect(result.firstName).toBe('[REDACTED]');
    expect(result.lastName).toBe('[REDACTED]');
    expect(result.dateOfBirth).toBe('[REDACTED]');
    expect(result.phone).toBe('[REDACTED]');
    expect(result.email).toBe('[REDACTED]');
    expect(result.ssn).toBe('[REDACTED]');
  });

  it('should redact nested PHI fields', () => {
    const input = {
      patient: {
        id: 'pat-001',
        firstName: 'John',
        lastName: 'Doe',
      },
    };

    const result = redactPhi(input) as Record<string, Record<string, unknown>>;

    expect(result.patient.id).toBe('pat-001');
    expect(result.patient.firstName).toBe('[REDACTED]');
    expect(result.patient.lastName).toBe('[REDACTED]');
  });

  it('should redact PHI in arrays', () => {
    const input = [
      { id: '1', firstName: 'John' },
      { id: '2', firstName: 'Jane' },
    ];

    const result = redactPhi(input) as Array<Record<string, unknown>>;

    expect(result[0].id).toBe('1');
    expect(result[0].firstName).toBe('[REDACTED]');
    expect(result[1].firstName).toBe('[REDACTED]');
  });

  it('should redact insurance PHI fields', () => {
    const input = {
      payerId: 'INS-001',
      memberId: 'MEM-123',
      groupNumber: 'GRP-456',
      subscriberName: 'John Doe',
      planName: 'Delta Dental',
    };

    const result = redactPhi(input) as Record<string, unknown>;

    expect(result.payerId).toBe('INS-001');
    expect(result.memberId).toBe('[REDACTED]');
    expect(result.groupNumber).toBe('[REDACTED]');
    expect(result.subscriberName).toBe('[REDACTED]');
    expect(result.planName).toBe('Delta Dental');
  });

  it('should handle null and undefined', () => {
    expect(redactPhi(null)).toBeNull();
    expect(redactPhi(undefined)).toBeUndefined();
  });

  it('should handle primitives', () => {
    expect(redactPhi('hello')).toBe('hello');
    expect(redactPhi(42)).toBe(42);
    expect(redactPhi(true)).toBe(true);
  });

  it('should not mutate the original object', () => {
    const input = { id: 'pat-001', firstName: 'John' };
    redactPhi(input);
    expect(input.firstName).toBe('John');
  });

  it('should redact address fields', () => {
    const input = {
      id: 'pat-001',
      address: {
        street: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        zip: '62701',
      },
    };

    const result = redactPhi(input) as Record<string, unknown>;
    expect(result.address).toBe('[REDACTED]');
  });
});
