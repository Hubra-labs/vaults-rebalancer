# Rebalance Bot Template

[![Run on Replit](https://replit.com/badge/github/voltrxyz/rebalance-bot-template)](https://replit.com/github/voltrxyz/rebalance-bot-template)

A Voltr vault manager bot that distributes funds equally across lending strategies on a fixed schedule. Built for Solana.

## How It Works

The bot runs several concurrent loops:

- **Rebalance Loop** — On every interval (default 30 min), computes an equal-weight target allocation across all strategies and executes deposit/withdraw transactions to reach it. Also triggers on new deposits detected via ATA subscription.
- **Refresh Loop** — Periodically refreshes strategy positions to keep on-chain receipt values up to date.
- **Harvest Fee Loop** — Collects protocol/admin/manager fees from the Voltr vault.
- **Claim Reward Loops** — Claims farm rewards from Kamino market and vault strategies, swaps them back to the vault asset via Jupiter.

### Equal-Weight Allocation

Given N strategies and total funds T:

1. Compute locked amounts per strategy (funds that can't be withdrawn due to liquidity constraints)
2. Distribute remaining funds equally across all strategies
3. Target idle balance = 0

Strategies with locked amounts exceeding the equal share keep their locked amount; the rest is redistributed among the remaining strategies.

## Supported Strategy Types

| Type | Description |
|------|-------------|
| `jupiterLend` | Jupiter Lend |
| `kaminoMarket` | Kamino lending market reserve |
| `kaminoVault` | Kamino vault (multi-reserve) |

Configure strategies in `strategies.json`. Jupiter Lend strategy addresses are derived automatically from on-chain PDAs using the vault's `ASSET_MINT_ADDRESS`.

## Setup

```bash
# Install dependencies
pnpm install

# Copy and fill in environment variables
cp .env.example .env

# Build
pnpm run build

# Run
pnpm start

# Dev mode (ts-node)
pnpm run dev
```

### Running on Replit

1. Fork this repo on Replit
2. Open the **Secrets** tab and add each variable from `.env.example`
3. For the manager keypair, set `MANAGER_SECRET_KEY` to your base58 private key or JSON byte array (e.g. `[174,47,154,...]`) — do **not** use `MANAGER_SECRET_PATH` on Replit
4. Edit `strategies.json` with your strategies (Kamino strategies need an `address`; Jupiter Lend is derived automatically)
5. Hit **Run** — the `.replit` file handles build + start automatically

> Replit free tier will sleep your repl after inactivity. For a 24/7 bot, use a paid Replit plan or deploy to a VPS.

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `RPC_URL` | Solana RPC endpoint |
| `MANAGER_SECRET_PATH` | Path to the vault manager keypair JSON file (set this **or** `MANAGER_SECRET_KEY`) |
| `MANAGER_SECRET_KEY` | Manager private key as a base58 string or JSON byte array `[n,n,n,...]` (set this **or** `MANAGER_SECRET_PATH`) |
| `VOLTR_VAULT_ADDRESS` | Voltr vault address |
| `VOLTR_VAULT_ADMIN_ADDRESS` | Vault admin address |
| `VOLTR_VAULT_MANAGER_ADDRESS` | Vault manager address |
| `ASSET_MINT_ADDRESS` | Vault asset token mint |
| `ASSET_TOKEN_PROGRAM` | Token program for the asset (Token or Token-2022) |
| `VOLTR_LOOKUP_TABLE_ADDRESS` | Voltr address lookup table |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_FALLBACK_URL` | — | Fallback RPC endpoint |
| `REBALANCE_LOOP_INTERVAL_MS` | `1800000` | Rebalance interval (30 min) |
| `REFRESH_LOOP_INTERVAL_MS` | `600000` | Refresh interval (10 min) |
| `HARVEST_FEE_LOOP_INTERVAL_MS` | `1800000` | Harvest fee interval (30 min) |
| `CLAIM_KMARKET_REWARD_LOOP_INTERVAL_MS` | `3600000` | Kamino market reward claim interval (1 hr) |
| `CLAIM_KVAULT_REWARD_LOOP_INTERVAL_MS` | `3600000` | Kamino vault reward claim interval (1 hr) |
| `DEPOSIT_STRATEGY_MIN_AMOUNT` | `0` | Min idle balance to trigger deposit-based rebalance |
| `JUPITER_SWAP_SLIPPAGE_BPS` | `50` | Slippage tolerance for Jupiter reward swaps |
| `REFRESH_MIN_POSITION_VALUE` | `1000000` | Min position value (lamports) to refresh |
| `REBALANCE_DEVIATION_BPS` | `0` | Reserved for future threshold-based rebalancing |
| `WORKER_MAX_MEMORY_MB` | `2048` | Max memory for rebalance worker thread (MB) |
| `HEALTH_SERVER_PORT` | `8080` | HTTP health check port |
| `LOG_LEVEL` | `info` | Pino log level |

### Feature Flags

All feature flags default to `true` except where noted:

| Flag | Default | Description |
|------|---------|-------------|
| `ENABLE_REBALANCE_LOOP` | `true` | Equal-weight rebalancing |
| `ENABLE_REFRESH_LOOP` | `true` | Position refresh |
| `ENABLE_HARVEST_FEE_LOOP` | `true` | Fee harvesting |
| `ENABLE_CLAIM_KMARKET_REWARD_LOOP` | `true` | Kamino market reward claims |
| `ENABLE_CLAIM_KVAULT_REWARD_LOOP` | `false` | Kamino vault reward claims |

## Project Structure

```
src/
  index.ts                    # Entry point, spawns loops
  config.ts                   # Environment config with Zod validation
  rebalance_loop.ts           # Equal-weight rebalance logic
  rebalance_worker.ts         # Worker thread wrapper for rebalance loop
  refresh_loop.ts             # Position refresh loop
  harvest_fee_loop.ts         # Fee harvesting loop
  claim_kmarket_reward_loop.ts
  claim_kvault_reward_loop.ts
  lib/
    connection.ts             # RPC connection manager with failover
    constants.ts              # Program IDs and discriminators
    convert.ts                # Address conversion utilities
    keypair.ts                # Manager keypair loader (file or env var)
    utils.ts                  # Logger, sleep, retry helpers
    solana.ts                 # Transaction building and sending
    price.ts                  # Token price fetching
    jupiter.ts                # Jupiter Lend strategy instructions + swap
    strategy-config.ts        # Strategy registry loaded from strategies.json (derives Jupiter addresses from PDAs)
    kamino/
      index.ts
      instructions.ts         # Kamino deposit/withdraw/claim instructions
      reserves.ts             # Kamino reserve APY and liquidity helpers
    simulate/
      index.ts                # getCurrentAndEqualAllocation()
      optimizer.ts            # createEqualWeightAllocation()
      types.ts                # Allocation interface
```
