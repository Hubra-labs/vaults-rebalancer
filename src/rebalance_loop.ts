import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  AccountInfo,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { config } from "./config";
import { isShuttingDown, logger, sleep } from "./lib/utils";
import {
  createDepositKMarketStrategyIx,
  createDepositKVaultStrategyIx,
  createWithdrawKMarketStrategyIx,
  createWithdrawKVaultStrategyIx,
} from "./lib/kamino";
import {
  Rpc,
  SolanaRpcApi,
} from "@solana/kit";
import { BN } from "@coral-xyz/anchor";
import {
  Allocation,
  getCurrentAndTargetAllocation,
} from "./lib/simulate";
import {
  createDepositDEarnStrategyIx,
  createWithdrawDEarnStrategyIx,
} from "./lib/drift";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
} from "./lib/solana";
import {
  createDepositJLendStrategyIx,
  createWithdrawJLendStrategyIx,
} from "./lib/jupiter";
import { getConnectionManager } from "./lib/connection";
import { toAddress, toPublicKey } from "./lib/convert";
import { strategyRegistry, DriftEarnStrategyConfig } from "./lib/strategy-config";
import { getManagerKeypair } from "./lib/keypair";
import { workerMetrics } from "./lib/metrics-bridge";

let manualTriggerResolve: (() => void) | null = null;

export function triggerManualRebalance() {
  if (manualTriggerResolve) {
    manualTriggerResolve();
    manualTriggerResolve = null;
  }
}

function sleepUntilNextRunOrTrigger(ms: number): Promise<"timer" | "trigger"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      manualTriggerResolve = null;
      resolve("timer");
    }, ms);

    manualTriggerResolve = () => {
      clearTimeout(timer);
      resolve("trigger");
    };
  });
}

export async function runRebalanceLoop() {
  logger.info("Starting Rebalance Bot...");

  const connManager = getConnectionManager();
  const connection = connManager.getConnection();
  const rpc = connManager.getRpc();

  const manager = getManagerKeypair();

  logger.info(
    `[Rebalance Loop] Manager Loaded: ${manager.publicKey.toBase58()}`
  );
  logger.info(
    `[Rebalance Loop] Loop Interval: ${config.rebalanceLoopIntervalMs / 1000
    } seconds`
  );

  // Initialize clients
  const voltrClient = new VoltrClient(connection);

  const vaultAssetIdleAuth = voltrClient.findVaultAssetIdleAuth(
    toPublicKey(config.voltrVaultAddress)
  );

  const vaultAssetIdleAta = getAssociatedTokenAddressSync(
    toPublicKey(config.assetMintAddress),
    vaultAssetIdleAuth,
    true,
    toPublicKey(config.assetTokenProgram)
  );

  logger.info(
    `[Rebalance Loop] Monitoring ATA: ${vaultAssetIdleAta.toBase58()}`
  );

  let lastExecutionTime = 0;
  let loopCount = 0;
  let subscriptionId: number | null = null;
  let previousBalance: BN | null = null;

  const isOnCooldown = () =>
    Date.now() - lastExecutionTime < config.rebalanceLoopIntervalMs;

  // Set up account subscription for real-time monitoring of new deposits
  const startAccountSubscription = () => {
    if (subscriptionId !== null) {
      connection.removeAccountChangeListener(subscriptionId);
    }

    subscriptionId = connection.onAccountChange(
      vaultAssetIdleAta,
      async (accountInfo: AccountInfo<Buffer>) => {
        try {
          const accountData = accountInfo.data;
          const amountBytes = accountData.slice(64, 72);
          const currentBalance = new BN(amountBytes, "le");

          const balanceIncreased =
            previousBalance !== null && currentBalance.gt(previousBalance);
          previousBalance = currentBalance;

          if (!balanceIncreased) return;

          if (isOnCooldown()) {
            logger.info(
              `[Rebalance Loop ${loopCount}] Deposit detected but on cooldown, skipping`
            );
            return;
          }

          if (currentBalance.lte(new BN(config.depositStrategyMinAmount))) return;

          try {
            logger.info(
              `[Rebalance Loop ${loopCount}] Executing rebalance (triggered by deposit)...`
            );
            workerMetrics.inc("rebalance_total", { trigger: "deposit" });
            const depositStart = Date.now();

            const { prevAllocations, targetAllocations } =
              await getCurrentAndTargetAllocation(connection, rpc);

            await executeRebalance(
              rpc,
              connection,
              manager,
              voltrClient,
              prevAllocations,
              targetAllocations
            );

            workerMetrics.observe("rebalance_duration_seconds", (Date.now() - depositStart) / 1000);
            logger.info(
              `[Rebalance Loop ${loopCount}] Successfully executed rebalance.`
            );

            lastExecutionTime = Date.now();
            loopCount++;
          } catch (error) {
            workerMetrics.inc("rebalance_errors_total");
            logger.error(
              error,
              `[Rebalance Loop ${loopCount}] Error during rebalance execution`
            );
          }
        } catch (error) {
          logger.error(error, `Error processing account change`);
        }
      },
      "processed"
    );

    logger.info(
      `Started listening for ATA changes (subscription ID: ${subscriptionId})`
    );
  };

  // Start the subscription
  startAccountSubscription();

  // Main loop — wait for interval or manual trigger, then execute rebalance
  while (!isShuttingDown()) {
    try {
      const now = Date.now();
      const timeSinceLastExecution = now - lastExecutionTime;
      const remaining = config.rebalanceLoopIntervalMs - timeSinceLastExecution;

      if (remaining > 0) {
        logger.info(`[Rebalance Loop ${loopCount}] Waiting for next interval.`);
        const wakeReason = await sleepUntilNextRunOrTrigger(remaining);
        if (isShuttingDown()) break;
        var isManual = wakeReason === "trigger";
      } else {
        var isManual = false;
      }

      const trigger = isManual ? "manual" : "scheduled";
      logger.info(
        `[Rebalance Loop ${loopCount}] Executing ${trigger} yield-based rebalance...`
      );
      workerMetrics.inc("rebalance_total", { trigger });
      const executionStart = Date.now();

      const { prevAllocations, targetAllocations } =
        await getCurrentAndTargetAllocation(connection, rpc);

      const strategies = prevAllocations.map((allocation) =>
        allocation.strategyId
      );

      logger.info(
        `[Rebalance Loop ${loopCount}] strategies: ${strategies.join(",")}`
      );
      logger.info(
        `[Rebalance Loop ${loopCount}] prevAllocations: ${prevAllocations.map(
          (allocation) => allocation.positionValue.toNumber()
        )}`
      );
      logger.info(
        `[Rebalance Loop ${loopCount}] targetAllocations: ${targetAllocations.map(
          (allocation) => allocation.positionValue.toNumber()
        )}`
      );

      await executeRebalance(
        rpc,
        connection,
        manager,
        voltrClient,
        prevAllocations,
        targetAllocations
      );

      workerMetrics.observe("rebalance_duration_seconds", (Date.now() - executionStart) / 1000);
      logger.info(
        `[Rebalance Loop ${loopCount}] Successfully executed rebalance.`
      );
      lastExecutionTime = Date.now();
      loopCount++;
    } catch (error) {
      workerMetrics.inc("rebalance_errors_total");
      logger.error(
        error,
        `[Rebalance Loop ${loopCount}] Error during rebalance execution`
      );
      
      // Single retry after 60s, then give up until next scheduled cycle
      logger.info(`[Rebalance Loop ${loopCount}] Will retry once in 60s...`);
      await sleep(60_000);
      
      if (isShuttingDown()) break;
      
      try {
        logger.info(`[Rebalance Loop ${loopCount}] Retry attempt...`);
        const { prevAllocations: retryPrev, targetAllocations: retryTarget } =
          await getCurrentAndTargetAllocation(connection, rpc);
        
        await executeRebalance(
          rpc,
          connection,
          manager,
          voltrClient,
          retryPrev,
          retryTarget
        );
        
        logger.info(`[Rebalance Loop ${loopCount}] Retry succeeded.`);
        lastExecutionTime = Date.now();
      } catch (retryError) {
        workerMetrics.inc("rebalance_errors_total");
        logger.error(
          retryError,
          `[Rebalance Loop ${loopCount}] Retry failed. Waiting for next scheduled cycle.`
        );
        // Don't update lastExecutionTime - will retry at next scheduled interval
      }
    }

    // Restart subscription if it somehow got disconnected
    if (!isShuttingDown() && subscriptionId === null) {
      logger.warn("Subscription lost, restarting...");
      startAccountSubscription();
    }
  }

  // Cleanup WebSocket subscription on exit
  if (subscriptionId !== null) {
    connection.removeAccountChangeListener(subscriptionId);
    logger.info("Cleaned up WebSocket subscription");
  }
}

async function executeRebalance(
  rpc: Rpc<SolanaRpcApi>,
  connection: Connection,
  manager: Keypair,
  voltrClient: VoltrClient,
  prevAllocations: Allocation[],
  newAllocations: Allocation[]
) {
  const transactionIxs: TransactionInstruction[] = [];
  const addressLookupTableAddresses: string[] = [];

  const depositDelta = newAllocations.map((allocation, idx) => {
    return {
      strategyId: allocation.strategyId,
      strategyType: allocation.strategyType,
      strategyAddress: allocation.strategyAddress,
      delta: allocation.positionValue.sub(prevAllocations[idx].positionValue),
    };
  });

  let nWithdraws = 0;
  for (const allocation of depositDelta.filter((allocation) =>
    allocation.delta.ltn(0)
  )) {
    nWithdraws++;

    const originalIndex = depositDelta.findIndex(
      (a) => a.strategyId === allocation.strategyId
    );
    const withdrawAmount = newAllocations[originalIndex].positionValue.isZero()
      ? new BN(Number.MAX_SAFE_INTEGER)
      : allocation.delta.neg();

    switch (allocation.strategyType) {
      case "kaminoMarket":
        await createWithdrawKMarketStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          withdrawAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      case "driftEarn": {
        const driftConfig = strategyRegistry.byId.get(allocation.strategyId)! as DriftEarnStrategyConfig;
        await createWithdrawDEarnStrategyIx(
          voltrClient,
          driftConfig.marketIndex,
          manager,
          withdrawAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      }
      case "jupiterLend":
        await createWithdrawJLendStrategyIx(
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          withdrawAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      case "kaminoVault":
        await createWithdrawKVaultStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          withdrawAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      default:
        logger.warn(`Unknown strategy type "${allocation.strategyType}" for "${allocation.strategyId}", skipping withdraw`);
        break;
    }
  }

  for (const allocation of depositDelta.filter((allocation) =>
    allocation.delta.gtn(0)
  )) {
    const depositAmount = allocation.delta.subn(nWithdraws);

    switch (allocation.strategyType) {
      case "kaminoMarket":
        await createDepositKMarketStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      case "driftEarn": {
        const driftConfig = strategyRegistry.byId.get(allocation.strategyId)! as DriftEarnStrategyConfig;
        await createDepositDEarnStrategyIx(
          voltrClient,
          driftConfig.marketIndex,
          manager,
          depositAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      }
      case "jupiterLend":
        await createDepositJLendStrategyIx(
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      case "kaminoVault":
        await createDepositKVaultStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      default:
        logger.warn(`Unknown strategy type "${allocation.strategyType}" for "${allocation.strategyId}", skipping deposit`);
        break;
    }

  }

  addressLookupTableAddresses.push(config.voltrLookupTableAddress);

  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    addressLookupTableAddresses,
    rpc
  );

  const investBatchSize = 1;
  logger.info(
    `Executing ${Math.ceil(
      transactionIxs.length / investBatchSize
    )} transactions`
  );
  for (let i = 0; i < transactionIxs.length; i += investBatchSize) {
    const ixs = transactionIxs.slice(i, i + investBatchSize);
    const txStart = Date.now();
    try {
      const txSig = await sendAndConfirmOptimisedTx(
        ixs,
        config.rpcUrl,
        manager,
        [],
        addressLookupTableAccounts
      );
      workerMetrics.inc("tx_total", { type: "rebalance", status: "success" });
      workerMetrics.observe("tx_duration_seconds", (Date.now() - txStart) / 1000, { type: "rebalance" });
      logger.info(`Rebalance strategy confirmed with signature: ${txSig}`);
    } catch (error) {
      workerMetrics.inc("tx_total", { type: "rebalance", status: "error" });
      throw error;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
