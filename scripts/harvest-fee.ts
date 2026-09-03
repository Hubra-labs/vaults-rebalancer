/**
 * One-shot fee harvester for a single Voltr vault.
 *
 * Crystallizes the accrued manager management fee (plus admin + protocol fees)
 * by calling the Voltr `harvest_fee` instruction. The fees are minted as vault
 * LP tokens into the manager / admin / protocol-admin token accounts.
 *
 * This does NOT touch strategy allocations — funds stay wherever they are
 * (e.g. earning yield in Kamino). It only harvests fees, then exits.
 *
 * The vault is selected by the ENV_FILE env var (loaded in config.ts), e.g.
 *   ENV_FILE=.env-usd1 ts-node scripts/harvest-fee.ts
 *
 * Intended to be run on a schedule (hourly cron). See scripts/harvest-fee.sh.
 *
 * Exit code 0 on success, 1 on failure — so cron / systemd can detect errors.
 */
import { TransactionInstruction } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { config } from "../src/config";
import { logger } from "../src/lib/utils";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
} from "../src/lib/solana";
import { getConnectionManager } from "../src/lib/connection";
import { toPublicKey } from "../src/lib/convert";
import { VOLTR_PROTOCOL_ADMIN_ADDRESS } from "../src/lib/constants";
import { getManagerKeypair } from "../src/lib/keypair";

async function main() {
  const connManager = getConnectionManager();
  const connection = connManager.getConnection();
  const rpc = connManager.getRpc();
  const manager = getManagerKeypair();
  const voltrClient = new VoltrClient(connection);

  const vault = toPublicKey(config.voltrVaultAddress);
  const vaultManager = toPublicKey(config.voltrVaultManagerAddress);
  const vaultAdmin = toPublicKey(config.voltrVaultAdminAddress);
  const protocolAdmin = toPublicKey(VOLTR_PROTOCOL_ADMIN_ADDRESS);

  logger.info(
    `[harvest-fee] 🔑 Manager: ${manager.publicKey.toBase58()} | Vault: ${vault.toBase58()}`
  );

  const vaultLpMint = voltrClient.findVaultLpMint(vault);
  const tokenProgram = toPublicKey(config.assetTokenProgram);

  const transactionIxs: TransactionInstruction[] = [];

  // Idempotently create the LP-token accounts the fees are minted into.
  for (const owner of [protocolAdmin, vaultAdmin, vaultManager]) {
    transactionIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        manager.publicKey,
        getAssociatedTokenAddressSync(vaultLpMint, owner, true, tokenProgram),
        owner,
        vaultLpMint
      )
    );
  }

  const harvestFeeIx = await voltrClient.createHarvestFeeIx({
    harvester: manager.publicKey,
    vaultManager,
    vaultAdmin,
    protocolAdmin,
    vault,
  });
  transactionIxs.push(harvestFeeIx);

  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    [config.voltrLookupTableAddress],
    rpc
  );

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    connManager.getRpcUrl(),
    manager,
    [],
    addressLookupTableAccounts,
    null,
    "harvest"
  );

  logger.info(`[harvest-fee] ✅ Harvest fee confirmed: ${txSig}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error, "[harvest-fee] ❌ Harvest failed");
    process.exit(1);
  });
