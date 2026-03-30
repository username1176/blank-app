import { SensorReadingRepository } from "../repositories/sensorReadingRepository";

declare global {
  namespace Express {
    interface Locals {
      auth: {
        userId:     string;
        customerId: string;
        email:      string | null;
      };
      sensorRepo: SensorReadingRepository;
    }
  }
}

export {};
