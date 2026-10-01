import { logger } from "./utils";
import { config } from "../config";
import { StrategyConfig, strategyRegistry } from "./strategy-config";
import {
  getLendingOpportunities,
  getOpportunitiesForAsset,
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
 * Highest-APY market that maps to a strategy we can use: initialized on-chain
 * (`isInitialized`) and above MIN_TVL_USD. Markets are sorted by APY desc.
 */
export function selectWinner(
  markets: YieldMarket[],
  isInitialized: (strategy: StrategyConfig) => boolean = () => true
): MatchedMarket | null {
  for (const market of markets) {
    if (market.totalDepositUsd <= config.minTvlUsd || market.depositApy <= 0.001) continue;
    const matched = matchMarketToStrategy(market);
    if (matched && isInitialized(matched.strategy)) return matched;
  }
  logger.warn({ marketCount: markets.length }, "No eligible strategy found for any opportunity");
  return null;
}

export interface TargetDecision {
  targetId: string;
  targetApy: number | null;
  winner: MatchedMarket;
  currentId: string | null;
  currentApy: number | null;
  switched: boolean;
  reason: string;
}

/**
 * Pick where funds should go. Stays on the current pool (the strategy holding
 * the most funds) unless the winner's APY beats it by MIN_APY_ADVANTAGE, so
 * small APY swings don't trigger full reallocations (and exit fees).
 * New deposits follow the target either way.
 */
export function chooseTarget(
  markets: YieldMarket[],
  currentId: string | null,
  isInitialized: (strategy: StrategyConfig) => boolean = () => true
): TargetDecision | null {
  const winner = selectWinner(markets, isInitialized);
  if (!winner) return null;

  const winnerApy = winner.market.depositApy;
  const currentApy = currentId ? markets.find((m) => m.id === currentId)?.depositApy ?? null : null;
  const decide = (switched: boolean, reason: string): TargetDecision => ({
    targetId: switched ? winner.strategy.id : currentId!,
    targetApy: switched ? winnerApy : currentApy,
    winner,
    currentId,
    currentApy,
    switched,
    reason,
  });

  if (!currentId) return decide(true, "no current position");
  if (currentId === winner.strategy.id) return decide(false, "current is the winner");
  if (!strategyRegistry.byId.has(currentId)) return decide(true, "current strategy not configured");
  // No APY for the current pool (fetch failed): hold rather than move blind
  if (currentApy === null) return decide(false, "current APY unknown — holding");

  const advantage = winnerApy - currentApy;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  if (advantage >= config.minApyAdvantage) {
    return decide(true, `winner beats current by ${pct(advantage)}`);
  }
  return decide(false, `winner only ${pct(advantage)} better (< ${pct(config.minApyAdvantage)}) — holding`);
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
