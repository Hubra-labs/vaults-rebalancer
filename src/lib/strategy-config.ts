import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { Address, address } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { JUPITER_LEND_PROGRAM_ID } from "./constants";
import { config } from "../config";
import { toPublicKey } from "./convert";

export type StrategyType = "kaminoVault" | "kaminoMarket" | "jupiterLend";

const SUPPORTED_STRATEGY_TYPES: StrategyType[] = [
  "kaminoVault",
  "kaminoMarket",
  "jupiterLend",
];

interface BaseStrategyConfig {
  id: string;
  type: string;
  address: Address;
}

export interface KaminoVaultStrategyConfig extends BaseStrategyConfig {
  type: "kaminoVault";
}

export interface KaminoMarketStrategyConfig extends BaseStrategyConfig {
  type: "kaminoMarket";
}

export interface JupiterLendStrategyConfig extends BaseStrategyConfig {
  type: "jupiterLend";
}

export type StrategyConfig =
  | KaminoVaultStrategyConfig
  | KaminoMarketStrategyConfig
  | JupiterLendStrategyConfig;

export interface StrategyRegistry {
  strategies: StrategyConfig[];
  byId: Map<string, StrategyConfig>;
  kaminoVaults: KaminoVaultStrategyConfig[];
  kaminoMarkets: KaminoMarketStrategyConfig[];
}

export const IDLE_ID = "idle";

const rawStrategySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  address: z.string().optional(),
});

const strategiesFileSchema = z.object({
  strategies: z.array(rawStrategySchema),
});

function failConfig(message: string): never {
  console.error(`\nStrategy config validation failed:\n  ${message}\n`);
  process.exit(1);
}

function parseStrategy(raw: z.infer<typeof rawStrategySchema>): StrategyConfig {
  const jupLendProgram = toPublicKey(JUPITER_LEND_PROGRAM_ID);
  const assetMint = toPublicKey(config.assetMintAddress);

  switch (raw.type) {
    case "jupiterLend": {
      const [fTokenMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("f_token_mint"), assetMint.toBuffer()],
        jupLendProgram
      );
      const [lending] = PublicKey.findProgramAddressSync(
        [Buffer.from("lending"), assetMint.toBuffer(), fTokenMint.toBuffer()],
        jupLendProgram
      );
      return {
        id: raw.id,
        type: "jupiterLend",
        address: address(lending.toBase58()),
      };
    }
    case "kaminoVault":
      if (!raw.address) {
        failConfig(`Strategy "${raw.id}" (kaminoVault) requires an "address" field`);
      }
      return {
        id: raw.id,
        type: "kaminoVault",
        address: address(raw.address),
      };
    case "kaminoMarket":
      if (!raw.address) {
        failConfig(`Strategy "${raw.id}" (kaminoMarket) requires an "address" field`);
      }
      return {
        id: raw.id,
        type: "kaminoMarket",
        address: address(raw.address),
      };
    default:
      failConfig(
        `Unknown strategy type "${raw.type}" for strategy "${raw.id}". ` +
          `Supported types: ${SUPPORTED_STRATEGY_TYPES.join(", ")}`
      );
  }
}

function loadStrategyRegistry(): StrategyRegistry {
  const basePath = join(process.cwd(), "strategies.json");
  const baseParsed = strategiesFileSchema.safeParse(
    JSON.parse(readFileSync(basePath, "utf-8"))
  );
  if (!baseParsed.success) {
    failConfig(`Invalid strategies.json: ${baseParsed.error.message}`);
  }

  const rawStrategies = [...baseParsed.data.strategies];

  const assetSymbol = process.env.ASSET_SYMBOL?.toLowerCase();
  if (assetSymbol) {
    const assetFile = join(process.cwd(), `${assetSymbol}-strategies.json`);
    if (existsSync(assetFile)) {
      const assetParsed = strategiesFileSchema.safeParse(
        JSON.parse(readFileSync(assetFile, "utf-8"))
      );
      if (!assetParsed.success) {
        failConfig(
          `Invalid ${assetSymbol}-strategies.json: ${assetParsed.error.message}`
        );
      }
      rawStrategies.push(...assetParsed.data.strategies);
    }
  }

  const strategies = rawStrategies.map(parseStrategy);

  const byId = new Map<string, StrategyConfig>();
  for (const s of strategies) {
    if (byId.has(s.id)) {
      failConfig(`Duplicate strategy id "${s.id}"`);
    }
    byId.set(s.id, s);
  }

  const kaminoVaults = strategies.filter(
    (s): s is KaminoVaultStrategyConfig => s.type === "kaminoVault"
  );

  const kaminoMarkets = strategies.filter(
    (s): s is KaminoMarketStrategyConfig => s.type === "kaminoMarket"
  );

  return {
    strategies,
    byId,
    kaminoVaults,
    kaminoMarkets,
  };
}

export const strategyRegistry = loadStrategyRegistry();
