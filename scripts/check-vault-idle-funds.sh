#!/bin/bash
# Check Hubra vaults for idle funds and auto-trigger rebalance if needed
# Values from API are in smallest units, divided by 10^decimals for display

set -e

# Vault address : Rebalancer port (ports assigned alphabetically by setup.sh)
VAULTS=(
  "USD1:663azFYEnHDTLGf4CEk8KpNTje8XxZVLnQwo9LjbSejy:8080"
  "USDC:3maCuTJVPteZ2dFA8dADxz2EbpJHfoAG5txYhXDs6gNQ:8081"
  "USDG:7VZ1XKK7Zns6UzRc1Wz54u6cypN7zaduasVXXr7NysxH:8082"
  "USDS:5mv1cURMSaPU3q3wFVoN4mKMWNFVvUtH3UZrG4Z2Mgfz:8083"
  "USDT:3kzb6rcDJxSdkWCwXXP9PULSqBy6rVDNWanzw5dBCYCj:8084"
)

# Tolerance in dollars (ignore idle below this threshold)
TOLERANCE=10.00

ISSUES=()
REBALANCED=()

for vault_entry in "${VAULTS[@]}"; do
  IFS=':' read -r vault_name vault_address rebalancer_port <<< "$vault_entry"
  
  # Fetch vault data
  response=$(curl -s "https://api.voltr.xyz/vault/${vault_address}")
  
  # Check if request was successful
  success=$(echo "$response" | jq -r '.success')
  if [ "$success" != "true" ]; then
    ISSUES+=("$vault_name ($vault_address): Failed to fetch vault data")
    continue
  fi
  
  # Get totalValue, allocated sum, and decimals
  total_raw=$(echo "$response" | jq -r '.vault.totalValue')
  allocated_raw=$(echo "$response" | jq '[.vault.allocations[].positionValue] | add // 0')
  decimals=$(echo "$response" | jq -r '.vault.token.decimals')
  
  # Calculate values in dollars (divide by 10^decimals)
  result=$(awk -v total="$total_raw" -v alloc="$allocated_raw" -v dec="$decimals" -v tol="$TOLERANCE" '
    BEGIN {
      divisor = 10 ^ dec
      total_usd = total / divisor
      alloc_usd = alloc / divisor
      idle_usd = total_usd - alloc_usd
      
      if (idle_usd > tol) {
        printf "IDLE:%.2f:%.2f:%.2f", total_usd, alloc_usd, idle_usd
      } else {
        print "OK"
      }
    }
  ')
  
  if [[ "$result" == IDLE:* ]]; then
    IFS=':' read -r _ total_fmt alloc_fmt idle_fmt <<< "$result"
    
    # Trigger rebalance
    rebalance_result=$(curl -s -X POST "http://localhost:${rebalancer_port}/rebalance" 2>&1)
    
    if echo "$rebalance_result" | grep -q "triggered"; then
      REBALANCED+=("$vault_name: Idle \$${idle_fmt} → Rebalance triggered (port ${rebalancer_port})")
    else
      ISSUES+=("$vault_name: Idle \$${idle_fmt} — Rebalance FAILED: ${rebalance_result}")
    fi
  fi
done

# Output results
if [ ${#REBALANCED[@]} -gt 0 ]; then
  echo "🔄 Auto-Rebalance Triggered"
  printf '%s\n' "${REBALANCED[@]}"
  echo ""
fi

if [ ${#ISSUES[@]} -gt 0 ]; then
  echo "⚠️ Vault Issues"
  printf '%s\n' "${ISSUES[@]}"
  echo ""
fi

if [ ${#REBALANCED[@]} -gt 0 ] || [ ${#ISSUES[@]} -gt 0 ]; then
  echo "📊 Grafana: https://falcon.hubra.app/grafana/?orgId=1&from=now-5m&to=now&timezone=browser&var-asset=\$__all&refresh=30s"
  exit 1
else
  echo "All vaults OK - no idle funds above \$${TOLERANCE}"
  exit 0
fi
