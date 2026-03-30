import { AlertRepository } from "../repositories/alertRepository";
import { NotificationPreferenceRepository } from "../repositories/notificationPreferenceRepository";
import { AlertThresholdRepository } from "../repositories/alertThresholdRepository";

declare global {
  namespace Express {
    interface Locals {
      auth: {
        userId:     string;
        customerId: string;
        email:      string | null;
      };
      alertRepo:      AlertRepository;
      preferenceRepo: NotificationPreferenceRepository;
      thresholdRepo:  AlertThresholdRepository;
    }
  }
}

export {};
