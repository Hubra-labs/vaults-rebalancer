import {
  AccountMeta,
  Connection,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import { config } from "../config";
import {
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Address, address, getProgramDerivedAddress } from "@solana/kit";
import {
  DEPOSIT_JLEND_DISCRIMINATOR,
  WITHDRAW_JLEND_DISCRIMINATOR,
  JUPITER_ADAPTOR_PROGRAM_ID,
  JUPITER_LEND_PROGRAM_ID,
  JUPITER_LIQUIDITY_PROGRAM_ID,
  JUPITER_REWARDS_RATE_PROGRAM_ID,
} from "./constants";
import { getLendingTokenDetails } from "@jup-ag/lend/earn";
import { logger } from "./utils";
import {
  toPublicKey,
  SYSTEM_PROGRAM_ADDR,
  ASSOCIATED_TOKEN_PROGRAM_ADDR,
  TOKEN_PROGRAM_ADDR,
} from "./convert";

const JUP_ENDPOINT = "https://lite-api.jup.ag/swap/v1";

export async function getJupiterLendApyAndDeposits(
  asset: Address,
  connection: Connection
) {
  const [lendingTokenAddr] = await getProgramDerivedAddress({
    seeds: [Buffer.from("f_token_mint"), toPublicKey(asset).toBuffer()],
    programAddress: JUPITER_LEND_PROGRAM_ID,
  });

  const tokenDetails = await getLendingTokenDetails({
    lendingToken: toPublicKey(lendingTokenAddr),
    connection,
  });

  return {
    apy:
      (tokenDetails.rewardsRate.toNumber() +
        tokenDetails.supplyRate.toNumber()) /
      10_000,
    deposits: tokenDetails.totalAssets,
  };
}

export async function setupJupiterSwap(
  swapAmount: BN,
  vaultStrategyAuth: Address,
  inputMintAddress: Address,
  outputMintAddress: Address,
  slippageBps: number = config.jupiterSwapSlippageBps,
  maxAccounts: number = 18
): Promise<{
  jupiterSwapAddressLookupTableAddresses: string[];
  jupiterSwapData: Buffer;
  jupiterSwapAccountMetas: AccountMeta[];
}> {
  if (inputMintAddress === outputMintAddress) {
    return {
      jupiterSwapAddressLookupTableAddresses: [],
      jupiterSwapData: Buffer.from([]),
      jupiterSwapAccountMetas: [],
    };
  }
  try {
    // Get Jupiter quote
    const jupQuoteResponse = await (
      await fetch(
        `${JUP_ENDPOINT}/quote?inputMint=` +
        `${inputMintAddress}` +
        `&outputMint=` +
        `${outputMintAddress}` +
        `&amount=` +
        `${swapAmount.toString()}` +
        `&slippageBps=` +
        `${slippageBps}` +
        `&maxAccounts=` +
        `${maxAccounts}`
      )
    ).json();

    // Get Jupiter swap instructions
    const instructions = await (
      await fetch(`${JUP_ENDPOINT}/swap-instructions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quoteResponse: jupQuoteResponse,
          userPublicKey: vaultStrategyAuth,
        }),
      })
    ).json();

    if (instructions.error) {
      throw new Error("Failed to get swap instructions: " + instructions.error);
    }

    // tokenLedgerInstruction is only present in withdrawals
    const {
      swapInstruction: swapInstructionPayload,
      addressLookupTableAddresses: jupiterSwapAddressLookupTableAddresses,
    } = instructions;

    const jupiterSwapAccountMetas = [
      {
        pubkey: toPublicKey(address(swapInstructionPayload.programId)),
        isSigner: false,
        isWritable: false,
      },
      ...swapInstructionPayload.accounts.map((key: any) => ({
        pubkey: toPublicKey(address(key.pubkey)),
        isSigner: false,
        isWritable: key.isWritable,
      })),
    ];

    const jupiterSwapData = Buffer.from(swapInstructionPayload.data, "base64");

    return {
      jupiterSwapAddressLookupTableAddresses,
      jupiterSwapData,
      jupiterSwapAccountMetas,
    };
  } catch (error) {
    logger.error({ err: error }, "Error setting up Jupiter swap");
    throw error;
  }
}

export async function createDepositJLendStrategyIx(
  voltrClient: VoltrClient,
  lending: Address,
  manager: Address,
  depositAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  const [fTokenMint] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("f_token_mint"),
      toPublicKey(config.assetMintAddress).toBuffer(),
    ],
    programAddress: JUPITER_LEND_PROGRAM_ID,
  });

  const [lendingAdmin] = await getProgramDerivedAddress({
    seeds: [Buffer.from("lending_admin")],
    programAddress: JUPITER_LEND_PROGRAM_ID,
  });

  const [supplyTokenReservesLiquidity] = await getProgramDerivedAddress({
    seeds: [Buffer.from("reserve"), toPublicKey(config.assetMintAddress).toBuffer()],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const [rateModel] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("rate_model"),
      toPublicKey(config.assetMintAddress).toBuffer(),
    ],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const [liquidity] = await getProgramDerivedAddress({
    seeds: [Buffer.from("liquidity")],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const [rewardsRateModel] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("lending_rewards_rate_model"),
      toPublicKey(config.assetMintAddress).toBuffer(),
    ],
    programAddress: JUPITER_REWARDS_RATE_PROGRAM_ID,
  });

  const [lendingSupplyPositionOnLiquidity] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("user_supply_position"),
      toPublicKey(config.assetMintAddress).toBuffer(),
      toPublicKey(lending).toBuffer(),
    ],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    toPublicKey(lending)
  );

  const vaultStrategyFTokenAta = getAssociatedTokenAddressSync(
    toPublicKey(fTokenMint),
    vaultStrategyAuth,
    true,
    toPublicKey(config.assetTokenProgram)
  );

  const jVault = getAssociatedTokenAddressSync(
    toPublicKey(config.assetMintAddress),
    toPublicKey(liquidity),
    true,
    toPublicKey(config.assetTokenProgram)
  );

  const remainingAccounts: AccountMeta[] = [
    { pubkey: toPublicKey(lending), isSigner: false, isWritable: true },
    { pubkey: vaultStrategyFTokenAta, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(lendingAdmin), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(fTokenMint), isSigner: false, isWritable: true },
    { pubkey: toPublicKey(supplyTokenReservesLiquidity), isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(lendingSupplyPositionOnLiquidity),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: toPublicKey(rateModel), isSigner: false, isWritable: false },
    { pubkey: jVault, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(liquidity), isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(JUPITER_LIQUIDITY_PROGRAM_ID),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: toPublicKey(rewardsRateModel), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(ASSOCIATED_TOKEN_PROGRAM_ADDR), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(SYSTEM_PROGRAM_ADDR), isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(JUPITER_LEND_PROGRAM_ID),
      isSigner: false,
      isWritable: true,
    },
  ];

  const depositStrategyIx = await voltrClient.createDepositStrategyIx(
    {
      instructionDiscriminator: DEPOSIT_JLEND_DISCRIMINATOR,
      depositAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: toPublicKey(lending),
      remainingAccounts,
      adaptorProgram: toPublicKey(JUPITER_ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(depositStrategyIx);
  return {
    transactionIxs,
    addressLookupTableAddresses,
  };
}

export async function createWithdrawJLendStrategyIx(
  voltrClient: VoltrClient,
  lending: Address,
  manager: Address,
  withdrawAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  const [fTokenMint] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("f_token_mint"),
      toPublicKey(config.assetMintAddress).toBuffer(),
    ],
    programAddress: JUPITER_LEND_PROGRAM_ID,
  });

  const [lendingAdmin] = await getProgramDerivedAddress({
    seeds: [Buffer.from("lending_admin")],
    programAddress: JUPITER_LEND_PROGRAM_ID,
  });

  const [supplyTokenReservesLiquidity] = await getProgramDerivedAddress({
    seeds: [Buffer.from("reserve"), toPublicKey(config.assetMintAddress).toBuffer()],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const [rateModel] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("rate_model"),
      toPublicKey(config.assetMintAddress).toBuffer(),
    ],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const [userClaim] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("user_claim"),
      toPublicKey(lendingAdmin).toBuffer(),
      toPublicKey(config.assetMintAddress).toBuffer(),
    ],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const [liquidity] = await getProgramDerivedAddress({
    seeds: [Buffer.from("liquidity")],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const [rewardsRateModel] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("lending_rewards_rate_model"),
      toPublicKey(config.assetMintAddress).toBuffer(),
    ],
    programAddress: JUPITER_REWARDS_RATE_PROGRAM_ID,
  });

  const [lendingSupplyPositionOnLiquidity] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("user_supply_position"),
      toPublicKey(config.assetMintAddress).toBuffer(),
      toPublicKey(lending).toBuffer(),
    ],
    programAddress: JUPITER_LIQUIDITY_PROGRAM_ID,
  });

  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    toPublicKey(lending)
  );

  const vaultStrategyFTokenAta = getAssociatedTokenAddressSync(
    toPublicKey(fTokenMint),
    vaultStrategyAuth,
    true,
    toPublicKey(config.assetTokenProgram)
  );

  const jVault = getAssociatedTokenAddressSync(
    toPublicKey(config.assetMintAddress),
    toPublicKey(liquidity),
    true,
    toPublicKey(config.assetTokenProgram)
  );

  const remainingAccounts: AccountMeta[] = [
    { pubkey: toPublicKey(lending), isSigner: false, isWritable: true },
    { pubkey: vaultStrategyFTokenAta, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(lendingAdmin), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(fTokenMint), isSigner: false, isWritable: true },
    { pubkey: toPublicKey(supplyTokenReservesLiquidity), isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(lendingSupplyPositionOnLiquidity),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: toPublicKey(rateModel), isSigner: false, isWritable: false },
    { pubkey: jVault, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(userClaim), isSigner: false, isWritable: true },
    { pubkey: toPublicKey(liquidity), isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(JUPITER_LIQUIDITY_PROGRAM_ID),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: toPublicKey(rewardsRateModel), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(ASSOCIATED_TOKEN_PROGRAM_ADDR), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(SYSTEM_PROGRAM_ADDR), isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(JUPITER_LEND_PROGRAM_ID),
      isSigner: false,
      isWritable: true,
    },
  ];

  const withdrawStrategyIx = await voltrClient.createWithdrawStrategyIx(
    {
      instructionDiscriminator: WITHDRAW_JLEND_DISCRIMINATOR,
      withdrawAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: toPublicKey(lending),
      remainingAccounts,
      adaptorProgram: toPublicKey(JUPITER_ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(withdrawStrategyIx);
  return {
    transactionIxs,
    addressLookupTableAddresses,
  };
}
