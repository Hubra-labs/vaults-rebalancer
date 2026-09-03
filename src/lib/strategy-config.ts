import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { Address, address } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { JUPITER_LEND_PROGRAM_ID } from "./constants";
import { config } from "../config";
import { toPublicKey } from "./convert";

export type StrategyType = "kaminoVault" | "kaminoMarket" | "jupiterLend";

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

export type KnownStrategyConfig =
  | KaminoVaultStrategyConfig
  | KaminoMarketStrategyConfig
  | JupiterLendStrategyConfig;

export type StrategyConfig = KnownStrategyConfig | BaseStrategyConfig;

export interface StrategyRegistry {
  strategies: StrategyConfig[];
  byId: Map<string, StrategyConfig>;
  kaminoVaults: KaminoVaultStrategyConfig[];
  kaminoMarkets: KaminoMarketStrategyConfig[];
}

export const IDLE_ID = "idle";

function loadStrategyRegistry(): StrategyRegistry {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "strategies.json"), "utf-8")
  );

  const assetSymbol = process.env.ASSET_SYMBOL?.toLowerCase();
  if (assetSymbol) {
    const assetFile = join(process.cwd(), `${assetSymbol}-strategies.json`);
    if (existsSync(assetFile)) {
      const assetRaw = JSON.parse(readFileSync(assetFile, "utf-8"));
      raw.strategies.push(...assetRaw.strategies);
    }
  }

  const jupLendProgram = toPublicKey(JUPITER_LEND_PROGRAM_ID);
  const assetMint = toPublicKey(config.assetMintAddress);

  const strategies: StrategyConfig[] = raw.strategies.map((s: any) => {
    switch (s.type) {
      case "jupiterLend": {
        const [fTokenMint] = PublicKey.findProgramAddressSync(
          [Buffer.from("f_token_mint"), assetMint.toBuffer()],
          jupLendProgram
        );
        const [lending] = PublicKey.findProgramAddressSync(
          [Buffer.from("lending"), assetMint.toBuffer(), fTokenMint.toBuffer()],
          jupLendProgram
        );
        return { id: s.id, type: "jupiterLend", address: address(lending.toBase58()) } as JupiterLendStrategyConfig;
      }
      case "kaminoVault":
        return { id: s.id, type: "kaminoVault", address: address(s.address) } as KaminoVaultStrategyConfig;
      case "kaminoMarket":
        return { id: s.id, type: "kaminoMarket", address: address(s.address) } as KaminoMarketStrategyConfig;
      default:
        return { id: s.id, type: s.type, address: address(s.address) } as BaseStrategyConfig;
    }
  });

  const byId = new Map<string, StrategyConfig>();
  for (const s of strategies) {
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
