import { logger } from "./utils";
import { StrategyConfig, strategyRegistry } from "./strategy-config";
import {
  getLendingOpportunities,
  getOpportunitiesForAsset,
  selectBestOpportunity,
  matchOpportunityToStrategy,
  LendingOpportunity,
  MatchedOpportunity,
  getCacheStatus,
  clearCache,
} from "./lending-playbook";

// Re-export types for backwards compatibility
export type YieldMarket = LendingOpportunity;
export type MatchedMarket = MatchedOpportunity;

/**
 * Fetches yield opportunities for a given asset from the local lending playbook.
 * Uses cached data with 10-minute TTL.
 */
export async function fetchYieldMarkets(assetMint: string): Promise<YieldMarket[]> {
  return getOpportunitiesForAsset(assetMint);
}

/**
 * Matches a yield market to a configured strategy.
 */
export function matchMarketToStrategy(market: YieldMarket): MatchedMarket | null {
  return matchOpportunityToStrategy(market);
}

/**
 * Gets the best yield opportunity for an asset and matches it to a strategy.
 * Returns the matched market or null if no matching strategy is configured.
 */
export function selectWinner(markets: YieldMarket[]): MatchedMarket | null {
  if (markets.length === 0) {
    logger.warn("No yield opportunities provided");
    return null;
  }

  // Markets are already sorted by APY descending
  // Find the first one that matches a configured strategy
  for (const market of markets) {
    const matched = matchMarketToStrategy(market);
    if (matched) {
      logger.info(
        {
          strategyId: matched.strategy.id,
          marketId: matched.opportunity.id,
          apy: matched.opportunity.depositApy,
          tvl: matched.opportunity.totalDepositUsd,
          provider: matched.opportunity.provider.name,
          token: matched.opportunity.token?.symbol,
        },
        "Selected yield winner from lending playbook"
      );
      return matched;
    }
  }

  logger.warn(
    { marketCount: markets.length },
    "No matching strategy found for any opportunity"
  );
  return null;
}

/**
 * Returns all configured strategies sorted by their current position value (descending).
 * Used as fallback options when the winner strategy fails.
 */
export function getFallbackStrategies(): StrategyConfig[] {
  return strategyRegistry.strategies.filter(s => s.type !== "idle");
}

/**
 * Get all lending opportunities (cached)
 */
export async function getAllOpportunities(): Promise<YieldMarket[]> {
  return getLendingOpportunities();
}

/**
 * Get cache status for monitoring
 */
export function getYieldCacheStatus() {
  return getCacheStatus();
}

/**
 * Clear the cache (for testing or forced refresh)
 */
export function clearYieldCache() {
  clearCache();
}
