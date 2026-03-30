import { SensorReadingRepository } from "../repositories/sensorReadingRepository";
import { AnomalyRepository } from "../repositories/anomalyRepository";
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
      anomalyRepo:     AnomalyRepository | null;
      anomalyDetector: AnomalyDetector | null;
    }
  }
}

export {};
