import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  DENTRIX_API_KEY: z.string().min(1),
  DENTRIX_BASE_URL: z.string().url(),
  BLAND_AI_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  AVAILITY_CLIENT_ID: z.string().min(1),
  AVAILITY_CLIENT_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(): EnvConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Missing or invalid environment variables');
  }
  return parsed.data;
}
