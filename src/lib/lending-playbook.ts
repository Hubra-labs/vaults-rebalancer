import { config } from "../config";
import { logger } from "./utils";
import { StrategyConfig, strategyRegistry } from "./strategy-config";
import { toBase58 } from "./convert";
import { fetchStrategyApys } from "./apy-source";

// APYs are refreshed hourly and served from cache.
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// In-memory cache for lending opportunities
let opportunitiesCache: CacheEntry<LendingOpportunity[]> | null = null;

/**
 * Lending opportunity for a configured strategy (see apy-source.ts)
 */
export interface LendingOpportunity {
  id: string;
  type: string;
  provider: {
    id: string;
    name: string;
    icon?: string;
  };
  token: {
    address: string;
    symbol: string;
    decimals: number;
    icon?: string;
  };
  tokenA?: {
    address: string;
    symbol: string;
    decimals: number;
  };
  tokenB?: {
    address: string;
    symbol: string;
    decimals: number;
  };
  depositApy: number;
  baseDepositApy?: number;
  totalDepositUsd: number;
  actions?: {
    deposit?: boolean;
    withdraw?: boolean;
  };
  rewards?: Array<{
    marketAction: string;
    apy: number;
  }>;
  assetGroup?: string;
  additionalData?: {
    vaultAddress?: string;
    vaultName?: string;
    vaultRiskProfile?: string;
    vaultSlug?: string;
    shareToken?: {
      address: string;
      symbol: string;
      decimals: number;
    };

  };
}

export interface MatchedOpportunity {
  market: LendingOpportunity;  // Named 'market' for backwards compatibility
  opportunity: LendingOpportunity;  // Alias for market
  strategy: StrategyConfig;
}

/**
 * Fetch fresh APYs for our whitelisted strategies and update the cache.
 * On failure the previous snapshot is kept.
 */
export async function refreshLendingOpportunities(): Promise<LendingOpportunity[]> {
  const sorted = (await fetchStrategyApys()).sort((a, b) => b.depositApy - a.depositApy);
  opportunitiesCache = { data: sorted, timestamp: Date.now() };
  return sorted;
}

/**
 * Get lending opportunities from the hourly cache (fetches if empty/expired;
 * falls back to the last snapshot if that fetch fails).
 */
export async function getLendingOpportunities(): Promise<LendingOpportunity[]> {
  if (opportunitiesCache && Date.now() - opportunitiesCache.timestamp < CACHE_TTL_MS) {
    return opportunitiesCache.data;
  }
  try {
    return await refreshLendingOpportunities();
  } catch (error) {
    if (!opportunitiesCache) throw error;
    logger.warn({ err: String(error) }, "APY refresh failed — using last snapshot");
    return opportunitiesCache.data;
  }
}

/**
 * Refresh APYs every hour in the background.
 */
export function startApyRefreshLoop(): void {
  const run = () =>
    refreshLendingOpportunities().catch((error) =>
      logger.error({ err: String(error) }, "Scheduled APY refresh failed")
    );
  run();
  setInterval(run, CACHE_TTL_MS).unref();
}

/**
 * Get opportunities filtered by asset mint address
 */
export async function getOpportunitiesForAsset(assetMint: string): Promise<LendingOpportunity[]> {
  // Convert assetMint to base58 if it's an Address type
  const mintAddress = typeof assetMint === "string" ? assetMint : toBase58(assetMint);
  
  const allOpportunities = await getLendingOpportunities();
  
  // Filter by asset mint address
  const filtered = allOpportunities.filter(opp => 
    opp.token?.address === mintAddress || 
    opp.tokenA?.address === mintAddress ||
    opp.additionalData?.vaultAddress === mintAddress
  );

  logger.debug(
    { 
      assetMint: mintAddress, 
      totalCount: allOpportunities.length,
      filteredCount: filtered.length,
      providers: Array.from(new Set(filtered.map(o => o.provider.name)))
    },
    "Filtered opportunities for asset"
  );

  return filtered;
}

/**
 * Match an opportunity to its configured strategy (apy-source ids are strategy ids)
 */
export function matchOpportunityToStrategy(opportunity: LendingOpportunity): MatchedOpportunity | null {
  const strategy = strategyRegistry.byId.get(opportunity.id);
  return strategy ? { market: opportunity, opportunity, strategy } : null;
}

/**
 * Clear the cache (useful for testing or forced refresh)
 */
export function clearCache(): void {
  opportunitiesCache = null;
  logger.info("Lending opportunities cache cleared");
}

/**
 * Get cache status for monitoring
 */
export function getCacheStatus(): { 
  isCached: boolean; 
  ageMs: number | null; 
  entryCount: number;
} {
  if (!opportunitiesCache) {
    return { isCached: false, ageMs: null, entryCount: 0 };
  }
  
  return {
    isCached: true,
    ageMs: Date.now() - opportunitiesCache.timestamp,
    entryCount: opportunitiesCache.data.length,
  };
}
