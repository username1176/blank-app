#!/usr/bin/env bash
set -euo pipefail

echo "Setting up DentalAI monorepo..."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — fill in your credentials."
else
  echo ".env already exists, skipping."
fi

echo "Installing dependencies..."
npm install

echo "Building packages..."
npm run build

echo "Setup complete!"
