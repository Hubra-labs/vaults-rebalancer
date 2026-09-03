import {
  Connection,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { config } from "./config";
import { isShuttingDown, logger, sleep } from "./lib/utils";
import { createDepositKMarketStrategyIx, createDepositKVaultStrategyIx } from "./lib/kamino";
import {
  Rpc,
  SolanaRpcApi,
} from "@solana/kit";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
} from "./lib/solana";
import { BN } from "@coral-xyz/anchor";
import { createDepositJLendStrategyIx } from "./lib/jupiter";
import { getConnectionManager } from "./lib/connection";
import { toAddress, toPublicKey } from "./lib/convert";
import { strategyRegistry } from "./lib/strategy-config";
import { getManagerKeypair } from "./lib/keypair";
import {
  loopIterationsTotal,
  loopErrorsTotal,
  txTotal,
  txDurationSeconds,
  vaultTotalValue,
  vaultIdleBalance,
  strategyPositionValue,
} from "./lib/metrics";

const VAULT_VALUE_DECIMALS = 6;

async function publishVaultMetrics(voltrClient: VoltrClient) {
  const vaultAccount = await voltrClient.fetchVaultAccount(
    toPublicKey(config.voltrVaultAddress)
  );
  const totalValue = vaultAccount.asset.totalValue as BN;

  const allReceipts =
    await voltrClient.fetchAllStrategyInitReceiptAccountsOfVault(
      toPublicKey(config.voltrVaultAddress)
    );

  const receiptMap = new Map<string, BN>();
  for (const r of allReceipts) {
    receiptMap.set(r.account.strategy.toBase58(), r.account.positionValue as BN);
  }

  const strategyTotal = Array.from(receiptMap.values()).reduce(
    (acc, pv) => acc.add(pv),
    new BN(0)
  );
  const idle = totalValue.sub(strategyTotal);

  const divisor = 10 ** VAULT_VALUE_DECIMALS;
  vaultTotalValue.set(totalValue.toNumber() / divisor);
  vaultIdleBalance.set(idle.toNumber() / divisor);

  for (const s of strategyRegistry.strategies) {
    const pv = receiptMap.get(String(s.address)) ?? new BN(0);
    strategyPositionValue.set(
      { strategy_id: s.id, strategy_type: s.type },
      pv.toNumber() / divisor
    );
  }
}

export async function runRefreshLoop() {
  logger.info("🚀 Starting Refresh Bot...");

  const connManager = getConnectionManager();
  const connection = connManager.getConnection();
  const rpc = connManager.getRpc();

  const manager = getManagerKeypair();

  logger.info(
    `Refresh Loop 🔑 Manager Loaded: ${manager.publicKey.toBase58()}`
  );
  logger.info(
    `Refresh Loop ⏰ Loop Interval: ${config.refreshLoopIntervalMs / 1000
    } seconds`
  );

  // Initialize clients
  const voltrClient = new VoltrClient(connection);

  let loopCount = 0;

  // Main scheduled loop
  while (!isShuttingDown()) {
    try {
      await publishVaultMetrics(voltrClient);
    } catch (error) {
      logger.error(error, `[Refresh Loop ${loopCount}] Failed to publish vault metrics`);
    }

    try {
      logger.info(
        `[Refresh Loop ${loopCount}] 🛠️ Executing scheduled refresh strategy...`
      );

      await refreshDepositStrategies(rpc, connection, manager, voltrClient);
      loopIterationsTotal.inc({ loop: "refresh" });
      logger.info(
        `[Refresh Loop ${loopCount}] ✅ Successfully executed scheduled refresh strategy.`
      );
      loopCount++;
    } catch (error) {
      loopErrorsTotal.inc({ loop: "refresh" });
      logger.error(
        error,
        `[Refresh Loop ${loopCount}] ❌ Error during scheduled refresh execution`
      );
    }

    // Check every 30 seconds instead of sleeping for the full interval
    await sleep(30000);
  }
}

async function refreshDepositStrategies(
  rpc: Rpc<SolanaRpcApi>,
  connection: Connection,
  manager: Keypair,
  voltrClient: VoltrClient
) {
  const transactionIxs: TransactionInstruction[] = [];
  const addressLookupTableAddresses: string[] = [];

  const receipts = await Promise.all(
    strategyRegistry.strategies.map((s) =>
      voltrClient
        .fetchStrategyInitReceiptAccount(
          voltrClient.findStrategyInitReceipt(
            toPublicKey(config.voltrVaultAddress),
            toPublicKey(s.address)
          )
        )
        .then((receipt) => ({
          positionValue: receipt.positionValue as BN,
          lastUpdatedTs: receipt.lastUpdatedTs as BN,
        }))
    )
  );

  const cutoffTime = new BN((Date.now() - config.refreshLoopIntervalMs) / 1000);
  const cutOffPositionValue = new BN(config.refreshMinPositionValue);

  for (let i = 0; i < strategyRegistry.strategies.length; i++) {
    const s = strategyRegistry.strategies[i];
    const receipt = receipts[i];

    if (receipt.positionValue.gt(cutOffPositionValue) && receipt.lastUpdatedTs.lt(cutoffTime)) {
      switch (s.type) {
        case "kaminoVault":
          await createDepositKVaultStrategyIx(
            rpc,
            voltrClient,
            s.address,
            toAddress(manager.publicKey),
            new BN(0),
            transactionIxs,
            addressLookupTableAddresses
          );
          break;
        case "kaminoMarket":
          await createDepositKMarketStrategyIx(
            rpc,
            voltrClient,
            s.address,
            toAddress(manager.publicKey),
            new BN(0),
            transactionIxs,
            addressLookupTableAddresses
          );
          break;
        case "jupiterLend":
          await createDepositJLendStrategyIx(
            voltrClient,
            s.address,
            toAddress(manager.publicKey),
            new BN(0),
            transactionIxs,
            addressLookupTableAddresses
          );
          break;
        default:
          logger.warn(`Unknown strategy type "${s.type}" for "${s.id}", skipping refresh`);
          break;
      }
    }
  }

  addressLookupTableAddresses.push(config.voltrLookupTableAddress);

  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    addressLookupTableAddresses,
    rpc
  );

  const investBatchSize = 2;
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
        getConnectionManager().getRpcUrl(),
        manager,
        [],
        addressLookupTableAccounts,
        null,
        "refresh"
      );
      txTotal.inc({ type: "refresh", status: "success" });
      txDurationSeconds.observe({ type: "refresh" }, (Date.now() - txStart) / 1000);
      logger.info(`Refresh strategy confirmed with signature: ${txSig}`);
    } catch (error) {
      txTotal.inc({ type: "refresh", status: "error" });
      throw error;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
