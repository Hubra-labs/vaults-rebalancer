import {
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { config } from "./config";
import { isShuttingDown, logger, sleep } from "./lib/utils";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
} from "./lib/solana";
import { BN } from "@coral-xyz/anchor";
import {
  address,
} from "@solana/kit";
import { KaminoVault } from "@kamino-finance/klend-sdk";
import {
  createClaimRewardKVaultStrategyIx,
  getKaminoVaultReservesAccountMetas,
} from "./lib/kamino";
import { Farms } from "@kamino-finance/farms-sdk";
import { Decimal } from "decimal.js";
import { getConnectionManager } from "./lib/connection";
import { toAddress, toPublicKey } from "./lib/convert";
import { strategyRegistry } from "./lib/strategy-config";
import { getManagerKeypair } from "./lib/keypair";
import { loopIterationsTotal, loopErrorsTotal, txTotal, txDurationSeconds } from "./lib/metrics";

export async function runClaimKvaultRewardLoop() {
  logger.info("🚀 Starting Claim KVault Reward Bot...");

  const connManager = getConnectionManager();
  const connection = connManager.getConnection();
  const rpc = connManager.getRpc();

  const manager = getManagerKeypair();

  logger.info(
    `[Claim KVault Reward Loop] 🔑 Manager Loaded: ${manager.publicKey.toBase58()}`
  );
  logger.info(
    `[Claim KVault Reward Loop] ⏰ Loop Interval: ${
      config.claimKvaultRewardLoopIntervalMs / 1000
    } seconds`
  );

  // Initialize clients
  const voltrClient = new VoltrClient(connection);

  let lastExecutionTime = 0;
  let loopCount = 0;

  if (strategyRegistry.kaminoVaults.length === 0) {
    logger.info("[Claim KVault Reward Loop] No kaminoVault strategies in registry, skipping loop");
    return;
  }

  // Main scheduled loop
  while (!isShuttingDown()) {
    try {
      const now = Date.now();
      const timeSinceLastExecution = now - lastExecutionTime;

      if (timeSinceLastExecution >= config.claimKvaultRewardLoopIntervalMs) {
        logger.info(
          `[Claim KVault Reward Loop ${loopCount}] 🛠️ Executing scheduled claim reward strategy...`
        );

        for (const kvConfig of strategyRegistry.kaminoVaults) {
          const kaminoVault = new KaminoVault(address(kvConfig.address));
          const vaultState = await kaminoVault.getState(rpc);

          const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
            toPublicKey(config.voltrVaultAddress),
            toPublicKey(kvConfig.address)
          );

          const { vaultReservesAccountMetas, vaultReservesLendingMarkets } =
            await getKaminoVaultReservesAccountMetas(rpc, vaultState);
          const farms = new Farms(rpc);

          const timestamp = Date.now() / 1000;
          const farmsForUser = await farms.getAllFarmsForUser(
            address(vaultStrategyAuth.toBase58()),
            new Decimal(timestamp - 2)
          );

          const farmsForUserArray = Array.from(farmsForUser.entries());

          for (const [_, farmData] of farmsForUserArray) {
            // Only the first reward slot: Voltr's Kamino adaptor always harvests
            // reward index 0 (other slots fail RewardVaultMismatch).
            for (const reward of (farmData.pendingRewards ?? []).slice(0, 1)) {
              const rewardAmount = reward.cumulatedPendingRewards;
              if (rewardAmount.lte(100)) continue;

              // One reward failing (e.g. no Jupiter route for its token) must
              // not block claiming the others.
              try {
                const addressLookupTableAddresses: string[] = [];
                const transactionIxs: TransactionInstruction[] = [];
                await createClaimRewardKVaultStrategyIx(
                  rpc,
                  connection,
                  voltrClient,
                  address(kvConfig.address),
                  farmData.userStateAddress,
                  farmData.farm,
                  reward.rewardTokenMint,
                  reward.rewardTokenProgramId,
                  toAddress(manager.publicKey),
                  new BN(rewardAmount.floor().toString()),
                  vaultReservesAccountMetas,
                  vaultReservesLendingMarkets,
                  transactionIxs,
                  addressLookupTableAddresses
                );

                addressLookupTableAddresses.push(config.voltrLookupTableAddress);

                const addressLookupTableAccounts =
                  await getAddressLookupTableAccounts(
                    addressLookupTableAddresses,
                    rpc
                  );

                const txStart = Date.now();
                const txSig = await sendAndConfirmOptimisedTx(
                  transactionIxs,
                  connManager.getRpcUrl(),
                  manager,
                  [],
                  addressLookupTableAccounts,
                  null,
                  "claim"
                );
                txTotal.inc({ type: "claim_kvault", status: "success" });
                txDurationSeconds.observe({ type: "claim_kvault" }, (Date.now() - txStart) / 1000);

                logger.info(
                  `Claim kvault reward strategy (${kvConfig.id}, ${reward.rewardTokenMint}) confirmed with signature: ${txSig}`
                );
              } catch (error) {
                txTotal.inc({ type: "claim_kvault", status: "error" });
                logger.warn(
                  { err: String(error), strategyId: kvConfig.id, rewardMint: reward.rewardTokenMint },
                  "Skipping kvault reward claim"
                );
              }
            }
          }
        }
        loopIterationsTotal.inc({ loop: "claim_kvault" });
        loopCount++;
        lastExecutionTime = now;
      }
    } catch (error) {
      loopErrorsTotal.inc({ loop: "claim_kvault" });
      logger.error(
        error,
        `[Claim KVault Reward Loop ${loopCount}] ❌ Error during scheduled claim reward execution`
      );
    }

    // Check every 30 seconds instead of sleeping for the full interval
    await sleep(30000);
  }
}
