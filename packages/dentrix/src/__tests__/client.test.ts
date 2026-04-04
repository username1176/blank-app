import axios, { AxiosError } from 'axios';
import { DentrixClient } from '../client';
import { DentrixError, DentrixErrorCode } from '../errors';
import type { DentrixConfig } from '../types';

// Partial mock: preserve AxiosError and isAxiosError so instanceof works
jest.mock('axios', () => {
  const actual = jest.requireActual<typeof import('axios')>('axios');
  return {
    ...actual,
    default: {
      ...actual.default,
      create: jest.fn(),
      post: jest.fn(),
    },
    create: jest.fn(),
    post: jest.fn(),
  };
});
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Shared fixtures
const CONFIG: DentrixConfig = {
  baseUrl: 'https://api.dentrix.example.com',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenExpiryBufferMs: 1000,
  maxRetries: 2,
};

const TOKEN_RESPONSE = {
  data: {
    access_token: 'test-access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'read write',
  },
};

const PATIENT = {
  id: 'pat-001',
  firstName: 'John',
  lastName: 'Doe',
  dateOfBirth: '1990-01-15',
  phone: '555-123-4567',
  email: 'john@example.com',
};

const PROVIDER = {
  id: 'prov-001',
  firstName: 'Jane',
  lastName: 'Smith',
  npi: '1234567890',
  specialty: 'General Dentistry',
};

const APPOINTMENT = {
  id: 'appt-001',
  patientId: 'pat-001',
  providerId: 'prov-001',
  dateTime: '2025-06-15T09:00:00Z',
  duration: 60,
  type: 'cleaning' as const,
  status: 'scheduled' as const,
};

// Helper to set up the mock axios instance
function setupMocks() {
  const mockInstance = {
    request: jest.fn(),
    defaults: { headers: { common: {} } },
  };

  mockedAxios.create.mockReturnValue(mockInstance as unknown as ReturnType<typeof axios.create>);
  // Token endpoint uses axios.post directly
  mockedAxios.post.mockResolvedValue(TOKEN_RESPONSE);

  return mockInstance;
}

describe('DentrixClient', () => {
  let client: DentrixClient;
  let mockHttp: ReturnType<typeof setupMocks>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHttp = setupMocks();
    client = new DentrixClient(CONFIG);
  });

  // ── Authentication ────────────────────────────────────────────────

  describe('authentication', () => {
    it('should fetch a token on the first request', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: PATIENT, status: 200 });

      await client.getPatient('pat-001');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.dentrix.example.com/oauth/token',
        {
          grant_type: 'client_credentials',
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
        },
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
      );
    });

    it('should reuse a valid token across requests', async () => {
      mockHttp.request
        .mockResolvedValueOnce({ data: PATIENT, status: 200 })
        .mockResolvedValueOnce({ data: [PATIENT], status: 200 });

      await client.getPatient('pat-001');
      await client.searchPatients('Doe');

      // Token fetched only once
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('should throw TOKEN_REFRESH_FAILED when auth fails', async () => {
      mockedAxios.post.mockRejectedValue(new Error('auth server down'));

      try {
        await client.getPatient('pat-001');
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DentrixError);
        expect((err as DentrixError).code).toBe(DentrixErrorCode.TOKEN_REFRESH_FAILED);
      }
    });

    it('should set Authorization header with the fetched token', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: PATIENT, status: 200 });

      await client.getPatient('pat-001');

      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-access-token',
          }),
        }),
      );
    });
  });

  // ── Patients ──────────────────────────────────────────────────────

  describe('getPatient', () => {
    it('should return a patient by ID', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: PATIENT, status: 200 });

      const result = await client.getPatient('pat-001');

      expect(result).toEqual(PATIENT);
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/patients/pat-001' }),
      );
    });
  });

  describe('searchPatients', () => {
    it('should search patients by query', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: [PATIENT], status: 200 });

      const results = await client.searchPatients('Doe');

      expect(results).toEqual([PATIENT]);
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: '/patients/search',
          params: { q: 'Doe' },
        }),
      );
    });
  });

  describe('getPatientInsurance', () => {
    it('should return insurance info for a patient', async () => {
      const insurance = [
        {
          payerId: 'INS-001',
          memberId: 'MEM-123',
          groupNumber: 'GRP-456',
          planName: 'Delta Dental PPO',
          subscriberName: 'John Doe',
          relationship: 'self',
        },
      ];
      mockHttp.request.mockResolvedValueOnce({ data: insurance, status: 200 });

      const result = await client.getPatientInsurance('pat-001');

      expect(result).toEqual(insurance);
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/patients/pat-001/insurance' }),
      );
    });
  });

  // ── Appointments ──────────────────────────────────────────────────

  describe('getAppointments', () => {
    it('should fetch appointments for a date range', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: [APPOINTMENT], status: 200 });

      const result = await client.getAppointments({
        start: '2025-06-15',
        end: '2025-06-16',
      });

      expect(result).toEqual([APPOINTMENT]);
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: '/appointments',
          params: { start: '2025-06-15', end: '2025-06-16' },
        }),
      );
    });

    it('should include providerId when specified', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: [APPOINTMENT], status: 200 });

      await client.getAppointments({ start: '2025-06-15', end: '2025-06-16' }, 'prov-001');

      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { start: '2025-06-15', end: '2025-06-16', providerId: 'prov-001' },
        }),
      );
    });
  });

  describe('createAppointment', () => {
    it('should create an appointment', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: APPOINTMENT, status: 201 });

      const dto = {
        patientId: 'pat-001',
        providerId: 'prov-001',
        dateTime: '2025-06-15T09:00:00Z',
        duration: 60,
        type: 'cleaning' as const,
      };

      const result = await client.createAppointment(dto);

      expect(result).toEqual(APPOINTMENT);
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', url: '/appointments', data: dto }),
      );
    });
  });

  describe('updateAppointment', () => {
    it('should update an appointment', async () => {
      const updated = { ...APPOINTMENT, status: 'confirmed' as const };
      mockHttp.request.mockResolvedValueOnce({ data: updated, status: 200 });

      const result = await client.updateAppointment('appt-001', { status: 'confirmed' });

      expect(result.status).toBe('confirmed');
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          url: '/appointments/appt-001',
          data: { status: 'confirmed' },
        }),
      );
    });
  });

  describe('getAvailableSlots', () => {
    it('should return available slots', async () => {
      const slots = [
        { start: '2025-06-15T09:00:00Z', end: '2025-06-15T10:00:00Z', providerId: 'prov-001', available: true },
        { start: '2025-06-15T10:00:00Z', end: '2025-06-15T11:00:00Z', providerId: 'prov-001', available: true },
      ];
      mockHttp.request.mockResolvedValueOnce({ data: slots, status: 200 });

      const result = await client.getAvailableSlots(
        'prov-001',
        { start: '2025-06-15', end: '2025-06-16' },
        60,
      );

      expect(result).toEqual(slots);
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: '/providers/prov-001/slots',
          params: { start: '2025-06-15', end: '2025-06-16', duration: 60 },
        }),
      );
    });
  });

  // ── Providers ─────────────────────────────────────────────────────

  describe('getProvider', () => {
    it('should return a provider by ID', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: PROVIDER, status: 200 });

      const result = await client.getProvider('prov-001');

      expect(result).toEqual(PROVIDER);
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/providers/prov-001' }),
      );
    });
  });

  describe('listProviders', () => {
    it('should return all providers', async () => {
      mockHttp.request.mockResolvedValueOnce({ data: [PROVIDER], status: 200 });

      const result = await client.listProviders();

      expect(result).toEqual([PROVIDER]);
      expect(mockHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/providers' }),
      );
    });
  });

  // ── Error Handling ────────────────────────────────────────────────

  describe('error handling', () => {
    it('should throw typed DentrixError on 404', async () => {
      const axiosError = new AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: { error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found' } },
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockHttp.request.mockRejectedValueOnce(axiosError);

      try {
        await client.getPatient('nonexistent');
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DentrixError);
        const dentrixErr = err as DentrixError;
        expect(dentrixErr.code).toBe(DentrixErrorCode.PATIENT_NOT_FOUND);
        expect(dentrixErr.statusCode).toBe(404);
        expect(dentrixErr.retryable).toBe(false);
      }
    });

    it('should throw APPOINTMENT_CONFLICT on 409', async () => {
      const axiosError = new AxiosError('Conflict', '409', undefined, undefined, {
        status: 409,
        data: { error: { code: 'APPOINTMENT_CONFLICT', message: 'Slot already booked' } },
        statusText: 'Conflict',
        headers: {},
        config: {} as never,
      });
      mockHttp.request.mockRejectedValueOnce(axiosError);

      try {
        await client.createAppointment({
          patientId: 'pat-001',
          providerId: 'prov-001',
          dateTime: '2025-06-15T09:00:00Z',
          duration: 60,
          type: 'cleaning',
        });
        fail('Should have thrown');
      } catch (err) {
        const dentrixErr = err as DentrixError;
        expect(dentrixErr.code).toBe(DentrixErrorCode.APPOINTMENT_CONFLICT);
        expect(dentrixErr.retryable).toBe(false);
      }
    });

    it('should throw RATE_LIMITED on 429', async () => {
      const axiosError = new AxiosError('Too many requests', '429', undefined, undefined, {
        status: 429,
        data: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
        statusText: 'Too Many Requests',
        headers: {},
        config: {} as never,
      });
      // The error is retryable, so it will be retried maxRetries times (2), total 3 attempts
      mockHttp.request
        .mockRejectedValueOnce(axiosError)
        .mockRejectedValueOnce(axiosError)
        .mockRejectedValueOnce(axiosError);

      try {
        await client.searchPatients('test');
        fail('Should have thrown');
      } catch (err) {
        const dentrixErr = err as DentrixError;
        expect(dentrixErr.code).toBe(DentrixErrorCode.RATE_LIMITED);
        expect(dentrixErr.retryable).toBe(true);
        // initial attempt + 2 retries = 3
        expect(mockHttp.request).toHaveBeenCalledTimes(3);
      }
    });

    it('should throw NETWORK_ERROR when no response', async () => {
      const axiosError = new AxiosError('Network Error', 'ERR_NETWORK');
      // Network errors are retryable
      mockHttp.request
        .mockRejectedValueOnce(axiosError)
        .mockRejectedValueOnce(axiosError)
        .mockRejectedValueOnce(axiosError);

      try {
        await client.getPatient('pat-001');
        fail('Should have thrown');
      } catch (err) {
        const dentrixErr = err as DentrixError;
        expect(dentrixErr.code).toBe(DentrixErrorCode.NETWORK_ERROR);
        expect(dentrixErr.retryable).toBe(true);
      }
    });
  });

  // ── Retry Logic ───────────────────────────────────────────────────

  describe('retry logic', () => {
    it('should retry on 500 and succeed', async () => {
      const serverError = new AxiosError('Server error', '500', undefined, undefined, {
        status: 500,
        data: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
        statusText: 'Internal Server Error',
        headers: {},
        config: {} as never,
      });

      mockHttp.request
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({ data: PATIENT, status: 200 });

      const result = await client.getPatient('pat-001');

      expect(result).toEqual(PATIENT);
      expect(mockHttp.request).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non-retryable errors (422)', async () => {
      const validationError = new AxiosError('Validation', '422', undefined, undefined, {
        status: 422,
        data: { error: { code: 'VALIDATION_ERROR', message: 'Invalid data' } },
        statusText: 'Unprocessable Entity',
        headers: {},
        config: {} as never,
      });

      mockHttp.request.mockRejectedValueOnce(validationError);

      try {
        await client.createAppointment({
          patientId: '',
          providerId: '',
          dateTime: '',
          duration: -1,
          type: 'cleaning',
        });
        fail('Should have thrown');
      } catch (err) {
        expect((err as DentrixError).code).toBe(DentrixErrorCode.VALIDATION_ERROR);
        // Only 1 attempt — no retries
        expect(mockHttp.request).toHaveBeenCalledTimes(1);
      }
    });

    it('should clear token and retry on 401', async () => {
      const unauthorizedError = new AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: { error: { code: 'UNAUTHORIZED', message: 'Token expired' } },
        statusText: 'Unauthorized',
        headers: {},
        config: {} as never,
      });

      // First call: 401. Token cleared, re-auth, second call succeeds.
      mockHttp.request
        .mockRejectedValueOnce(unauthorizedError)
        .mockResolvedValueOnce({ data: PATIENT, status: 200 });

      const result = await client.getPatient('pat-001');

      expect(result).toEqual(PATIENT);
      // 2 token fetches (initial + after 401)
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      expect(mockHttp.request).toHaveBeenCalledTimes(2);
    });
  });
});
