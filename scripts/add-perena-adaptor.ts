/**
 * One-time setup for the Perena USD* strategy — run AFTER Voltr has
 * whitelisted our adaptor program (FD7kwF7EVkvvySgQdNQAxqxvdfg1EvpgQdkbbWDVFeXK)
 * and the program has been deployed.
 *
 * Step 1 (vault admin signs):  add_adaptor(vault, adaptor_program)
 * Step 2 (manager signs):      initialize_strategy — creates the strategy
 *                              receipt and the strategy authority's USD* ATA.
 *
 * Usage:
 *   ADMIN_SECRET_PATH=/path/to/admin.json npx tsx scripts/add-perena-adaptor.ts
 * The manager key is taken from the usual MANAGER_SECRET_KEY/PATH env
 * (loads .env + .env-usdc the same way the rebalancer does).
 */
import "dotenv/config";
import * as fs from "fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import bs58 from "bs58";
import {
  PERENA_ADAPTOR_PROGRAM_ID,
  PERENA_VAULT,
  USDSTAR_MINT,
  BANKINECO_PROGRAM_ID,
  INITIALIZE_PERENA_DISCRIMINATOR,
} from "../src/lib/perena";
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

function loadKeypair(env: string, pathEnv: string): Keypair {
  const p = process.env[pathEnv];
  if (p) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
  const k = process.env[env];
  if (!k) throw new Error(`set ${env} or ${pathEnv}`);
  return Keypair.fromSecretKey(k.trim().startsWith("[") ? Uint8Array.from(JSON.parse(k)) : bs58.decode(k.trim()));
}

const main = async () => {
  const rpc = process.env.RPC_URL!;
  const vault = new PublicKey(process.env.VOLTR_VAULT_ADDRESS!);
  const connection = new Connection(rpc, "confirmed");
  const client = new VoltrClient(connection);

  const admin = loadKeypair("ADMIN_SECRET_KEY", "ADMIN_SECRET_PATH");
  const manager = loadKeypair("MANAGER_SECRET_KEY", "MANAGER_SECRET_PATH");
  console.log("vault:", vault.toBase58());
  console.log("admin:", admin.publicKey.toBase58(), " manager:", manager.publicKey.toBase58());

  // -- step 1: whitelist the adaptor on our vault (admin)
  const addIx = await client.createAddAdaptorIx({
    vault,
    payer: admin.publicKey,
    admin: admin.publicKey,
    adaptorProgram: PERENA_ADAPTOR_PROGRAM_ID,
  });
  const sig1 = await sendAndConfirmTransaction(connection, new Transaction().add(addIx), [admin]);
  console.log("add_adaptor:", sig1);

  // -- step 2: initialize the strategy (manager). Strategy id = the Perena
  // USD* vault account, mirroring how Kamino strategies use the kvault address.
  const { vaultStrategyAuth } = client.findVaultStrategyAddresses(vault, PERENA_VAULT);
  const shareAta = getAssociatedTokenAddressSync(USDSTAR_MINT, vaultStrategyAuth, true, TOKEN_PROGRAM_ID);

  const initIx = await client.createInitializeStrategyIx(
    { instructionDiscriminator: INITIALIZE_PERENA_DISCRIMINATOR, additionalArgs: null },
    {
      payer: manager.publicKey,
      vault,
      manager: manager.publicKey,
      strategy: PERENA_VAULT,
      adaptorProgram: PERENA_ADAPTOR_PROGRAM_ID,
      remainingAccounts: [
        { pubkey: BANKINECO_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PERENA_VAULT, isSigner: false, isWritable: false },
        { pubkey: USDSTAR_MINT, isSigner: false, isWritable: false },
        { pubkey: shareAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    }
  );
  const sig2 = await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [manager]);
  console.log("initialize_strategy:", sig2);
  console.log("strategy id (Perena vault):", PERENA_VAULT.toBase58());
  console.log("USD* ATA:", shareAta.toBase58());
  console.log("\nNext: add a perena entry to usdc-strategies.json and wire the strategy type into the rebalance loop.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
