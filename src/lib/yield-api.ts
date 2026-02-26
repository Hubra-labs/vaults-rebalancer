import { config } from "../config";
import { logger } from "./utils";
import { workerMetrics } from "./metrics-bridge";
import { StrategyConfig, strategyRegistry } from "./strategy-config";

const YIELD_MARKETS_URL = config.yieldMarketsUrl;

/**
 * Hubra Playbook API response format.
 * Returns the best yield opportunity per asset (pre-selected by the API).
 */
export interface YieldMarket {
  id: string;
  depositApy: number;
  totalDepositUsd: number;
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
  additionalData: {
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
  baseDepositApy?: number;
  baseDepositApy30d?: number;
  baseDepositApy90d?: number;
  baseDepositApy180d?: number;
}

export interface MatchedMarket {
  market: YieldMarket;
  strategy: StrategyConfig;
}

/**
 * Fetches the best yield opportunity for a given asset from the Playbook API.
 * The API returns one pre-selected best opportunity per asset.
 */
export async function fetchYieldMarkets(
  assetMint: string
): Promise<YieldMarket[]> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.yieldApiTimeoutMs
  );

  const fetchStart = Date.now();
  try {
    const response = await fetch(YIELD_MARKETS_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Yield API returned ${response.status}`);
    }

    const markets: YieldMarket[] = await response.json();

    if (!Array.isArray(markets)) {
      throw new Error("Invalid API response: expected array");
    }

    // Filter by token address - should return 0 or 1 result
    // since API returns one best opportunity per asset
    const filtered = markets.filter((m) => m.token.address === assetMint);

    workerMetrics.inc("yield_api_calls_total", { status: "success" });
    workerMetrics.observe(
      "yield_api_duration_seconds",
      (Date.now() - fetchStart) / 1000
    );

    logger.debug(
      { total: markets.length, forAsset: filtered.length, assetMint },
      "Fetched best yield opportunity from Playbook API"
    );
    return filtered;
  } catch (error) {
    const status = controller.signal.aborted ? "timeout" : "error";
    workerMetrics.inc("yield_api_calls_total", { status });
    workerMetrics.observe(
      "yield_api_duration_seconds",
      (Date.now() - fetchStart) / 1000
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Matches a yield market to a configured strategy.
 * Since the API returns the best opportunity, we just need to find
 * if we have a matching strategy configured.
 */
export function matchMarketToStrategy(
  market: YieldMarket
): MatchedMarket | null {
  // Match Kamino vaults by vault address
  if (market.additionalData?.vaultAddress) {
    const strategy = strategyRegistry.strategies.find(
      (s) =>
        s.type === "kaminoVault" &&
        s.address === market.additionalData.vaultAddress
    );
    if (strategy) {
      return { market, strategy };
    }
  }

  // Match Jupiter Lend by provider
  if (market.provider.id === "jupiter") {
    const strategy = strategyRegistry.strategies.find(
      (s) => s.type === "jupiterLend"
    );
    if (strategy) {
      return { market, strategy };
    }
  }

  return null;
}

/**
 * Gets the best yield opportunity for an asset and matches it to a strategy.
 * Returns the matched market or null if no matching strategy is configured.
 */
export function selectWinner(
  markets: YieldMarket[]
): MatchedMarket | null {
  if (markets.length === 0) {
    logger.warn("No yield opportunities returned from API");
    return null;
  }

  // API returns best opportunity per asset, so take the first (only) one
  const bestMarket = markets[0];

  const matched = matchMarketToStrategy(bestMarket);
  if (!matched) {
    logger.warn(
      {
        marketId: bestMarket.id,
        vaultAddress: bestMarket.additionalData?.vaultAddress,
        provider: bestMarket.provider.id,
      },
      "Best yield opportunity has no matching strategy configured"
    );
    return null;
  }

  logger.info(
    {
      strategyId: matched.strategy.id,
      marketId: matched.market.id,
      apy: matched.market.depositApy,
      tvl: matched.market.totalDepositUsd,
      provider: matched.market.provider.name,
      token: matched.market.token.symbol,
    },
    "Selected yield winner from Playbook API"
  );

  return matched;
}

/**
 * Returns all configured strategies sorted by their current position value (descending).
 * Used as fallback options when the winner strategy fails.
 */
export function getFallbackStrategies(): StrategyConfig[] {
  return strategyRegistry.strategies.filter(s => s.type !== "idle");
}
