import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import {
  Patient,
  Appointment,
  InsuranceInfo,
  Provider,
  DateRange,
  TimeSlot,
  sleep,
} from '@dentalai/core';
import {
  DentrixConfig,
  DentrixTokenResponse,
  StoredToken,
  CreateAppointmentDto,
  UpdateAppointmentDto,
  DentrixApiErrorBody,
} from './types.js';
import { DentrixError, DentrixErrorCode, mapApiError, networkError } from './errors.js';
import { logRequest, logResponse, logRetry, logError } from './logger.js';

const DEFAULT_TOKEN_BUFFER_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

export class DentrixClient {
  private http: AxiosInstance;
  private token: StoredToken | null = null;
  private tokenPromise: Promise<void> | null = null;
  private readonly maxRetries: number;
  private readonly tokenExpiryBufferMs: number;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(private readonly config: DentrixConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.tokenExpiryBufferMs = config.tokenExpiryBufferMs ?? DEFAULT_TOKEN_BUFFER_MS;

    this.http = axios.create({
      baseURL: config.baseUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
  }

  // ── Authentication ──────────────────────────────────────────────────

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - this.tokenExpiryBufferMs) {
      return this.token.accessToken;
    }

    // Deduplicate concurrent refresh calls
    if (!this.tokenPromise) {
      this.tokenPromise = this.refreshToken();
    }

    try {
      await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }

    return this.token!.accessToken;
  }

  private async refreshToken(): Promise<void> {
    try {
      const { data } = await axios.post<DentrixTokenResponse>(
        `${this.config.baseUrl}/oauth/token`,
        {
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 },
      );

      this.token = {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
    } catch (err) {
      this.token = null;
      logError('Token refresh failed', err);
      throw new DentrixError(
        'Failed to authenticate with Dentrix',
        DentrixErrorCode.TOKEN_REFRESH_FAILED,
        null,
        false,
      );
    }
  }

  // ── HTTP with retry ─────────────────────────────────────────────────

  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    let lastError: DentrixError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const accessToken = await this.ensureToken();

        const reqConfig: AxiosRequestConfig = {
          ...config,
          headers: {
            ...config.headers,
            Authorization: `Bearer ${accessToken}`,
          },
        };

        logRequest(config.method ?? 'GET', config.url ?? '', config.data);

        const response = await this.http.request<T>(reqConfig);

        logResponse(config.method ?? 'GET', config.url ?? '', response.status, response.data);

        return response.data;
      } catch (err) {
        lastError = this.toError(err);

        // If unauthorized, clear token so next attempt re-authenticates
        if (lastError.code === DentrixErrorCode.UNAUTHORIZED) {
          this.token = null;
        }

        if (!lastError.retryable || attempt === this.maxRetries) {
          break;
        }

        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        logRetry(attempt + 1, this.maxRetries, delay, lastError.message);
        await sleep(delay);
      }
    }

    throw lastError!;
  }

  private toError(err: unknown): DentrixError {
    if (err instanceof DentrixError) return err;

    if (err instanceof AxiosError) {
      if (!err.response) {
        return networkError(err);
      }

      const body = err.response.data as DentrixApiErrorBody | undefined;
      return mapApiError(
        err.response.status,
        body?.error?.code,
        body?.error?.message,
        body?.error?.details,
      );
    }

    return networkError(err);
  }

  // ── Patients ────────────────────────────────────────────────────────

  async getPatient(patientId: string): Promise<Patient> {
    return this.request<Patient>({
      method: 'GET',
      url: `/patients/${patientId}`,
    });
  }

  async searchPatients(query: string): Promise<Patient[]> {
    return this.request<Patient[]>({
      method: 'GET',
      url: '/patients/search',
      params: { q: query },
    });
  }

  async getPatientInsurance(patientId: string): Promise<InsuranceInfo[]> {
    return this.request<InsuranceInfo[]>({
      method: 'GET',
      url: `/patients/${patientId}/insurance`,
    });
  }

  // ── Appointments ────────────────────────────────────────────────────

  async getAppointments(dateRange: DateRange, providerId?: string): Promise<Appointment[]> {
    return this.request<Appointment[]>({
      method: 'GET',
      url: '/appointments',
      params: {
        start: dateRange.start,
        end: dateRange.end,
        ...(providerId ? { providerId } : {}),
      },
    });
  }

  async createAppointment(data: CreateAppointmentDto): Promise<Appointment> {
    return this.request<Appointment>({
      method: 'POST',
      url: '/appointments',
      data,
    });
  }

  async updateAppointment(id: string, data: UpdateAppointmentDto): Promise<Appointment> {
    return this.request<Appointment>({
      method: 'PATCH',
      url: `/appointments/${id}`,
      data,
    });
  }

  async getAvailableSlots(
    providerId: string,
    dateRange: DateRange,
    duration: number,
  ): Promise<TimeSlot[]> {
    return this.request<TimeSlot[]>({
      method: 'GET',
      url: `/providers/${providerId}/slots`,
      params: {
        start: dateRange.start,
        end: dateRange.end,
        duration,
      },
    });
  }

  // ── Providers ───────────────────────────────────────────────────────

  async getProvider(providerId: string): Promise<Provider> {
    return this.request<Provider>({
      method: 'GET',
      url: `/providers/${providerId}`,
    });
  }

  async listProviders(): Promise<Provider[]> {
    return this.request<Provider[]>({
      method: 'GET',
      url: '/providers',
    });
  }
}
