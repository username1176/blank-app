import axios, { AxiosInstance } from 'axios';
import { InsuranceInfo, VerificationResult, createLogger } from '@dentalai/core';

const log = createLogger('insurance');

export interface AvailityConfig {
  clientId: string;
  clientSecret: string;
}

export class InsuranceVerifier {
  private http: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private config: AvailityConfig) {
    this.http = axios.create({
      baseURL: 'https://api.availity.com/availity/v1',
      headers: { 'Content-Type': 'application/json' },
    });
    log.info('Insurance verifier initialized');
  }

  private async authenticate(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) return;

    const { data } = await this.http.post('/token', {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'client_credentials',
    });

    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    log.info('Authenticated with Availity');
  }

  async verifyEligibility(insurance: InsuranceInfo): Promise<VerificationResult> {
    await this.authenticate();

    log.info(`Verifying eligibility for member ${insurance.memberId}`);

    const { data } = await this.http.post(
      '/eligibility',
      {
        payerId: insurance.payerId,
        memberId: insurance.memberId,
        groupNumber: insurance.groupNumber,
        subscriberName: insurance.subscriberName,
        serviceType: 'dental',
      },
      { headers: { Authorization: `Bearer ${this.token}` } },
    );

    return {
      eligible: data.eligible,
      planStatus: data.planStatus,
      coverageDetails: data.coverageDetails ?? [],
      copay: data.copay,
      deductible: data.deductible,
      deductibleMet: data.deductibleMet,
      annualMax: data.annualMax,
      annualUsed: data.annualUsed,
      verifiedAt: new Date().toISOString(),
    };
  }
}
