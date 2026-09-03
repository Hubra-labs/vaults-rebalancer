import {
  AccountMeta,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Address } from "@solana/kit";
import { config } from "../config";
import { toPublicKey } from "./convert";

// Our Perena adaptor (perena-adaptor/): must be whitelisted by Voltr and added
// to the vault (scripts/add-perena-adaptor.ts) before any of this can execute.
export const PERENA_ADAPTOR_PROGRAM_ID = new PublicKey(
  "FD7kwF7EVkvvySgQdNQAxqxvdfg1EvpgQdkbbWDVFeXK"
);

// Perena bankineco program and the USD* vault account set (mainnet).
export const BANKINECO_PROGRAM_ID = new PublicKey("save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H");
export const USDSTAR_MINT = new PublicKey("star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM");
export const PERENA_VAULT = new PublicKey("ECJGrTZ6QYMEwiEAnL4oReWF126uc22e9Lojy9qyCjHT");
export const PERENA_VAULT_ORACLE = new PublicKey("2YH9QB7qmEBgekeXH4C36L2dwMPfLdoPi5DDxeTi1kyP");
export const PERENA_TRANCHE_STATE = new PublicKey("FbsiAonbNrC3EKWMrZxx9iSc5Q7e7zSAkro4tD8dQQJS");
export const PERENA_FEE_VAULT = new PublicKey("EAf7PeuCxhMN9gEhE1Gagmj28krmu3wEqCLMbqpSTVqg");
export const PERENA_FEE_VAULT_ATA = new PublicKey("CSYjpGjrZZVUDshaCcMZYNB7JNnVHFwNFgzbUeFScSXj");
export const PERENA_VAULT_ASSET_ATA = new PublicKey("EgewZEt58TFvMBKKXpfoCT2Vg7JBUAtXXLdzcgmMvh5U");

// Adaptor anchor discriminators (sha256("global:<name>")[0..8]).
export const INITIALIZE_PERENA_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
export const DEPOSIT_PERENA_DISCRIMINATOR = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
export const WITHDRAW_PERENA_DISCRIMINATOR = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);

// bankineco get_nav (view) discriminator, used to read position value off-chain.
const GET_NAV_DISCRIMINATOR = Buffer.from([200, 89, 76, 53, 215, 218, 63, 21]);

const PERENA_APY_URL = "https://api.perena.org/api/usdstar/apy?period=7d";

/**
 * Perena's withdraw path redeems USD* at slightly under NAV (observed ~8bps
 * fee/spread; the on-chain adaptor grosses requests up by 30bps and clamps to
 * the share balance). For a FULL exit, request at most nav * (1 - this) so the
 * vault-side sweep of `amount` cannot exceed what redemption delivers.
 */
export const PERENA_FULL_EXIT_HAIRCUT_BPS = 15;

function perenaRemainingAccounts(vaultStrategyShareAta: PublicKey): AccountMeta[] {
  return [
    { pubkey: BANKINECO_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PERENA_VAULT, isSigner: false, isWritable: true },
    { pubkey: PERENA_VAULT_ORACLE, isSigner: false, isWritable: false },
    { pubkey: PERENA_TRANCHE_STATE, isSigner: false, isWritable: false },
    { pubkey: USDSTAR_MINT, isSigner: false, isWritable: true },
    { pubkey: PERENA_VAULT_ASSET_ATA, isSigner: false, isWritable: true },
    { pubkey: PERENA_FEE_VAULT, isSigner: false, isWritable: true },
    { pubkey: PERENA_FEE_VAULT_ATA, isSigner: false, isWritable: true },
    { pubkey: vaultStrategyShareAta, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(config.assetTokenProgram), isSigner: false, isWritable: false },
  ];
}

function vaultStrategyShareAta(voltrClient: VoltrClient): PublicKey {
  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    PERENA_VAULT
  );
  return getAssociatedTokenAddressSync(
    USDSTAR_MINT,
    vaultStrategyAuth,
    true,
    toPublicKey(config.assetTokenProgram)
  );
}

export async function createDepositPerenaStrategyIx(
  voltrClient: VoltrClient,
  manager: Address,
  depositAmount: BN,
  transactionIxs: TransactionInstruction[]
): Promise<void> {
  const depositStrategyIx = await voltrClient.createDepositStrategyIx(
    {
      instructionDiscriminator: DEPOSIT_PERENA_DISCRIMINATOR,
      depositAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: PERENA_VAULT,
      remainingAccounts: perenaRemainingAccounts(vaultStrategyShareAta(voltrClient)),
      adaptorProgram: PERENA_ADAPTOR_PROGRAM_ID,
    }
  );
  transactionIxs.push(depositStrategyIx);
}

export async function createWithdrawPerenaStrategyIx(
  voltrClient: VoltrClient,
  manager: Address,
  withdrawAmount: BN,
  transactionIxs: TransactionInstruction[]
): Promise<void> {
  const withdrawStrategyIx = await voltrClient.createWithdrawStrategyIx(
    {
      instructionDiscriminator: WITHDRAW_PERENA_DISCRIMINATOR,
      withdrawAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: PERENA_VAULT,
      remainingAccounts: perenaRemainingAccounts(vaultStrategyShareAta(voltrClient)),
      adaptorProgram: PERENA_ADAPTOR_PROGRAM_ID,
    }
  );
  transactionIxs.push(withdrawStrategyIx);
}

/**
 * Current USD* 7d APY from Perena's public API (fraction, e.g. 0.0895).
 */
export async function getPerenaApy(): Promise<number> {
  const res = await fetch(PERENA_APY_URL);
  if (!res.ok) throw new Error(`Perena APY API returned ${res.status}`);
  const data = (await res.json()) as { apy: number };
  return data.apy / 100;
}

/**
 * Off-chain read of the strategy's position value in USDC units, via a
 * simulated bankineco get_nav on the strategy authority's USD* ATA.
 */
export async function getPerenaPositionValue(
  voltrClient: VoltrClient,
  connection: Connection
): Promise<BN> {
  const shareAta = vaultStrategyShareAta(voltrClient);
  const ix = new TransactionInstruction({
    programId: BANKINECO_PROGRAM_ID,
    keys: [
      { pubkey: PERENA_VAULT, isSigner: false, isWritable: false },
      { pubkey: PERENA_TRANCHE_STATE, isSigner: false, isWritable: false },
      { pubkey: USDSTAR_MINT, isSigner: false, isWritable: false },
      { pubkey: shareAta, isSigner: false, isWritable: false },
    ],
    data: GET_NAV_DISCRIMINATOR,
  });
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: toPublicKey(config.voltrVaultManagerAddress),
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const sim = await connection.simulateTransaction(new VersionedTransaction(msg), {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (sim.value.err || !sim.value.returnData) {
    // A missing ATA (strategy never initialized) reads as zero position.
    return new BN(0);
  }
  const buf = Buffer.from(sim.value.returnData.data[0], "base64");
  return new BN(buf.subarray(0, 8), "le");
}
