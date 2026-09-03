# Hubra Vaults Rebalancer — Architecture

A yield-optimized vault manager that dynamically allocates capital to the highest-yielding lending strategy on Solana, across Kamino and Jupiter protocols.

## How It Works (TL;DR)

Every 30 minutes (and on new deposits), the rebalancer:

1. Fetches live APY data from the Dial.to markets API
2. Matches those yields to our registered lending strategies
3. Picks the single highest-yielding pool that passes safety checks (TVL > $500k, dilution < 0.5%)
4. Moves all available capital into that winner

If the API is down or no pool passes the filters, it falls back to equal-weight allocation across all strategies.

## System Overview

```
                    ┌──────────────┐
                    │   index.ts   │
                    │  (app boot)  │
                    └──────┬───────┘
                           │ spawns
          ┌────────────────┼────────────────────┐
          │                │                    │
          ▼                ▼                    ▼
   ┌─────────────┐  ┌────────────┐  ┌───────────────────┐
   │  Rebalance  │  │  Refresh   │  │  Harvest / Claim  │
   │   (Worker)  │  │   Loop     │  │     Loops         │
   └──────┬──────┘  └────────────┘  └───────────────────┘
          │
          ▼
   ┌─────────────────────────────────────┐
   │         Yield Optimizer             │
   │  Dial API → Match → Filter → Pick  │
   └──────┬──────────────────────────────┘
          │
          ▼
   ┌─────────────────────────────────────┐
   │       Transaction Builder           │
   │  Withdraw losers → Deposit winner   │
   └──────┬──────────────────────────────┘
          │
          ▼
   ┌─────────────────────────────────────┐
   │          Solana RPC                 │
   │  Simulate → Priority Fee → Send    │
   └─────────────────────────────────────┘
```

## The Rebalance Loop

The core of the system. Runs in an isolated Worker thread with memory limits.

### Triggers

- **Scheduled** — every `REBALANCE_LOOP_INTERVAL_MS` (default 30 min)
- **Reactive** — WebSocket subscription on the vault's idle token account (fires on new deposits)

### Rebalance Flow (State Machine)

```
┌─────────────────┐
│  FETCH CURRENT   │  Read position values from Voltr receipts
│  POSITIONS       │  + idle balance from vault ATA
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  RESOLVE YIELD   │  Call Dial.to API for live APYs
│  WINNER          │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
 winner    no winner
 found     (API fail / all filtered)
    │         │
    ▼         ▼
┌────────┐  ┌────────────────┐
│ 100%   │  │  Equal-weight  │
│ to     │  │  across all    │
│ winner │  │  strategies    │
└───┬────┘  └───────┬────────┘
    │               │
    └───────┬───────┘
            ▼
┌─────────────────────┐
│  COMPUTE DELTAS      │  target[i] - current[i] for each strategy
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  BUILD WITHDRAW IXs  │  For strategies where delta < 0
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  BUILD DEPOSIT IXs   │  For strategies where delta > 0
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  SEND TRANSACTIONS   │  1 instruction per tx, with ALTs
└─────────────────────┘
```

### Locked Liquidity

Not all funds can be freely moved. Some protocols lock capital temporarily.

```
locked = max(positionValue - availableWithdrawableLiquidity, 0)
```

When picking a winner, locked funds in non-winner strategies stay put — only the withdrawable portion moves. The winner gets: `total - sum(locked in other strategies)`.

## Yield Optimization Pipeline

Lives in `src/lib/yield-api.ts` and `src/lib/simulate/`.

```
Dial.to API
    │
    │  GET /api/v1/markets?token={USDC_MINT}
    │
    ▼
All USDC markets (100+)
    │
    │  matchMarketsToStrategies()
    │  ├─ Kamino Vault: additionalData.vaultAddress === strategy.address
    │  └─ Jupiter Lend: provider.id === "jupiter"
    │  (KaminoMarket: no API match → get 0% allocation)
    │
    ▼
Matched markets (~8-10)
    │
    │  filterByTvl(>= $500k)
    │
    ▼
TVL-safe markets
    │
    │  checkDilution(<= 0.5%)
    │  effectiveApy = apy * tvl / (tvl + ourDeposit)
    │  dilution = apy - effectiveApy
    │
    ▼
Safe markets
    │
    │  sort by depositApy descending → pick [0]
    │
    ▼
Winner strategy (or null → equal-weight fallback)
```

### Why the Dilution Guard?

Depositing into a small pool tanks the yield for everyone (including us). If a pool has $1M TVL at 5.5% APY and we deposit $500k:

```
effectiveApy = 5.5% * $1M / ($1M + $500k) = 3.67%
dilution = 5.5% - 3.67% = 1.83% → REJECT (> 0.5% threshold)
```

## Strategy Types

Loaded from `strategies.json` at boot. Addresses for Jupiter are auto-derived from PDAs.

| Type | Protocol | Address Source | Matchable via Dial API |
|------|----------|--------------|----------------------|
| `kaminoVault` | Kamino Vaults | Explicit in config | Yes (by vault address) |
| `jupiterLend` | Jupiter Lend | PDA from asset mint | Yes (by provider id) |
| `kaminoMarket` | Kamino Markets | Explicit in config | No |

Strategies not matchable in the API never win — their funds get withdrawn to the winner.

## Other Loops

### Refresh Loop
Keeps on-chain position receipts fresh by sending zero-amount deposits to strategies that haven't been updated in 10+ minutes. This ensures position values stay accurate.

### Harvest Fee Loop
Collects protocol/admin/manager fees from the Voltr vault by minting LP tokens to fee recipient accounts.

### Claim Reward Loops (Kamino Market + Vault)
Claims farming rewards from Kamino strategies, swaps them to the vault's base asset via Jupiter aggregator, and deposits back.

## Transaction Pipeline

All transactions go through the same optimized pipeline in `src/lib/solana.ts`:

```
Build instruction(s)
    │
    ▼
Simulate for compute unit estimation (1.1x buffer)
    │
    ▼
Fetch priority fee from Helius API (medium tier)
    │
    ▼
Build VersionedTransaction (V0) with address lookup tables
    │
    ▼
Sign and send (skipPreflight=false, maxRetries=5)
    │
    ▼
Confirm (processed commitment)
```

## Infrastructure

### Connection Management
Singleton `ConnectionManager` holds both a web3.js `Connection` and a `@solana/kit` `Rpc`. Supports primary + fallback RPC with manual switchover.

### Worker Thread Isolation
The rebalance loop runs in a dedicated Worker thread with a configurable memory cap (`WORKER_MAX_MEMORY_MB`). Auto-restarts up to 3 times on failure.

### Graceful Shutdown
SIGINT/SIGTERM set a global `isShuttingDown()` flag. All loops check this flag and exit cleanly. Force-kills after 15s if anything hangs.

### Health Server
Minimal HTTP server on port 9090. Returns `{"status":"ok"}` or `{"status":"shutting_down"}`.

## Key Config (Environment Variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `REBALANCE_LOOP_INTERVAL_MS` | 1800000 (30m) | How often to rebalance |
| `MIN_TVL_USD` | 500000 | Minimum pool TVL to consider |
| `MAX_DILUTION_PCT` | 0.005 | Max acceptable APY dilution |
| `YIELD_API_TIMEOUT_MS` | 5000 | Dial.to API timeout |
| `REBALANCE_DEVIATION_BPS` | 0 | Min delta to trigger rebalance |
| `DEPOSIT_STRATEGY_MIN_AMOUNT` | 0 | Min idle balance to trigger reactive rebalance |

## File Map

```
src/
├── index.ts                    # App entry, loop spawning, health server
├── config.ts                   # Env validation via Zod
├── rebalance_loop.ts           # Core rebalance loop + executeRebalance()
├── refresh_loop.ts             # Position receipt refresh
├── harvest_fee_loop.ts         # Fee harvesting
├── claim_kmarket_reward_loop.ts # Kamino market reward claiming
├── claim_kvault_reward_loop.ts  # Kamino vault reward claiming
└── lib/
    ├── yield-api.ts            # Dial.to client, matching, filtering
    ├── strategy-config.ts      # Strategy registry, PDA derivation
    ├── price.ts                # Token price fetching (Kamino KSwap)
    ├── connection.ts           # RPC connection manager (primary/fallback)
    ├── solana.ts               # Transaction building, CU estimation, sending
    ├── convert.ts              # Address format conversions
    ├── constants.ts            # Program IDs
    ├── keypair.ts              # Manager keypair loading
    ├── utils.ts                # Logger, sleep, retry wrapper
    ├── jupiter.ts              # Jupiter Lend + swap instructions
    ├── simulate/
    │   ├── index.ts            # getCurrentAndTargetAllocation()
    │   ├── optimizer.ts        # Yield-based + equal-weight allocation math
    │   └── types.ts            # Allocation type
    └── kamino/
        ├── index.ts            # Re-exports
        ├── instructions.ts     # Kamino Market/Vault deposit/withdraw/claim
        └── reserves.ts         # Withdrawal liquidity calculation
```
