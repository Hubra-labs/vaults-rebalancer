#!/bin/bash
# One-shot fee harvest for a Hubra Voltr vault.
# Calls the Voltr harvest_fee instruction — collects the manager management fee
# (as LP tokens) without touching strategy allocations. Funds stay put.
#
# Usage:
#   ./scripts/harvest-fee.sh usd1        # harvest one vault
#   ./scripts/harvest-fee.sh all         # harvest every vault
#   ./scripts/harvest-fee.sh --install-cron usd1   # add hourly cron for usd1
#
# Designed to be run hourly from cron (see --install-cron below).

set -euo pipefail

VALID_VAULTS="usdc usdt usds usdg usd1"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "Usage: $0 [--install-cron] <vault|all>"
  echo "  vaults: $VALID_VAULTS | all"
  exit 1
}

harvest_one() {
  local vault="$1"
  echo "💰 Harvesting fees for $vault..."
  cd "$DIR"
  # Prefer compiled output if present (prod), else fall back to ts-node (dev).
  if [ -f "$DIR/dist/scripts/harvest-fee.js" ]; then
    ENV_FILE=".env-${vault}" node "$DIR/dist/scripts/harvest-fee.js"
  else
    ENV_FILE=".env-${vault}" "$DIR/node_modules/.bin/ts-node" "$DIR/scripts/harvest-fee.ts"
  fi
}

INSTALL_CRON=0
if [ "${1:-}" = "--install-cron" ]; then
  INSTALL_CRON=1
  shift
fi

[ $# -eq 1 ] || usage
VAULT="$1"

if [ "$INSTALL_CRON" = "1" ]; then
  # Run at the top of every hour; log to /var/log so failures are inspectable.
  LINE="0 * * * * $DIR/scripts/harvest-fee.sh $VAULT >> /var/log/harvest-fee-$VAULT.log 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "harvest-fee.sh $VAULT"; echo "$LINE" ) | crontab -
  echo "✅ Installed hourly cron:"
  echo "   $LINE"
  exit 0
fi

if [ "$VAULT" = "all" ]; then
  for v in $VALID_VAULTS; do harvest_one "$v"; done
  echo "✅ Harvested all vaults"
  exit 0
fi

echo "$VALID_VAULTS" | grep -qw "$VAULT" || { echo "❌ Invalid vault: $VAULT"; usage; }
harvest_one "$VAULT"
echo "✅ Done: $VAULT"
