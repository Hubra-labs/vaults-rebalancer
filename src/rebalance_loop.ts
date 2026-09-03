import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  AccountInfo,
  AddressLookupTableAccount,
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
  AllocationResult,
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

            const allocationResult = await getCurrentAndTargetAllocation(connection, rpc);

            if (allocationResult.skipRebalance) {
              logger.info(
                { reason: allocationResult.skipReason },
                `[Rebalance Loop ${loopCount}] Skipping deposit-triggered rebalance — no valid target strategy`
              );
              workerMetrics.inc("rebalance_skip_total", { trigger: "deposit", reason: allocationResult.skipReason || "unknown" });
            } else {
              await executeRebalance(
                rpc,
                connection,
                manager,
                voltrClient,
                allocationResult.prevAllocations,
                allocationResult.targetAllocations
              );

              workerMetrics.observe("rebalance_duration_seconds", (Date.now() - depositStart) / 1000);
              logger.info(
                `[Rebalance Loop ${loopCount}] Successfully executed rebalance.`
              );
            }

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

      const allocationResult = await getCurrentAndTargetAllocation(connection, rpc);

      if (allocationResult.skipRebalance) {
        logger.info(
          { reason: allocationResult.skipReason },
          `[Rebalance Loop ${loopCount}] Skipping ${trigger} rebalance — no valid target strategy`
        );
        workerMetrics.inc("rebalance_skip_total", { trigger, reason: allocationResult.skipReason || "unknown" });
        lastExecutionTime = Date.now();
        loopCount++;
        continue;
      }

      const { prevAllocations, targetAllocations } = allocationResult;

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
        const retryResult = await getCurrentAndTargetAllocation(connection, rpc);
        
        if (retryResult.skipRebalance) {
          logger.info(
            { reason: retryResult.skipReason },
            `[Rebalance Loop ${loopCount}] Retry skipped — no valid target strategy`
          );
        } else {
          await executeRebalance(
            rpc,
            connection,
            manager,
            voltrClient,
            retryResult.prevAllocations,
            retryResult.targetAllocations
          );
          
          logger.info(`[Rebalance Loop ${loopCount}] Retry succeeded.`);
        }
        lastExecutionTime = Date.now();
      } catch (retryError) {
        workerMetrics.inc("rebalance_errors_total");
        logger.error(
          retryError,
          `[Rebalance Loop ${loopCount}] Retry failed. Waiting for next scheduled cycle.`
        );
        // Update lastExecutionTime so we wait for full interval before next attempt
        lastExecutionTime = Date.now();
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

/**
 * Simulates a transaction to verify it will succeed before executing.
 * Returns true if simulation succeeds, false otherwise.
 */
async function simulateTransaction(
  connection: Connection,
  instructions: TransactionInstruction[],
  manager: Keypair,
  addressLookupTableAccounts: AddressLookupTableAccount[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const { VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = await import("@solana/web3.js");
    
    const testInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...instructions,
    ];

    const transaction = new VersionedTransaction(
      new TransactionMessage({
        instructions: testInstructions,
        payerKey: manager.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      }).compileToV0Message(addressLookupTableAccounts)
    );
    transaction.sign([manager]);

    const result = await connection.simulateTransaction(transaction, {
      replaceRecentBlockhash: true,
      sigVerify: false,
      commitment: "processed",
    });

    if (result.value.err) {
      const errorLogs = result.value.logs?.join("\n") || "No logs";
      return { success: false, error: `Simulation failed: ${JSON.stringify(result.value.err)}\nLogs: ${errorLogs}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: `Simulation error: ${error}` };
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
  const depositDelta = newAllocations.map((allocation, idx) => {
    return {
      strategyId: allocation.strategyId,
      strategyType: allocation.strategyType,
      strategyAddress: allocation.strategyAddress,
      delta: allocation.positionValue.sub(prevAllocations[idx].positionValue),
    };
  });

  // Check if there are any actual changes needed
  const hasWithdraws = depositDelta.some((d) => d.delta.ltn(0));
  const hasDeposits = depositDelta.some((d) => d.delta.gtn(0));
  
  if (!hasWithdraws && !hasDeposits) {
    logger.info("No allocation changes needed, skipping rebalance");
    return;
  }

  // ========== PHASE 1: Build deposit instructions and simulate FIRST ==========
  // Before withdrawing anything, verify the deposit will work
  
  const depositIxs: TransactionInstruction[] = [];
  const depositLutAddresses: string[] = [];
  let nWithdraws = 0;
  
  // Count withdraws first to calculate deposit amounts
  for (const allocation of depositDelta.filter((d) => d.delta.ltn(0))) {
    nWithdraws++;
  }
  
  // Build deposit instructions
  for (const allocation of depositDelta.filter((d) => d.delta.gtn(0))) {
    const depositAmount = allocation.delta.subn(nWithdraws);

    if (depositAmount.lten(0)) {
      logger.warn(`Deposit amount for ${allocation.strategyId} is <= 0, skipping`);
      continue;
    }

    // Strategies enforce their own deposit minimums (e.g. Kamino kvault rejects
    // deposits < 100000 units), so dust deposits would fail simulation every cycle
    if (depositAmount.lt(new BN(config.depositStrategyMinAmount))) {
      logger.info(
        `Deposit amount ${depositAmount.toString()} for ${allocation.strategyId} is below DEPOSIT_STRATEGY_MIN_AMOUNT (${config.depositStrategyMinAmount}), leaving idle`
      );
      continue;
    }

    switch (allocation.strategyType) {
      case "kaminoMarket":
        await createDepositKMarketStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          depositIxs,
          depositLutAddresses
        );
        break;
      case "driftEarn": {
        const driftConfig = strategyRegistry.byId.get(allocation.strategyId)! as DriftEarnStrategyConfig;
        await createDepositDEarnStrategyIx(
          voltrClient,
          driftConfig.marketIndex,
          manager,
          depositAmount,
          depositIxs,
          depositLutAddresses
        );
        break;
      }
      case "jupiterLend":
        await createDepositJLendStrategyIx(
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          depositIxs,
          depositLutAddresses
        );
        break;
      case "kaminoVault":
        await createDepositKVaultStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          depositIxs,
          depositLutAddresses
        );
        break;
      default:
        logger.warn(`Unknown strategy type "${allocation.strategyType}" for "${allocation.strategyId}", skipping deposit`);
        break;
    }
  }

  // Note: We can't fully simulate deposits before withdrawal because funds aren't available yet.
  // Instead, we rely on:
  // 1. skipRebalance logic - if API returns unconfigured strategy, we skip entirely
  // 2. The deposit amount calculation accounts for strategy minimums
  // 3. If deposit fails after withdrawal, the retry logic will attempt to recover
  //
  // Future improvement: simulate with a minimal test deposit to verify strategy is functional
  if (depositIxs.length > 0) {
    logger.info(
      { depositCount: depositIxs.length, hasWithdraws },
      "Deposit transactions prepared — will execute after withdrawals"
    );
  }

  // ========== PHASE 2: Execute withdrawals ==========
  const transactionIxs: TransactionInstruction[] = [];
  const addressLookupTableAddresses: string[] = [];

  for (const allocation of depositDelta.filter((allocation) =>
    allocation.delta.ltn(0)
  )) {
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

  // ========== PHASE 3: Add deposit instructions ==========
  // Reuse the already-built deposit instructions
  transactionIxs.push(...depositIxs);
  addressLookupTableAddresses.push(...depositLutAddresses);

  addressLookupTableAddresses.push(config.voltrLookupTableAddress);

  // Deduplicate LUT addresses
  const uniqueLutAddresses = [...new Set(addressLookupTableAddresses)];
  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    uniqueLutAddresses,
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
