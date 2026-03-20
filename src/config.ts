import { config as dotenvConfig } from "dotenv";
import { expand } from "dotenv-expand";
import { Address, address } from "@solana/kit";
import { z } from "zod";

// Load base .env, then layer asset-specific overrides (e.g. ENV_FILE=.env-usdc)
expand(dotenvConfig());
if (process.env.ENV_FILE) {
  expand(dotenvConfig({ path: process.env.ENV_FILE, override: true }));
}

const addressField = z.string().min(1).transform((val) => address(val) as Address);
const optionalString = z.string().optional().transform((v) => v?.trim() || undefined);

const boolFlag = (defaultVal: string) =>
  z
    .string()
    .optional()
    .default(defaultVal)
    .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  // Core
  YIELD_MARKETS_URL: z.string().min(1, "YIELD_MARKETS_URL is required"),
  YIELD_MARKETS_API: z.string().min(1, "YIELD_MARKETS_API is required"),
  RPC_URL: z.string().min(1, "RPC_URL is required"),
  RPC_FALLBACK_URL: optionalString,
  MANAGER_SECRET_PATH: optionalString,
  MANAGER_SECRET_KEY: optionalString,

  // Intervals
  REFRESH_LOOP_INTERVAL_MS: z.coerce.number().default(600000),
  HARVEST_FEE_LOOP_INTERVAL_MS: z.coerce.number().default(1800000),
  REBALANCE_LOOP_INTERVAL_MS: z.coerce.number().default(1800000),
  CLAIM_KVAULT_REWARD_LOOP_INTERVAL_MS: z.coerce.number().default(3600000),
  CLAIM_KMARKET_REWARD_LOOP_INTERVAL_MS: z.coerce.number().default(3600000),
  DEPOSIT_STRATEGY_MIN_AMOUNT: z.coerce.number().default(0),
  JUPITER_SWAP_SLIPPAGE_BPS: z.coerce.number().default(50),
  REFRESH_MIN_POSITION_VALUE: z.coerce.number().default(1_000_000),
  REBALANCE_DEVIATION_BPS: z.coerce.number().default(0),

  // Yield optimization
  MIN_TVL_USD: z.coerce.number().default(500_000),
  MAX_DILUTION_PCT: z.coerce.number().default(0.005),
  YIELD_API_TIMEOUT_MS: z.coerce.number().default(30_000),

  // Worker
  WORKER_MAX_MEMORY_MB: z.coerce.number().default(2048),

  // Health
  HEALTH_SERVER_PORT: z.coerce.number().default(8080),

  // Feature flags
  ENABLE_REBALANCE_LOOP: boolFlag("true"),
  ENABLE_REFRESH_LOOP: boolFlag("true"),
  ENABLE_CLAIM_KVAULT_REWARD_LOOP: boolFlag("false"),
  ENABLE_CLAIM_KMARKET_REWARD_LOOP: boolFlag("true"),
  ENABLE_HARVEST_FEE_LOOP: boolFlag("true"),
  METRICS_ENABLED: boolFlag("true"),

  // Logging
  LOG_LEVEL: z.string().optional().default("info"),

  // On-Chain Addresses (non-strategy)
  VOLTR_VAULT_ADDRESS: addressField,
  VOLTR_VAULT_ADMIN_ADDRESS: addressField,
  VOLTR_VAULT_MANAGER_ADDRESS: addressField,
  ASSET_MINT_ADDRESS: addressField,
  ASSET_TOKEN_PROGRAM: addressField,
  VOLTR_LOOKUP_TABLE_ADDRESS: addressField,
}).refine(
  (data) => data.MANAGER_SECRET_PATH || data.MANAGER_SECRET_KEY,
  { message: "Either MANAGER_SECRET_PATH or MANAGER_SECRET_KEY must be set" }
);

function parseConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    console.error(`\nConfig validation failed:\n${formatted}\n`);
    process.exit(1);
  }
  return result.data;
}

const env = parseConfig();

export const config = {
  yieldMarketsUrl: env.YIELD_MARKETS_URL,
  yieldMarketsApi: env.YIELD_MARKETS_API,
  rpcUrl: env.RPC_URL,
  rpcFallbackUrl: env.RPC_FALLBACK_URL,
  managerSecretPath: env.MANAGER_SECRET_PATH,
  managerSecretKey: env.MANAGER_SECRET_KEY,
  workerMaxMemoryMb: env.WORKER_MAX_MEMORY_MB,
  refreshLoopIntervalMs: env.REFRESH_LOOP_INTERVAL_MS,
  harvestFeeLoopIntervalMs: env.HARVEST_FEE_LOOP_INTERVAL_MS,
  rebalanceLoopIntervalMs: env.REBALANCE_LOOP_INTERVAL_MS,
  claimKvaultRewardLoopIntervalMs: env.CLAIM_KVAULT_REWARD_LOOP_INTERVAL_MS,
  claimKmarketRewardLoopIntervalMs: env.CLAIM_KMARKET_REWARD_LOOP_INTERVAL_MS,
  depositStrategyMinAmount: env.DEPOSIT_STRATEGY_MIN_AMOUNT,
  jupiterSwapSlippageBps: env.JUPITER_SWAP_SLIPPAGE_BPS,
  refreshMinPositionValue: env.REFRESH_MIN_POSITION_VALUE,
  rebalanceDeviationBps: env.REBALANCE_DEVIATION_BPS,
  minTvlUsd: env.MIN_TVL_USD,
  maxDilutionPct: env.MAX_DILUTION_PCT,
  yieldApiTimeoutMs: env.YIELD_API_TIMEOUT_MS,
  healthServerPort: env.HEALTH_SERVER_PORT,
  logLevel: env.LOG_LEVEL,

  // Feature flags
  enableRebalanceLoop: env.ENABLE_REBALANCE_LOOP,
  enableRefreshLoop: env.ENABLE_REFRESH_LOOP,
  enableClaimKvaultRewardLoop: env.ENABLE_CLAIM_KVAULT_REWARD_LOOP,
  enableClaimKmarketRewardLoop: env.ENABLE_CLAIM_KMARKET_REWARD_LOOP,
  enableHarvestFeeLoop: env.ENABLE_HARVEST_FEE_LOOP,
  metricsEnabled: env.METRICS_ENABLED,

  // On-Chain Addresses
  voltrVaultAddress: env.VOLTR_VAULT_ADDRESS,
  voltrVaultAdminAddress: env.VOLTR_VAULT_ADMIN_ADDRESS,
  voltrVaultManagerAddress: env.VOLTR_VAULT_MANAGER_ADDRESS,
  assetMintAddress: env.ASSET_MINT_ADDRESS,
  assetTokenProgram: env.ASSET_TOKEN_PROGRAM,
  voltrLookupTableAddress: env.VOLTR_LOOKUP_TABLE_ADDRESS,
};
