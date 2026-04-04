import { Appointment, AppointmentType, AppointmentStatus } from '@dentalai/core';

/** OAuth2 token response from Dentrix */
export interface DentrixTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/** DTO for creating an appointment */
export interface CreateAppointmentDto {
  patientId: string;
  providerId: string;
  dateTime: string;
  duration: number;
  type: AppointmentType;
  notes?: string;
}

/** DTO for updating an appointment */
export interface UpdateAppointmentDto {
  patientId?: string;
  providerId?: string;
  dateTime?: string;
  duration?: number;
  type?: AppointmentType;
  status?: AppointmentStatus;
  notes?: string;
}

/** Dentrix API error response body */
export interface DentrixApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Config required to initialize the Dentrix client */
export interface DentrixConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Token expiry buffer in ms — refresh this many ms before actual expiry. Default: 60000 (1 min) */
  tokenExpiryBufferMs?: number;
  /** Max retry attempts for failed requests. Default: 3 */
  maxRetries?: number;
}

/** Internal token storage */
export interface StoredToken {
  accessToken: string;
  expiresAt: number;
}
