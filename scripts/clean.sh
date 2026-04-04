#!/usr/bin/env bash
set -euo pipefail

echo "Cleaning all packages..."
npm run clean --workspaces --if-present
rm -rf node_modules
echo "Done."
