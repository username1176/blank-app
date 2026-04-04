import axios, { AxiosInstance } from 'axios';
import { CallRecord, createLogger } from '@dentalai/core';

const log = createLogger('voice-agent');

export interface VoiceAgentConfig {
  blandAiKey: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  anthropicApiKey: string;
}

export class VoiceAgent {
  private blandHttp: AxiosInstance;

  constructor(private config: VoiceAgentConfig) {
    this.blandHttp = axios.create({
      baseURL: 'https://api.bland.ai/v1',
      headers: {
        Authorization: config.blandAiKey,
        'Content-Type': 'application/json',
      },
    });
    log.info('Voice agent initialized');
  }

  async initiateCall(phoneNumber: string, purpose: string): Promise<CallRecord> {
    log.info(`Initiating call to ${phoneNumber} for: ${purpose}`);

    const { data } = await this.blandHttp.post('/calls', {
      phone_number: phoneNumber,
      task: purpose,
      model: 'enhanced',
      language: 'en',
    });

    return {
      id: data.call_id,
      patientId: '',
      direction: 'outbound',
      purpose,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
  }

  async getCallStatus(callId: string): Promise<CallRecord> {
    const { data } = await this.blandHttp.get(`/calls/${callId}`);

    return {
      id: callId,
      patientId: '',
      direction: data.direction ?? 'outbound',
      purpose: data.task ?? '',
      status: data.status,
      transcript: data.transcript,
      duration: data.duration,
      createdAt: data.created_at,
    };
  }
}
