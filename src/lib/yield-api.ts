import { config } from "../config";
import { logger } from "./utils";
import { workerMetrics } from "./metrics-bridge";
import { StrategyConfig, strategyRegistry } from "./strategy-config";

const YIELD_MARKETS_URL = config.yieldMarketsUrl;

/**
 * Hubra Playbook API response format
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
  // Optional APY history fields
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
 * Fetches yield markets from the Hubra Playbook API.
 * Filters results by the specified asset mint address.
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

    // Filter by token address
    const filtered = markets.filter((m) => m.token.address === assetMint);

    workerMetrics.inc("yield_api_calls_total", { status: "success" });
    workerMetrics.observe(
      "yield_api_duration_seconds",
      (Date.now() - fetchStart) / 1000
    );

    logger.debug(
      { total: markets.length, forAsset: filtered.length, assetMint },
      "Fetched yield markets from Playbook API"
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

export function matchMarketsToStrategies(
  markets: YieldMarket[]
): MatchedMarket[] {
  const matched: MatchedMarket[] = [];

  for (const market of markets) {
    // Match Kamino vaults by vault address
    if (market.additionalData?.vaultAddress) {
      const strategy = strategyRegistry.strategies.find(
        (s) =>
          s.type === "kaminoVault" &&
          s.address === market.additionalData.vaultAddress
      );
      if (strategy) {
        matched.push({ market, strategy });
        continue;
      }
    }

    // Match Jupiter Lend by provider
    if (market.provider.id === "jupiter") {
      const strategy = strategyRegistry.strategies.find(
        (s) => s.type === "jupiterLend"
      );
      if (strategy) {
        matched.push({ market, strategy });
      }
    }
  }

  return matched;
}

export function filterByTvl(
  markets: MatchedMarket[],
  minUsd: number = config.minTvlUsd
): MatchedMarket[] {
  return markets.filter((m) => m.market.totalDepositUsd >= minUsd);
}

export function checkDilution(
  market: YieldMarket,
  ourDepositUsd: number,
  maxPct: number = config.maxDilutionPct
): boolean {
  const { depositApy, totalDepositUsd } = market;
  const effectiveApy =
    (depositApy * totalDepositUsd) / (totalDepositUsd + ourDepositUsd);
  const dilution = depositApy - effectiveApy;
  return dilution <= maxPct;
}

export function selectWinner(
  markets: MatchedMarket[],
  ourDepositUsd: number
): MatchedMarket | null {
  const tvlFiltered = filterByTvl(markets);
  logger.debug(
    { before: markets.length, after: tvlFiltered.length },
    "TVL filter applied"
  );

  const dilutionFiltered = tvlFiltered.filter((m) =>
    checkDilution(m.market, ourDepositUsd)
  );
  logger.debug(
    { before: tvlFiltered.length, after: dilutionFiltered.length },
    "Dilution filter applied"
  );

  if (dilutionFiltered.length === 0) {
    return null;
  }

  // Sort by APY descending
  dilutionFiltered.sort((a, b) => b.market.depositApy - a.market.depositApy);

  const winner = dilutionFiltered[0];

  logger.info(
    {
      strategyId: winner.strategy.id,
      marketId: winner.market.id,
      apy: winner.market.depositApy,
      tvl: winner.market.totalDepositUsd,
      provider: winner.market.provider.name,
      token: winner.market.token.symbol,
    },
    "Selected yield winner"
  );

  return winner;
}
