/**
 * One-time setup for the strategies that run through our unified adaptor
 * (raRnoKWoRcon9dqxvAhtiPyQHgikpcu1g9tXeb9jPGT, Hubra-labs/hubra-usdc-adaptor).
 *
 * Step 1 (vault admin signs, once per vault): add_adaptor(vault, adaptor).
 *   Voltr then blocks the adaptor for a cooldown: initialize_strategy and
 *   deposit_strategy fail 6010 AdaptorEpochInvalid until the epoch is at least
 *   2 past the one add_adaptor ran in (~2 days).
 * Step 2 (manager signs, per protocol): create the strategy authority's USDC
 *   ATA (Voltr doesn't, and the first deposit needs it) + initialize_strategy
 *   with that protocol's initialize_<p> discriminator.
 *
 * Dry-run by default: simulates every pending step without signatures. Without
 * an admin key, --send prints step 1 as an unsigned tx for the admin wallet.
 *
 * Usage:
 *   ENV_FILE=.env-usdc npx tsx scripts/setup-hubra-adaptor.ts [perena|p0 ...]        # dry-run
 *   ENV_FILE=.env-usdc npx tsx scripts/setup-hubra-adaptor.ts [perena|p0 ...] --send
 *     (ADMIN_SECRET_KEY/PATH for step 1; manager from MANAGER_SECRET_KEY/PATH)
 */
import * as fs from "fs";
import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import bs58 from "bs58";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PERENA_ADAPTOR_PROGRAM_ID as ADAPTOR_PROGRAM_ID,
  PERENA_VAULT,
  USDSTAR_MINT,
  BANKINECO_PROGRAM_ID,
  INITIALIZE_PERENA_DISCRIMINATOR,
} from "../src/lib/perena";
// env (.env + ENV_FILE overrides) is loaded by src/config, imported via these libs
import { INITIALIZE_P0_DISCRIMINATOR, P0_USDC_BANK, p0InitializeRemainingAccounts } from "../src/lib/p0";

interface Protocol {
  strategy: PublicKey;
  discriminator: Buffer;
  remainingAccounts: (strategyAuth: PublicKey) => AccountMeta[];
}

const PROTOCOLS: Record<string, Protocol> = {
  // Strategy id = the Perena USD* vault account; creates the USD* share ATA.
  perena: {
    strategy: PERENA_VAULT,
    discriminator: INITIALIZE_PERENA_DISCRIMINATOR,
    remainingAccounts: (auth) => [
      { pubkey: BANKINECO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PERENA_VAULT, isSigner: false, isWritable: false },
      { pubkey: USDSTAR_MINT, isSigner: false, isWritable: false },
      { pubkey: getAssociatedTokenAddressSync(USDSTAR_MINT, auth, true, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  },
  // Strategy id = the marginfi USDC bank; creates the marginfi account PDA.
  p0: {
    strategy: P0_USDC_BANK,
    discriminator: INITIALIZE_P0_DISCRIMINATOR,
    remainingAccounts: p0InitializeRemainingAccounts,
  },
};

function loadKeypair(env: string, pathEnv: string): Keypair | null {
  const p = process.env[pathEnv];
  if (p) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
  const k = process.env[env];
  if (!k) return null;
  return Keypair.fromSecretKey(k.trim().startsWith("[") ? Uint8Array.from(JSON.parse(k)) : bs58.decode(k.trim()));
}

async function simulate(connection: Connection, payer: PublicKey, ixs: TransactionInstruction[]): Promise<string | null> {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const sim = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  if (!sim.value.err) return null;
  const err = JSON.stringify(sim.value.err);
  const hint = err.includes("6010")
    ? " — adaptor cooldown: wait until epoch >= add_adaptor epoch + 2"
    : err.includes("6016")
      ? " — adaptor not allowed for this vault"
      : "";
  const logs = sim.value.logs?.filter((l) => /AnchorError|failed|Error/.test(l)).join("\n  ") ?? "";
  return `${err}${hint}\n  ${logs}`;
}

const main = async () => {
  const send = process.argv.includes("--send");
  const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const n of names) if (!PROTOCOLS[n]) throw new Error(`unknown protocol ${n} (have: ${Object.keys(PROTOCOLS).join(", ")})`);
  const selected = names.length ? names : Object.keys(PROTOCOLS);

  const vault = new PublicKey(process.env.VOLTR_VAULT_ADDRESS!);
  const assetMint = new PublicKey(process.env.ASSET_MINT_ADDRESS!);
  const connection = new Connection(process.env.RPC_URL!, "confirmed");
  const client = new VoltrClient(connection);
  const { admin, manager } = await client.fetchVaultAccount(vault);
  const { epoch } = await connection.getEpochInfo();
  console.log(`mode: ${send ? "SEND" : "dry-run (pass --send to submit)"}   epoch: ${epoch}`);
  console.log("vault:", vault.toBase58(), " admin:", admin.toBase58(), " manager:", manager.toBase58());

  // -- step 1: add the adaptor to the vault (admin, once for every protocol)
  const [adaptorAddReceipt] = PublicKey.findProgramAddressSync(
    [Buffer.from("adaptor_add_receipt"), vault.toBuffer(), ADAPTOR_PROGRAM_ID.toBuffer()],
    client.vaultProgram.programId
  );
  const receipt = await connection.getAccountInfo(adaptorAddReceipt);
  if (receipt) {
    // last_updated_epoch is at byte 88 on-chain (the 1.0.x SDK IDL misplaces it).
    const addedEpoch = Number(receipt.data.readBigUInt64LE(88));
    const usableFrom = addedEpoch === 0 ? 0 : addedEpoch + 2;
    console.log(`add_adaptor: done (epoch ${addedEpoch}); usable from epoch ${usableFrom}${epoch < usableFrom ? ` — ${usableFrom - epoch} epoch(s) to go` : ""}`);
  } else {
    const addIx = await client.createAddAdaptorIx({ vault, payer: admin, admin, adaptorProgram: ADAPTOR_PROGRAM_ID });
    const simErr = await simulate(connection, admin, [addIx]);
    if (simErr) throw new Error(`add_adaptor simulation failed: ${simErr}`);
    console.log("add_adaptor: simulation OK");
    if (send) {
      const adminKp = loadKeypair("ADMIN_SECRET_KEY", "ADMIN_SECRET_PATH");
      if (adminKp) {
        if (!adminKp.publicKey.equals(admin)) throw new Error(`admin key ${adminKp.publicKey.toBase58()} != vault admin`);
        console.log("add_adaptor:", await sendAndConfirmTransaction(connection, new Transaction().add(addIx), [adminKp]));
      } else {
        const tx = new Transaction().add(addIx);
        tx.feePayer = admin;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        console.log("no ADMIN_SECRET_KEY/PATH — sign this with the admin wallet (blockhash expires in ~1 min, re-run right before signing):");
        console.log("unsigned tx (base58):\n" + bs58.encode(raw));
        console.log("unsigned tx (base64):\n" + raw.toString("base64"));
      }
    }
    console.log(`strategies become usable from epoch ${epoch + 2} (~2 days); re-run then for step 2`);
    return;
  }

  // -- step 2: per protocol, strategy USDC ATA + initialize_strategy (manager)
  const managerKp = send ? loadKeypair("MANAGER_SECRET_KEY", "MANAGER_SECRET_PATH") : null;
  if (send && !managerKp) throw new Error("set MANAGER_SECRET_KEY or MANAGER_SECRET_PATH");
  if (managerKp && !managerKp.publicKey.equals(manager)) throw new Error(`manager key ${managerKp.publicKey.toBase58()} != vault manager`);

  for (const name of selected) {
    const p = PROTOCOLS[name];
    if (await connection.getAccountInfo(client.findStrategyInitReceipt(vault, p.strategy))) {
      console.log(`${name}: already initialized (strategy ${p.strategy.toBase58()})`);
      continue;
    }
    const { vaultStrategyAuth } = client.findVaultStrategyAddresses(vault, p.strategy);
    const assetAta = getAssociatedTokenAddressSync(assetMint, vaultStrategyAuth, true, TOKEN_PROGRAM_ID);
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(manager, assetAta, vaultStrategyAuth, assetMint, TOKEN_PROGRAM_ID),
      await client.createInitializeStrategyIx(
        { instructionDiscriminator: p.discriminator, additionalArgs: null },
        {
          payer: manager,
          vault,
          manager,
          strategy: p.strategy,
          adaptorProgram: ADAPTOR_PROGRAM_ID,
          remainingAccounts: p.remainingAccounts(vaultStrategyAuth),
        }
      ),
    ];
    const simErr = await simulate(connection, manager, ixs);
    if (simErr) {
      console.error(`${name}: simulation failed: ${simErr}`);
      continue;
    }
    if (!managerKp) {
      console.log(`${name}: asset ATA + initialize_strategy simulation OK`);
      continue;
    }
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [managerKp]);
    console.log(`${name}: initialized (strategy ${p.strategy.toBase58()}, asset ATA ${assetAta.toBase58()}): ${sig}`);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
