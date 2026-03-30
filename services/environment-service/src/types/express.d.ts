import { SensorReadingRepository } from "../repositories/sensorReadingRepository";
import { AnomalyDetector } from "../anomaly/detector";

declare global {
  namespace Express {
    interface Locals {
      auth: {
        userId:     string;
        customerId: string;
        email:      string | null;
      };
      sensorRepo:      SensorReadingRepository;
      anomalyDetector: AnomalyDetector | null;
    }
  }
}

export {};
