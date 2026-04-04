import axios, { AxiosInstance } from 'axios';
import { Patient, Appointment, createLogger } from '@dentalai/core';

const log = createLogger('dentrix');

export interface DentrixConfig {
  apiKey: string;
  baseUrl: string;
}

export class DentrixClient {
  private http: AxiosInstance;

  constructor(config: DentrixConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    log.info('Dentrix client initialized');
  }

  async getPatient(patientId: string): Promise<Patient> {
    const { data } = await this.http.get<Patient>(`/patients/${patientId}`);
    return data;
  }

  async searchPatients(query: string): Promise<Patient[]> {
    const { data } = await this.http.get<Patient[]>('/patients/search', { params: { q: query } });
    return data;
  }

  async getAppointments(patientId: string): Promise<Appointment[]> {
    const { data } = await this.http.get<Appointment[]>(`/patients/${patientId}/appointments`);
    return data;
  }

  async createAppointment(appointment: Omit<Appointment, 'id'>): Promise<Appointment> {
    const { data } = await this.http.post<Appointment>('/appointments', appointment);
    return data;
  }

  async updateAppointmentStatus(appointmentId: string, status: Appointment['status']): Promise<Appointment> {
    const { data } = await this.http.patch<Appointment>(`/appointments/${appointmentId}`, { status });
    return data;
  }
}
