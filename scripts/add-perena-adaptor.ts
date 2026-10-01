/**
 * One-time setup for the Perena USD* strategy — run AFTER Voltr has
 * whitelisted our USDC vault for custom adaptors. The adaptor program
 * (raRnoKWoRcon9dqxvAhtiPyQHgikpcu1g9tXeb9jPGT) is already deployed.
 *
 * Step 1 (vault admin signs):  add_adaptor(vault, adaptor_program)
 * Step 2 (manager signs):      initialize_strategy — creates the strategy
 *                              receipt and the strategy authority's USD* ATA.
 *
 * Dry-run by default: simulates both steps without signatures (no keys needed),
 * which also tells you whether Voltr has whitelisted the adaptor yet (6016).
 *
 * Usage:
 *   ENV_FILE=.env-usdc npx tsx scripts/add-perena-adaptor.ts          # dry-run
 *   ENV_FILE=.env-usdc ADMIN_SECRET_PATH=/path/to/admin.json npx tsx scripts/add-perena-adaptor.ts --send
 * The manager key is taken from the usual MANAGER_SECRET_KEY/PATH env.
 */
import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
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
  const send = process.argv.includes("--send");
  const vault = new PublicKey(process.env.VOLTR_VAULT_ADDRESS!);
  const connection = new Connection(process.env.RPC_URL!, "confirmed");
  const client = new VoltrClient(connection);

  const vaultAccount = await client.fetchVaultAccount(vault);
  const admin = vaultAccount.admin;
  const manager = vaultAccount.manager;
  console.log(`mode: ${send ? "SEND" : "dry-run (pass --send to submit)"}`);
  console.log("vault:", vault.toBase58(), " admin:", admin.toBase58(), " manager:", manager.toBase58());

  const [adaptorAddReceipt] = PublicKey.findProgramAddressSync(
    [Buffer.from("adaptor_add_receipt"), vault.toBuffer(), PERENA_ADAPTOR_PROGRAM_ID.toBuffer()],
    client.vaultProgram.programId
  );
  const adaptorAdded = !!(await connection.getAccountInfo(adaptorAddReceipt));
  if (await connection.getAccountInfo(client.findStrategyInitReceipt(vault, PERENA_VAULT))) {
    console.log("Perena strategy already initialized, nothing to do");
    return;
  }

  // -- step 1: add the adaptor to our vault (admin)
  const addIx = await client.createAddAdaptorIx({
    vault,
    payer: admin,
    admin,
    adaptorProgram: PERENA_ADAPTOR_PROGRAM_ID,
  });

  // -- step 2: initialize the strategy (manager). Strategy id = the Perena
  // USD* vault account, mirroring how Kamino strategies use the kvault address.
  const { vaultStrategyAuth } = client.findVaultStrategyAddresses(vault, PERENA_VAULT);
  const shareAta = getAssociatedTokenAddressSync(USDSTAR_MINT, vaultStrategyAuth, true, TOKEN_PROGRAM_ID);

  const initIx = await client.createInitializeStrategyIx(
    { instructionDiscriminator: INITIALIZE_PERENA_DISCRIMINATOR, additionalArgs: null },
    {
      payer: manager,
      vault,
      manager,
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

  if (!send) {
    const ixs = adaptorAdded ? [initIx] : [addIx, initIx];
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: manager, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const sim = await connection.simulateTransaction(new VersionedTransaction(msg), {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (sim.value.err) {
      console.error(sim.value.logs?.filter((l) => /AnchorError|failed/.test(l)).join("\n"));
      const notWhitelisted = JSON.stringify(sim.value.err).includes("6016");
      throw new Error(notWhitelisted ? "Voltr has not whitelisted the adaptor yet (6016)" : `simulation failed: ${JSON.stringify(sim.value.err)}`);
    }
    console.log(`${adaptorAdded ? "" : "add_adaptor + "}initialize_strategy: simulation OK (${sim.value.unitsConsumed} CU)`);
    return;
  }

  if (adaptorAdded) {
    console.log("add_adaptor: already added, skipping (no admin signature needed)");
  } else {
    const adminKp = loadKeypair("ADMIN_SECRET_KEY", "ADMIN_SECRET_PATH");
    if (!adminKp.publicKey.equals(admin)) throw new Error(`admin key ${adminKp.publicKey.toBase58()} != vault admin`);
    const sig1 = await sendAndConfirmTransaction(connection, new Transaction().add(addIx), [adminKp]);
    console.log("add_adaptor:", sig1);
  }

  const managerKp = loadKeypair("MANAGER_SECRET_KEY", "MANAGER_SECRET_PATH");
  if (!managerKp.publicKey.equals(manager)) throw new Error(`manager key ${managerKp.publicKey.toBase58()} != vault manager`);
  const sig2 = await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [managerKp]);
  console.log("initialize_strategy:", sig2);
  console.log("strategy id (Perena vault):", PERENA_VAULT.toBase58());
  console.log("USD* ATA:", shareAta.toBase58());
  console.log("\nNext: add a perena entry to usdc-strategies.json and wire the strategy type into the rebalance loop.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
