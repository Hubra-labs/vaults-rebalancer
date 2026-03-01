import { config } from "../config";
import { logger } from "./utils";
import { workerMetrics } from "./metrics-bridge";
import { StrategyConfig, strategyRegistry } from "./strategy-config";
import { toBase58 } from "./convert";

// Cache configuration
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// In-memory cache for lending opportunities
let opportunitiesCache: CacheEntry<LendingOpportunity[]> | null = null;

/**
 * Lending opportunity from Dialect's yield markets API
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

// Whitelisted providers for lending
const WHITELISTED_PROVIDERS = [
  { name: "kamino", img: "https://raw.githubusercontent.com/block-sync-one/hub-platforms/main/img/kamino.webp" },
  { name: "jupiter", img: "https://imagedelivery.net/C7jfNnfrjpAYWW6YevrFDg/5c23c065-89ef-413b-8deb-6d8c6a849300/public" },
];

// Whitelisted strategy types
const WHITELISTED_STRATEGIES = ["lending", "yield"];

// Stablecoin patterns for asset grouping
const STABLECOIN_PATTERNS = [
  "usd1", "CASH", "USX", "USDG", "EURC", "USDe", "USDH", "UXD",
  "USDT", "USDC", "USDS", "DAI", "BUSD", "TUSD", "FRAX", "LUSD",
  "SUSD", "GUSD", "HUSD", "USDP", "USDN", "USTC", "FDUSD", "PYUSD",
];

// LST tokens for asset grouping
const LST_PATTERNS = [
  "lanternSOL", "bSOL", "bbSOL", "raSOL", "mSOL", "JitoSOL", "PSOL",
  "mpSOL", "goSOL", "chSOL", "MonkeSOL", "sphSOL", "RoXSOL", "bpSOL",
  "memeSOL", "iASOL", "chimpSOL", "sfSOL", "STEAKSOL", "masSOL",
  "adraSOL", "honestSOL", "sctmSOL", "chaosSOL", "dfdvSOL", "JupSOL",
  "banxSOL", "iceSOL", "uptSOL", "definSOL", "pathSOL", "espresSOL",
  "hyloSOL", "superSOL", "proSOL", "bonkSOL", "dSOL", "compassSOL",
  "picoSOL", "clockSOL", "hubSOL", "strongSOL", "stakeSOL", "pumpkinSOL",
  "thugSOL", "wenSOL", "dainSOL", "digitSOL", "dlgtSOL", "dualSOL",
  "haSOL", "hausSOL", "kumaSOL", "nordSOL", "polarSOL", "xSOL",
  "fuseSOL", "apySOL", "lotusSOL", "eonSOL", "gS", "rugSOL", "soulSOL",
  "prgnSOL", "RAD", "LUNA", "lpSOL", "lakeSOL", "badSOL", "lumiSOL",
  "truthSOL", "pawSOL", "cgntSOL", "laineSOL", "vSOL", "dzSOL", "daoSOL",
  "JSOL", "zippySOL", "elSOL", "aeroSOL", "BNSOL", "xandSOL", "raiSOL",
  "mvtSOL", "enderSOL", "charitySOL", "dynoSOL",
];

/**
 * Determine the asset group for a token symbol
 */
function findAssetGroup(symbol: string): string {
  const lowerSymbol = symbol.toLowerCase();
  
  if (symbol === "SOL") return "SOL";
  if (STABLECOIN_PATTERNS.some(pattern => lowerSymbol.includes(pattern.toLowerCase()))) return "stable";
  if (LST_PATTERNS.some(lst => lowerSymbol.includes(lst.toLowerCase()))) return "LSTs";
  if (lowerSymbol.includes("btc")) return "BTC";
  
  return "other";
}

/**
 * Filter duplicates by keeping the highest APY for each token
 */
function filterDuplicatesByHighestApy(opportunities: LendingOpportunity[]): LendingOpportunity[] {
  const assetMap = new Map<string, LendingOpportunity>();

  opportunities.forEach((opportunity) => {
    const assetKey =
      opportunity.token?.address ||
      opportunity.tokenA?.address ||
      opportunity.token?.symbol ||
      opportunity.tokenA?.symbol ||
      opportunity.id;

    if (!assetKey) return;

    const currentApy = opportunity.depositApy || 0;
    const existingOpportunity = assetMap.get(assetKey);

    if (!existingOpportunity || currentApy > (existingOpportunity.depositApy || 0)) {
      assetMap.set(assetKey, opportunity);
    }
  });

  return Array.from(assetMap.values());
}

/**
 * Fetch lending opportunities from Dialect's yield markets API
 */
async function fetchFromDialect(): Promise<LendingOpportunity[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.yieldApiTimeoutMs);

  const fetchStart = Date.now();
  try {
    const response = await fetch(
      "https://markets.dial.to/api/v0/markets?type=yield&provider=kamino,jupiter",
      { signal: controller.signal }
    );

    if (!response.ok) {
      throw new Error(`Dialect API returned ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.markets || !Array.isArray(data.markets)) {
      throw new Error("Invalid API response: expected markets array");
    }

    // Filter and transform opportunities
    const filtered = data.markets
      .filter((item: any) =>
        WHITELISTED_PROVIDERS.some(p => item.id.indexOf(p.name) > -1) &&
        WHITELISTED_STRATEGIES.includes(item.type) &&
        item.actions?.deposit &&
        item.totalDepositUsd &&
        item.totalDepositUsd > config.minTvlUsd &&
        item.depositApy &&
        item.depositApy > 0.001
      )
      .map((item: any): LendingOpportunity => ({
        ...item,
        depositApy: item.depositApy || 0,
        baseDepositApy: item.baseDepositApy || 0,
        rewards: item.rewards
          ?.filter((reward: any) => reward.marketAction === "deposit")
          .map((reward: any) => ({
            ...reward,
            apy: reward.apy || 0,
          })) || [],
        assetGroup: findAssetGroup(
          item?.token?.symbol || item?.tokenA?.symbol || item?.tokenB?.symbol || ""
        ),
      }));

    // Deduplicate by highest APY
    const deduplicated = filterDuplicatesByHighestApy(filtered);
    
    // Sort by APY descending
    const sorted = deduplicated.sort((a, b) => b.depositApy - a.depositApy);

    workerMetrics.inc("yield_api_calls_total", { status: "success" });
    workerMetrics.observe("yield_api_duration_seconds", (Date.now() - fetchStart) / 1000);

    logger.info(
      { total: data.markets.length, filtered: sorted.length },
      "Fetched lending opportunities from Dialect API"
    );

    return sorted;
  } catch (error) {
    const status = controller.signal.aborted ? "timeout" : "error";
    workerMetrics.inc("yield_api_calls_total", { status });
    workerMetrics.observe("yield_api_duration_seconds", (Date.now() - fetchStart) / 1000);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get lending opportunities with caching (10 min TTL)
 */
export async function getLendingOpportunities(): Promise<LendingOpportunity[]> {
  const now = Date.now();

  // Check if cache is valid
  if (opportunitiesCache && (now - opportunitiesCache.timestamp) < CACHE_TTL_MS) {
    logger.debug(
      { cacheAge: Math.round((now - opportunitiesCache.timestamp) / 1000) },
      "Using cached lending opportunities"
    );
    return opportunitiesCache.data;
  }

  // Fetch fresh data
  logger.info("Fetching fresh lending opportunities from Dialect API");
  const opportunities = await fetchFromDialect();

  // Update cache
  opportunitiesCache = {
    data: opportunities,
    timestamp: now,
  };

  return opportunities;
}

/**
 * Get opportunities filtered by asset mint address
 */
export async function getOpportunitiesForAsset(assetMint: string): Promise<LendingOpportunity[]> {
  const opportunities = await getLendingOpportunities();
  
  // Convert assetMint to base58 if it's an Address type
  const mintAddress = typeof assetMint === "string" ? assetMint : toBase58(assetMint);
  
  return opportunities.filter(opp => 
    opp.token?.address === mintAddress || 
    opp.tokenA?.address === mintAddress
  );
}

/**
 * Match an opportunity to a configured strategy
 */
export function matchOpportunityToStrategy(opportunity: LendingOpportunity): MatchedOpportunity | null {
  // Match Kamino vaults by vault address
  if (opportunity.additionalData?.vaultAddress) {
    const strategy = strategyRegistry.strategies.find(
      s => s.type === "kaminoVault" && s.address === opportunity.additionalData?.vaultAddress
    );
    if (strategy) {
      return { market: opportunity, opportunity, strategy };
    }
  }

  // Match Jupiter Lend by provider
  if (opportunity.provider.id === "jupiter") {
    const strategy = strategyRegistry.strategies.find(s => s.type === "jupiterLend");
    if (strategy) {
      return { market: opportunity, opportunity, strategy };
    }
  }

  // Match Kamino markets
  if (opportunity.provider.id === "kamino" && !opportunity.additionalData?.vaultAddress) {
    const strategy = strategyRegistry.strategies.find(s => s.type === "kaminoMarket");
    if (strategy) {
      return { market: opportunity, opportunity, strategy };
    }
  }

  return null;
}

/**
 * Select the best opportunity for an asset that matches a configured strategy
 */
export async function selectBestOpportunity(assetMint: string): Promise<MatchedOpportunity | null> {
  const opportunities = await getOpportunitiesForAsset(assetMint);

  if (opportunities.length === 0) {
    logger.warn({ assetMint }, "No lending opportunities found for asset");
    return null;
  }

  // Opportunities are already sorted by APY descending
  // Find the first one that matches a configured strategy
  for (const opp of opportunities) {
    const matched = matchOpportunityToStrategy(opp);
    if (matched) {
      logger.info(
        {
          strategyId: matched.strategy.id,
          opportunityId: matched.opportunity.id,
          apy: matched.opportunity.depositApy,
          tvl: matched.opportunity.totalDepositUsd,
          provider: matched.opportunity.provider.name,
          token: matched.opportunity.token?.symbol,
        },
        "Selected best lending opportunity"
      );
      return matched;
    }
  }

  logger.warn(
    { assetMint, opportunityCount: opportunities.length },
    "No matching strategy found for any opportunity"
  );
  return null;
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
export function getCacheStatus(): { isCached: boolean; ageMs: number | null; entryCount: number } {
  if (!opportunitiesCache) {
    return { isCached: false, ageMs: null, entryCount: 0 };
  }
  
  return {
    isCached: true,
    ageMs: Date.now() - opportunitiesCache.timestamp,
    entryCount: opportunitiesCache.data.length,
  };
}
