import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createLogger } from '@dentalai/core';

const log = createLogger('api');
const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/v1/patients/:id', async (_req, res) => {
  // TODO: Implement with DentrixClient
  res.json({ message: 'Patient endpoint placeholder' });
});

app.post('/api/v1/insurance/verify', async (_req, res) => {
  // TODO: Implement with InsuranceVerifier
  res.json({ message: 'Insurance verification placeholder' });
});

app.post('/api/v1/calls', async (_req, res) => {
  // TODO: Implement with VoiceAgent
  res.json({ message: 'Voice call placeholder' });
});

app.listen(PORT, () => {
  log.info(`DentalAI API running on port ${PORT}`);
});

export default app;
