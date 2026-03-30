import { AlertRepository } from "../repositories/alertRepository";

declare global {
  namespace Express {
    interface Locals {
      auth: {
        userId:     string;
        customerId: string;
        email:      string | null;
      };
      alertRepo: AlertRepository;
    }
  }
}

export {};
