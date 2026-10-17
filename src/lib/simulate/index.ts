import { BN } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { config } from "../../config";
import { VoltrClient } from "@voltr/vault-sdk";
import { KaminoVault } from "@kamino-finance/klend-sdk";
import { address, Rpc, SolanaRpcApi } from "@solana/kit";
import {
  getAvailableWithdrawalLiquidityForKVaultMaxWithdrawableReserve,
} from "../kamino";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DEFAULT_ADDRESS, toPublicKey } from "../convert";
import { Allocation } from "./types";
import {
  createYieldBasedAllocation,
  StrategyInput,
} from "./optimizer";
import {
  strategyRegistry,
  StrategyConfig,
  IDLE_ID,
} from "../strategy-config";
import {
  fetchYieldMarkets,
  chooseTarget,
} from "../yield-api";
import { PERENA_VAULT_ASSET_ATA } from "../perena";
import { P0_USDC_LIQUIDITY_VAULT } from "../p0";
import { logger } from "../utils";
import { workerMetrics } from "../metrics-bridge";

export * from "./types";

export interface AllocationResult {
  prevAllocations: Allocation[];
  targetAllocations: Allocation[];
  skipRebalance: boolean;
  skipReason?: string;
}

export async function getCurrentAndTargetAllocation(
  connection: Connection,
  rpc: Rpc<SolanaRpcApi>
): Promise<AllocationResult> {
  const voltrClient = new VoltrClient(connection);

  // Fetch vault account for authoritative totalValue
  const vaultAccount = await voltrClient.fetchVaultAccount(
    toPublicKey(config.voltrVaultAddress)
  );
  const vaultTotalValue = vaultAccount.asset.totalValue;

  // Fetch ALL receipts for this vault (catches receipts we might not know about)
  const allReceipts = await voltrClient.fetchAllStrategyInitReceiptAccountsOfVault(
    toPublicKey(config.voltrVaultAddress)
  );

  // Build a map of strategy address -> position value from actual on-chain receipts
  const receiptMap = new Map<string, BN>();
  for (const r of allReceipts) {
    const strategyAddr = r.account.strategy.toBase58();
    const positionValue = r.account.positionValue as BN;
    receiptMap.set(strategyAddr, positionValue);
  }

  // Get position values for our configured strategies
  const positionValues = strategyRegistry.strategies.map((s) => {
    const addrStr = String(s.address);
    return receiptMap.get(addrStr) ?? new BN(0);
  });

  // Sum ALL strategy positions from receipts (not just configured ones)
  const strategyTotal = Array.from(receiptMap.values()).reduce(
    (acc, pv) => acc.add(pv),
    new BN(0)
  );

  // Calculate actual idle: vault total - all strategy positions
  const idleBalance = vaultTotalValue.sub(strategyTotal);

  // Log receipt data for debugging
  logger.debug(
    {
      vaultTotalValue: vaultTotalValue.toString(),
      receiptCount: allReceipts.length,
      strategyTotal: strategyTotal.toString(),
      calculatedIdle: idleBalance.toString(),
      receipts: allReceipts.map((r) => ({
        strategy: r.account.strategy.toBase58(),
        positionValue: (r.account.positionValue as BN).toString(),
      })),
    },
    "Position values from receipts"
  );

  const prevAllocations: Allocation[] = strategyRegistry.strategies.map(
    (s, i) => ({
      strategyId: s.id,
      strategyType: s.type,
      strategyAddress: s.address,
      positionValue: positionValues[i],
    })
  );
  prevAllocations.push({
    strategyId: IDLE_ID,
    strategyType: "idle",
    strategyAddress: DEFAULT_ADDRESS,
    positionValue: idleBalance,
  });

  // Total position value for yield allocation calculations
  const totalPositionValue = vaultTotalValue;

  const decimals = 6;
  const divisor = 10 ** decimals;
  workerMetrics.set("vault_total_value", vaultTotalValue.toNumber() / divisor);
  workerMetrics.set("vault_idle_balance", idleBalance.toNumber() / divisor);
  for (const alloc of prevAllocations) {
    if (alloc.strategyType !== "idle") {
      workerMetrics.set("strategy_position_value", alloc.positionValue.toNumber() / divisor, {
        strategy_id: alloc.strategyId,
        strategy_type: alloc.strategyType,
      });
    }
  }

  // Collect kvault withdrawal liquidity constraints
  type VaultState = Awaited<ReturnType<KaminoVault["getState"]>>;
  const kaminoVaultStates = new Map<string, VaultState>();
  for (const kvConfig of strategyRegistry.kaminoVaults) {
    const kv = new KaminoVault(address(kvConfig.address));
    const vs = await kv.getState(rpc);
    kaminoVaultStates.set(kvConfig.id, vs);
  }

  const kvaultLiquidityMap = new Map<string, BN>();
  for (const [id, vs] of kaminoVaultStates) {
    const liq = await getAvailableWithdrawalLiquidityForKVaultMaxWithdrawableReserve(
      rpc,
      vs
    ).then((l) => new BN(l.mul(0.98).floor().toString()));
    kvaultLiquidityMap.set(id, liq);
  }

  // Perena withdrawals are paid from its vault's USDC balance
  for (const s of strategyRegistry.strategies.filter((s) => s.type === "perena")) {
    const bal = await connection.getTokenAccountBalance(PERENA_VAULT_ASSET_ATA);
    kvaultLiquidityMap.set(s.id, new BN(bal.value.amount).muln(98).divn(100));
  }

  // P0 withdrawals are paid from the bank's free liquidity (deposits not lent out)
  for (const s of strategyRegistry.strategies.filter((s) => s.type === "p0")) {
    const bal = await connection.getTokenAccountBalance(P0_USDC_LIQUIDITY_VAULT);
    kvaultLiquidityMap.set(s.id, new BN(bal.value.amount).muln(98).divn(100));
  }

  const strategyInputs: StrategyInput[] = strategyRegistry.strategies.map(
    (s, i) => ({
      strategyId: s.id,
      strategyType: s.type,
      strategyAddress: s.address,
      positionValue: positionValues[i],
      availableWithdrawableLiquidity:
        kvaultLiquidityMap.get(s.id) ?? new BN(Number.MAX_SAFE_INTEGER),
    })
  );

  // Current pool = configured strategy holding the most funds
  const current = prevAllocations
    .filter((a) => a.strategyType !== "idle" && a.positionValue.gtn(0))
    .sort((a, b) => b.positionValue.cmp(a.positionValue))[0];

  const winnerResult = await resolveYieldWinner(
    current?.strategyId ?? null,
    (s) => receiptMap.has(String(s.address))
  );

  // If we should skip rebalance (no matching strategy or API failure),
  // return current allocations as target (no changes)
  if (winnerResult.skipRebalance) {
    logger.info(
      { reason: winnerResult.reason },
      "Skipping rebalance — keeping current allocation"
    );
    return {
      prevAllocations,
      targetAllocations: prevAllocations, // No change
      skipRebalance: true,
      skipReason: winnerResult.reason,
    };
  }

  const targetAllocations = createYieldBasedAllocation(
    totalPositionValue,
    strategyInputs,
    winnerResult.winnerId
  );

  for (const alloc of targetAllocations) {
    if (alloc.strategyType !== "idle") {
      workerMetrics.set("strategy_target_value", alloc.positionValue.toNumber() / divisor, {
        strategy_id: alloc.strategyId,
        strategy_type: alloc.strategyType,
      });
    }
  }

  return {
    prevAllocations,
    targetAllocations,
    skipRebalance: false,
  };
}

export interface YieldWinnerResult {
  winnerId: string | null;
  skipRebalance: boolean;
  reason?: string;
}

async function resolveYieldWinner(
  currentId: string | null,
  isInitialized: (s: StrategyConfig) => boolean
): Promise<YieldWinnerResult> {
  try {
    const assetMint = config.assetMintAddress as string;
    const markets = await fetchYieldMarkets(assetMint);

    const decision = chooseTarget(markets, currentId, isInitialized);
    if (!decision) {
      logger.warn("No eligible strategy for best yield opportunity — keeping current allocation (not falling back to equal-weight)");
      workerMetrics.inc("rebalance_skip_total", { reason: "no_match" });
      return { winnerId: null, skipRebalance: true, reason: "no_matching_strategy" };
    }

    const { winner } = decision;
    workerMetrics.set("yield_winner_apy", winner.market.depositApy);
    workerMetrics.set("yield_winner_tvl", winner.market.totalDepositUsd);
    workerMetrics.set("yield_winner_info", 1, {
      strategy_id: winner.strategy.id,
      provider: winner.market.provider.name,
      pool_pubkey: winner.strategy.address.toString(),
      vault_address: config.voltrVaultAddress.toString(),
    });

    const pct = (x: number | null) => (x === null ? "unknown" : `${(x * 100).toFixed(2)}%`);
    logger.info(
      {
        winnerId: winner.strategy.id,
        winnerApy: pct(winner.market.depositApy),
        currentId: decision.currentId,
        currentApy: pct(decision.currentApy),
        targetId: decision.targetId,
        reason: decision.reason,
      },
      decision.switched ? "Yield target selected — allocating 100%" : "Holding current pool — allocating 100%"
    );

    return { winnerId: decision.targetId, skipRebalance: false };
  } catch (error) {
    workerMetrics.inc("rebalance_skip_total", { reason: "api_fail" });
    logger.error(error, "Yield API failed — keeping current allocation (not falling back to equal-weight)");
    return { winnerId: null, skipRebalance: true, reason: "api_error" };
  }
}
