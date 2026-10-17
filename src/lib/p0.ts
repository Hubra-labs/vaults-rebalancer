import { AccountMeta, Connection, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import { Address } from "@solana/kit";
import { config } from "../config";
import { toPublicKey } from "./convert";
import { PERENA_ADAPTOR_PROGRAM_ID } from "./perena";

// P0 (Project 0, formerly marginfi v2) USDC bank via our unified adaptor
// (perena-adaptor/, src/protocols/p0.rs). Strategy id = the marginfi bank.
export const P0_ADAPTOR_PROGRAM_ID = PERENA_ADAPTOR_PROGRAM_ID;

export const MARGINFI_PROGRAM_ID = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
export const P0_GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
export const P0_USDC_BANK = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
export const P0_USDC_LIQUIDITY_VAULT = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
// Read by marginfi's withdraw health check; it validates it against the bank config.
export const P0_USDC_ORACLE = new PublicKey("6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT");

// Unified adaptor discriminators (sha256("global:<name>")[0..8]).
export const INITIALIZE_P0_DISCRIMINATOR = Buffer.from([50, 253, 153, 132, 220, 23, 28, 4]); // initialize_p0
export const DEPOSIT_P0_DISCRIMINATOR = Buffer.from([192, 236, 248, 144, 61, 138, 223, 49]); // deposit_p0
export const WITHDRAW_P0_DISCRIMINATOR = Buffer.from([131, 206, 124, 155, 30, 95, 86, 185]); // withdraw_p0

// marginfi account layouts (8-byte discriminator included), I80F48 = i128 LE / 2^48.
const BANK_ASSET_SHARE_VALUE = 80;
const BANK_TOTAL_ASSET_SHARES = 272;
const BANK_CACHE_LENDING_RATE = 1380; // u32, APR where u32::MAX = 1000%
const ACCOUNT_BALANCES = 72;
const BALANCE_LEN = 104;
const MAX_BALANCES = 16;
const BALANCE_ASSET_SHARES = 40;

const readI80F48 = (data: Buffer, offset: number): BN =>
  new BN(data.subarray(offset, offset + 16), "le").fromTwos(128);
/** floor(a * b) for two raw I80F48 values. */
const mulI80F48 = (a: BN, b: BN): BN => a.mul(b).shrn(96);

export function findStrategyAuth(voltrClient: VoltrClient, bank: PublicKey = P0_USDC_BANK): PublicKey {
  return voltrClient.findVaultStrategyAddresses(toPublicKey(config.voltrVaultAddress), bank).vaultStrategyAuth;
}

/** The strategy authority's marginfi account PDA (account_index 0, no third-party id). */
export function findMarginfiAccount(strategyAuth: PublicKey): PublicKey {
  const zero = Buffer.alloc(2);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("marginfi_account"), P0_GROUP.toBuffer(), strategyAuth.toBuffer(), zero, zero],
    MARGINFI_PROGRAM_ID
  )[0];
}

export function p0InitializeRemainingAccounts(strategyAuth: PublicKey): AccountMeta[] {
  return [
    { pubkey: MARGINFI_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: P0_GROUP, isSigner: false, isWritable: false },
    { pubkey: P0_USDC_BANK, isSigner: false, isWritable: false },
    { pubkey: findMarginfiAccount(strategyAuth), isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ];
}

function p0OperateRemainingAccounts(strategyAuth: PublicKey): AccountMeta[] {
  const [liquidityVaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), P0_USDC_BANK.toBuffer()],
    MARGINFI_PROGRAM_ID
  );
  return [
    { pubkey: MARGINFI_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: P0_GROUP, isSigner: false, isWritable: false },
    { pubkey: findMarginfiAccount(strategyAuth), isSigner: false, isWritable: true },
    { pubkey: P0_USDC_BANK, isSigner: false, isWritable: true },
    { pubkey: P0_USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
    { pubkey: liquidityVaultAuth, isSigner: false, isWritable: false },
    { pubkey: P0_USDC_ORACLE, isSigner: false, isWritable: false },
  ];
}

export async function createDepositP0StrategyIx(
  voltrClient: VoltrClient,
  manager: Address,
  depositAmount: BN,
  transactionIxs: TransactionInstruction[]
): Promise<void> {
  const depositStrategyIx = await voltrClient.createDepositStrategyIx(
    {
      instructionDiscriminator: DEPOSIT_P0_DISCRIMINATOR,
      depositAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: P0_USDC_BANK,
      remainingAccounts: p0OperateRemainingAccounts(findStrategyAuth(voltrClient)),
      adaptorProgram: P0_ADAPTOR_PROGRAM_ID,
    }
  );
  transactionIxs.push(depositStrategyIx);
}

/**
 * The adaptor withdraws exactly `withdrawAmount`, which marginfi rejects if it
 * exceeds the position, so a full exit must pass getP0PositionValue (never MAX).
 */
export async function createWithdrawP0StrategyIx(
  voltrClient: VoltrClient,
  manager: Address,
  withdrawAmount: BN,
  transactionIxs: TransactionInstruction[]
): Promise<void> {
  const withdrawStrategyIx = await voltrClient.createWithdrawStrategyIx(
    {
      instructionDiscriminator: WITHDRAW_P0_DISCRIMINATOR,
      withdrawAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: P0_USDC_BANK,
      remainingAccounts: p0OperateRemainingAccounts(findStrategyAuth(voltrClient)),
      adaptorProgram: P0_ADAPTOR_PROGRAM_ID,
    }
  );
  transactionIxs.push(withdrawStrategyIx);
}

/**
 * Off-chain read of the strategy's position value in USDC units: asset shares
 * x the bank's asset_share_value as of its last accrual (so it can only be at
 * or below what the adaptor sees on-chain, which accrues first).
 */
export async function getP0PositionValue(voltrClient: VoltrClient, connection: Connection): Promise<BN> {
  const [bank, account] = await connection.getMultipleAccountsInfo([
    P0_USDC_BANK,
    findMarginfiAccount(findStrategyAuth(voltrClient)),
  ]);
  if (!bank) throw new Error("P0 USDC bank not found");
  if (!account) return new BN(0); // strategy never initialized
  return p0PositionValueFromAccounts(bank.data, account.data);
}

/** Position value in P0_USDC_BANK from raw bank + marginfi account data. */
export function p0PositionValueFromAccounts(bankData: Buffer, accountData: Buffer): BN {
  const shareValue = readI80F48(bankData, BANK_ASSET_SHARE_VALUE);
  for (let i = 0; i < MAX_BALANCES; i++) {
    const b = ACCOUNT_BALANCES + i * BALANCE_LEN;
    if (accountData[b] !== 0 && P0_USDC_BANK.equals(new PublicKey(accountData.subarray(b + 1, b + 33)))) {
      return mulI80F48(readI80F48(accountData, b + BALANCE_ASSET_SHARES), shareValue);
    }
  }
  return new BN(0);
}

/**
 * Current deposit APY (spot lending rate from the bank's on-chain cache,
 * compounded per second as marginfi accrues) and total deposits in USDC.
 */
export async function getP0BankApy(connection: Connection): Promise<{ apy: number; totalDepositsUsdc: number }> {
  const bank = await connection.getAccountInfo(P0_USDC_BANK);
  if (!bank) throw new Error("P0 USDC bank not found");
  const apr = (bank.data.readUInt32LE(BANK_CACHE_LENDING_RATE) / 0xffffffff) * 10;
  const secondsPerYear = 31_536_000;
  const deposits = mulI80F48(
    readI80F48(bank.data, BANK_TOTAL_ASSET_SHARES),
    readI80F48(bank.data, BANK_ASSET_SHARE_VALUE)
  );
  return {
    apy: (1 + apr / secondsPerYear) ** secondsPerYear - 1,
    totalDepositsUsdc: Number(deposits.toString()) / 1e6,
  };
}
