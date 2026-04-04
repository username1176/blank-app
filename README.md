# DentalAI

AI-powered automation system for dental practices. Integrates with Dentrix practice management, automates insurance verification, and provides AI phone agents for patient communication.

## Architecture

```
dentalai/
├── packages/
│   ├── core/          # Shared types, utilities, env config (zod-validated)
│   ├── dentrix/       # Dentrix API client — patient & appointment management
│   ├── insurance/     # Insurance verification engine via Availity
│   ├── voice-agent/   # AI phone agent orchestration (Bland AI + Twilio)
│   ├── api/           # Express REST API — main backend serving all routes
│   └── dashboard/     # React admin dashboard (Vite)
├── scripts/           # Dev utilities (setup, clean)
├── .env.example       # Required environment variables
├── tsconfig.json      # Root TypeScript config (strict mode)
├── .eslintrc.json     # Shared ESLint config
└── .prettierrc        # Shared Prettier config
```

## Package Dependency Graph

```
dashboard → api → voice-agent → dentrix → core
                 → insurance  →           → core
                 → dentrix    →           → core
```

## Getting Started

```bash
# 1. Clone and setup
./scripts/setup.sh

# 2. Fill in your credentials
cp .env.example .env
# Edit .env with your API keys

# 3. Install dependencies
npm install

# 4. Build all packages
npm run build

# 5. Start the API server
npm run dev

# 6. Start the dashboard (separate terminal)
npm run dev:dashboard
```

## Key Integrations

| Service | Purpose | Package |
|---------|---------|---------|
| **Dentrix** | Practice management system | `@dentalai/dentrix` |
| **Availity** | Insurance eligibility verification | `@dentalai/insurance` |
| **Bland AI** | AI-powered phone calls | `@dentalai/voice-agent` |
| **Twilio** | Telephony infrastructure | `@dentalai/voice-agent` |
| **Anthropic Claude** | AI reasoning & conversation | `@dentalai/voice-agent` |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build all packages |
| `npm run dev` | Start API server with hot reload |
| `npm run dev:dashboard` | Start dashboard dev server |
| `npm run lint` | Lint all packages |
| `npm run format` | Format all packages |
| `npm run typecheck` | Type-check all packages |
| `npm run clean` | Remove all build artifacts |

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict mode)
- **Monorepo**: npm workspaces
- **API**: Express
- **Frontend**: React + Vite
- **Validation**: Zod
- **Linting**: ESLint + Prettier
