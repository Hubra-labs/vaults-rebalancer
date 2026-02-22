#!/bin/bash
# Check rebalancer wallet balance and alert if below threshold
# Uses VOLTR_VAULT_MANAGER_ADDRESS from environment

WALLET="${VOLTR_VAULT_MANAGER_ADDRESS:-}"

if [ -z "$WALLET" ]; then
  echo "ERROR: VOLTR_VAULT_MANAGER_ADDRESS not set"
  exit 1
fi
THRESHOLD=0.1
RPC_URL="https://api.mainnet-beta.solana.com"

# Get balance in lamports, convert to SOL
BALANCE=$(curl -s "$RPC_URL" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$WALLET\"]}" \
  | jq -r '.result.value / 1000000000')

if [ -z "$BALANCE" ] || [ "$BALANCE" = "null" ]; then
  echo "ERROR: Failed to fetch balance"
  exit 1
fi

# Compare balance to threshold using awk
IS_LOW=$(awk "BEGIN {print ($BALANCE < $THRESHOLD) ? 1 : 0}")

if [ "$IS_LOW" -eq 1 ]; then
  echo "⚠️ LOW BALANCE ALERT"
  echo "Wallet: $WALLET"
  echo "Balance: $BALANCE SOL"
  echo "Threshold: $THRESHOLD SOL"
  echo "Action required: Top up rebalancer wallet"
  exit 2
else
  echo "OK: Balance is $BALANCE SOL (threshold: $THRESHOLD SOL)"
  exit 0
fi
