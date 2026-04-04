export { DentrixClient } from './client.js';
export { DentrixError, DentrixErrorCode, mapApiError } from './errors.js';
export { redactPhi } from './logger.js';
export type {
  DentrixConfig,
  CreateAppointmentDto,
  UpdateAppointmentDto,
  DentrixTokenResponse,
  DentrixApiErrorBody,
} from './types.js';
