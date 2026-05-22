#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "=== oliverdougherty.com setup ==="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}ERROR: Node.js is not installed.${NC}"
  echo "Install Node 22+ from https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v 2>/dev/null || echo "unknown")
echo "Node.js: $NODE_VERSION"

MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [ "$MAJOR" -lt 22 ] 2>/dev/null; then
  echo -e "${YELLOW}WARNING: Node v$MAJOR detected. CI requires Node 22+.${NC}"
fi

# Check npm
if ! command -v npm &>/dev/null; then
  echo -e "${RED}ERROR: npm is not installed.${NC}"
  exit 1
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install
echo -e "${GREEN}Dependencies installed.${NC}"

# Build utilities
echo ""
echo "Building utilities bundle..."
npm run utilities:build
echo -e "${GREEN}Utilities built.${NC}"

# Run quality checks (non-fatal)
echo ""
echo "Running quality checks..."
if npm run quality; then
  echo -e "${GREEN}All quality checks passed.${NC}"
else
  echo -e "${YELLOW}WARNING: Some quality checks failed. Review output above.${NC}"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Start local dev server:"
echo "  npx serve -l 3000"
echo ""
echo "Then open: http://localhost:3000"
echo ""
