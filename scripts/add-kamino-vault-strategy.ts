/**
 * One-time setup for a new Kamino vault (kvault) strategy on our Voltr vault.
 *
 * Step 1 (vault admin signs, only if missing):  add_adaptor(vault, kamino_adaptor)
 * Step 2 (manager signs):  create the strategy authority's asset + kvault-share
 *                          ATAs, then initialize_strategy (Kamino kvault init).
 *
 * Mirrors the on-chain init tx used for the existing usdc-prime strategy
 * (4LWjx8of6jLbfHaVTe3dW1AjbTVNcdza8nqLAYeJ56nyAZ2ENzAQWr4hvCNkip526R5NUSo4EFdhTy5S8JUeu2XC).
 *
 * Dry-run (simulate only) by default; pass --send to submit.
 *
 * Usage:
 *   ASSET_SYMBOL=USDC npx tsx scripts/add-kamino-vault-strategy.ts <KVAULT_ADDRESS> [--send]
 * Manager key from MANAGER_SECRET_KEY/PATH (.env + .env-<asset>); admin key from
 * ADMIN_SECRET_KEY/PATH, only required when the adaptor is not yet added.
 */
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { KVAULTS_PROGRAM_ID } from "@kamino-finance/klend-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

const KAMINO_ADAPTOR_PROGRAM_ID = new PublicKey("to6Eti9CsC5FGkAtqiPphvKD2hiQiLsS8zWiDBqBPKR");
const INITIALIZE_KVAULT_DISCRIMINATOR = Buffer.from([0x30, 0xbf, 0xa3, 0x2c, 0x47, 0x81, 0x3f, 0xa4]);

const assetSymbol = process.env.ASSET_SYMBOL?.toLowerCase();
if (assetSymbol) loadEnv({ path: `.env-${assetSymbol}`, override: true });

function loadKeypair(env: string, pathEnv: string): Keypair {
  const p = process.env[pathEnv];
  if (p) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
  const k = process.env[env];
  if (!k) throw new Error(`set ${env} or ${pathEnv}`);
  return Keypair.fromSecretKey(k.trim().startsWith("[") ? Uint8Array.from(JSON.parse(k)) : bs58.decode(k.trim()));
}

async function run(connection: Connection, tx: Transaction, signers: Keypair[], label: string, send: boolean) {
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  if (!send) {
    const sim = await connection.simulateTransaction(tx, signers);
    if (sim.value.err) {
      console.error(sim.value.logs?.join("\n"));
      throw new Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}`);
    }
    console.log(`${label}: simulation OK (${sim.value.unitsConsumed} CU)`);
    return;
  }
  const sig = await sendAndConfirmTransaction(connection, tx, signers);
  console.log(`${label}: ${sig}`);
}

const main = async () => {
  const kvaultArg = process.argv[2];
  if (!kvaultArg || kvaultArg.startsWith("--")) throw new Error("usage: add-kamino-vault-strategy.ts <KVAULT_ADDRESS> [--send]");
  const send = process.argv.includes("--send");

  const connection = new Connection(process.env.RPC_URL!, "confirmed");
  const client = new VoltrClient(connection);
  const vault = new PublicKey(process.env.VOLTR_VAULT_ADDRESS!);
  const assetMint = new PublicKey(process.env.ASSET_MINT_ADDRESS!);
  const kvault = new PublicKey(kvaultArg);
  const kvaultsProgram = new PublicKey(KVAULTS_PROGRAM_ID);

  const vaultAccount = await client.fetchVaultAccount(vault);
  const manager = loadKeypair("MANAGER_SECRET_KEY", "MANAGER_SECRET_PATH");
  if (!manager.publicKey.equals(vaultAccount.manager)) {
    throw new Error(`manager key ${manager.publicKey.toBase58()} != vault manager ${vaultAccount.manager.toBase58()}`);
  }

  // Sanity: the kvault must hold our vault's asset.
  const kvaultInfo = await connection.getAccountInfo(kvault);
  if (!kvaultInfo || !kvaultInfo.owner.equals(kvaultsProgram)) throw new Error(`${kvault.toBase58()} is not a Kamino vault`);
  const [sharesMint] = PublicKey.findProgramAddressSync([Buffer.from("shares"), kvault.toBuffer()], kvaultsProgram);
  if (!(await connection.getAccountInfo(sharesMint))) throw new Error(`shares mint ${sharesMint.toBase58()} not found`);
  if (!kvaultInfo.data.includes(assetMint.toBuffer())) {
    throw new Error(`kvault does not hold asset ${assetMint.toBase58()}`);
  }

  console.log(`mode: ${send ? "SEND" : "dry-run (pass --send to submit)"}`);
  console.log("vault:", vault.toBase58(), " manager:", manager.publicKey.toBase58(), " admin:", vaultAccount.admin.toBase58());
  console.log("kvault:", kvault.toBase58(), " shares mint:", sharesMint.toBase58());

  // -- step 1: add the Kamino adaptor if the vault doesn't have it yet (admin)
  const [adaptorAddReceipt] = PublicKey.findProgramAddressSync(
    [Buffer.from("adaptor_add_receipt"), vault.toBuffer(), KAMINO_ADAPTOR_PROGRAM_ID.toBuffer()],
    client.vaultProgram.programId
  );
  if (await connection.getAccountInfo(adaptorAddReceipt)) {
    console.log("add_adaptor: already added, skipping (no admin signature needed)");
  } else {
    const admin = loadKeypair("ADMIN_SECRET_KEY", "ADMIN_SECRET_PATH");
    if (!admin.publicKey.equals(vaultAccount.admin)) {
      throw new Error(`admin key ${admin.publicKey.toBase58()} != vault admin ${vaultAccount.admin.toBase58()}`);
    }
    const addIx = await client.createAddAdaptorIx({
      vault,
      payer: admin.publicKey,
      admin: admin.publicKey,
      adaptorProgram: KAMINO_ADAPTOR_PROGRAM_ID,
    });
    await run(connection, new Transaction().add(addIx), [admin], "add_adaptor", send);
    if (!send) {
      console.log("initialize_strategy: not simulated — it depends on add_adaptor landing first");
      return;
    }
  }

  // -- step 2: initialize the strategy (manager)
  if (await connection.getAccountInfo(client.findStrategyInitReceipt(vault, kvault))) {
    console.log("initialize_strategy: already initialized, nothing to do");
    return;
  }
  const { vaultStrategyAuth } = client.findVaultStrategyAddresses(vault, kvault);
  const assetAta = getAssociatedTokenAddressSync(assetMint, vaultStrategyAuth, true, TOKEN_PROGRAM_ID);
  const sharesAta = getAssociatedTokenAddressSync(sharesMint, vaultStrategyAuth, true, TOKEN_PROGRAM_ID);

  const initIx = await client.createInitializeStrategyIx(
    { instructionDiscriminator: INITIALIZE_KVAULT_DISCRIMINATOR, additionalArgs: null },
    {
      payer: manager.publicKey,
      vault,
      manager: manager.publicKey,
      strategy: kvault,
      adaptorProgram: KAMINO_ADAPTOR_PROGRAM_ID,
      remainingAccounts: [],
    }
  );
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    createAssociatedTokenAccountIdempotentInstruction(manager.publicKey, assetAta, vaultStrategyAuth, assetMint, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(manager.publicKey, sharesAta, vaultStrategyAuth, sharesMint, TOKEN_PROGRAM_ID),
    initIx
  );
  await run(connection, tx, [manager], "initialize_strategy", send);
  console.log("strategy auth:", vaultStrategyAuth.toBase58(), " asset ATA:", assetAta.toBase58(), " shares ATA:", sharesAta.toBase58());
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
