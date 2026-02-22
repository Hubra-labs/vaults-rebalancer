#!/bin/bash
# Manual rebalance trigger for Hubra vaults
# Usage: ./scripts/rebalance.sh <vault>
# Example: ./scripts/rebalance.sh usdc
#          ./scripts/rebalance.sh all

set -e

VALID_VAULTS="usdc usdt usds usdg usd1"

usage() {
  echo "Usage: $0 <vault>"
  echo ""
  echo "Vaults: $VALID_VAULTS"
  echo "        all - rebalance all vaults"
  echo ""
  echo "Examples:"
  echo "  $0 usdc     # Rebalance USDC vault"
  echo "  $0 all      # Rebalance all vaults"
  exit 1
}

rebalance_vault() {
  local vault=$1
  echo "🔄 Triggering rebalance for $vault..."
  sudo systemctl restart "vaults-rebalancer@${vault}"
  sleep 3
  echo "📋 Recent logs for $vault:"
  sudo journalctl -u "vaults-rebalancer@${vault}" --no-pager -n 20 --since "10 seconds ago" | grep -E "winner|Winner|rebalance|Rebalance|ERROR|confirmed" || true
  echo ""
}

# Check argument
if [ -z "$1" ]; then
  usage
fi

VAULT="$1"

# Handle 'all' case
if [ "$VAULT" = "all" ]; then
  for v in $VALID_VAULTS; do
    rebalance_vault "$v"
  done
  echo "✅ All vaults rebalanced"
  exit 0
fi

# Validate vault name
if ! echo "$VALID_VAULTS" | grep -qw "$VAULT"; then
  echo "❌ Invalid vault: $VAULT"
  echo "Valid vaults: $VALID_VAULTS"
  exit 1
fi

# Rebalance single vault
rebalance_vault "$VAULT"
echo "✅ Rebalance triggered for $VAULT"
