/** Core shared types for DentalAI */

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phone: string;
  email?: string;
  insuranceId?: string;
  address?: Address;
  ssn?: string;
}

export interface Address {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface Provider {
  id: string;
  firstName: string;
  lastName: string;
  npi: string;
  specialty: string;
  phone?: string;
  email?: string;
}

export interface Appointment {
  id: string;
  patientId: string;
  providerId: string;
  dateTime: string;
  duration: number;
  type: AppointmentType;
  status: AppointmentStatus;
  notes?: string;
}

export type AppointmentType = 'cleaning' | 'exam' | 'filling' | 'crown' | 'rootCanal' | 'extraction' | 'consultation' | 'other';

export type AppointmentStatus = 'scheduled' | 'confirmed' | 'checked-in' | 'in-progress' | 'completed' | 'cancelled' | 'no-show';

export interface DateRange {
  start: string;
  end: string;
}

export interface TimeSlot {
  start: string;
  end: string;
  providerId: string;
  available: boolean;
}

export interface InsuranceInfo {
  payerId: string;
  memberId: string;
  groupNumber: string;
  planName: string;
  subscriberName: string;
  relationship: 'self' | 'spouse' | 'child' | 'other';
}

export interface VerificationResult {
  eligible: boolean;
  planStatus: string;
  coverageDetails: CoverageDetail[];
  copay?: number;
  deductible?: number;
  deductibleMet?: number;
  annualMax?: number;
  annualUsed?: number;
  verifiedAt: string;
}

export interface CoverageDetail {
  category: string;
  coveragePercent: number;
  limitations?: string;
  waitingPeriod?: string;
}

export interface CallRecord {
  id: string;
  patientId: string;
  direction: 'inbound' | 'outbound';
  purpose: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed';
  transcript?: string;
  duration?: number;
  createdAt: string;
}
