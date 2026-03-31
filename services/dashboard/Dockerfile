# ── Build stage: compile the Vite/React application ───────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json        ./
COPY vite.config.ts        ./
COPY tailwind.config.js    ./
COPY postcss.config.js     ./
COPY index.html            ./
COPY src/                  ./src/
# public/ is optional — copy only if it exists
COPY public/               ./public/

# Vite embeds these at build time, so they must be set as ARGs/ENVs here.
# Pass real values with --build-arg or via the compose `build.args` section.
ARG VITE_API_URL=http://localhost:3000
ARG VITE_MAPBOX_TOKEN=

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN

RUN npm run build

# ── Runtime stage: serve compiled assets with Nginx ───────────────────────────
FROM nginx:1.27-alpine AS runner

# Replace the default catch-all config with our SPA + proxy config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the compiled React app
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost/health || exit 1
