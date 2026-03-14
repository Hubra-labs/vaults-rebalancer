import { logger } from "./utils";
import { workerMetrics } from "./metrics-bridge";
import { LendingOpportunity } from "./lending-playbook";

// Drift API URLs
const CONFIGS_URL = "https://drift-public.s3.eu-central-1.amazonaws.com/vaults/configs.json";
const APYS_URL = "https://app.drift.trade/api/vaults";

// Cache configuration
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// In-memory cache for drift vault opportunities
let driftOpportunitiesCache: CacheEntry<LendingOpportunity[]> | null = null;

/**
 * Drift vault configuration from configs endpoint
 */
interface DriftVaultConfig {
  name: string;
  vaultPubkeyString: string;
  strategy?: string;
  tokenMint?: string;
  symbol?: string;
  decimals?: number;
  [key: string]: any;
}

/**
 * Drift vault APY data from APYs endpoint
 */
interface DriftVaultAPYData {
  apys: {
    "1d": number;
    "7d": number;
    "30d": number;
    "4d"?: number; // Primary metric we'll use
    [key: string]: number | undefined;
  };
  totalDeposits?: number;
  [key: string]: any;
}

/**
 * Fetch Drift vault configurations
 */
async function fetchDriftConfigs(): Promise<DriftVaultConfig[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const response = await fetch(CONFIGS_URL, { signal: controller.signal });
    
    if (!response.ok) {
      throw new Error(`Drift configs API returned ${response.status} ${response.statusText}`);
    }

    const configs = await response.json();
    
    if (!Array.isArray(configs)) {
      throw new Error("Invalid Drift configs response: expected array");
    }

    logger.debug({ configCount: configs.length }, "Fetched Drift vault configs");
    return configs;
  } catch (error) {
    logger.error({ error }, "Failed to fetch Drift vault configs");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch Drift vault APY data
 */
async function fetchDriftAPYs(): Promise<Record<string, DriftVaultAPYData>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const response = await fetch(APYS_URL, { signal: controller.signal });
    
    if (!response.ok) {
      throw new Error(`Drift APYs API returned ${response.status} ${response.statusText}`);
    }

    const apys = await response.json();
    
    if (!apys || typeof apys !== "object") {
      throw new Error("Invalid Drift APYs response: expected object");
    }

    logger.debug({ vaultCount: Object.keys(apys).length }, "Fetched Drift vault APYs");
    return apys;
  } catch (error) {
    logger.error({ error }, "Failed to fetch Drift vault APYs");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Determine asset group for a Drift vault symbol
 */
function getDriftAssetGroup(symbol: string): string {
  const lowerSymbol = symbol.toLowerCase();
  
  if (symbol === "SOL") return "SOL";
  
  // Stablecoin patterns
  const stablePatterns = [
    "usd", "usdc", "usdt", "usds", "dai", "busd", "tusd", "frax", "lusd"
  ];
  if (stablePatterns.some(pattern => lowerSymbol.includes(pattern))) {
    return "stable";
  }
  
  // LST patterns 
  if (lowerSymbol.includes("sol") && lowerSymbol !== "sol") {
    return "LSTs";
  }
  
  // BTC patterns
  if (lowerSymbol.includes("btc")) {
    return "BTC";
  }
  
  return "other";
}

/**
 * Convert Drift vault data to LendingOpportunity format
 */
function convertDriftToLendingOpportunity(
  config: DriftVaultConfig, 
  apyData: DriftVaultAPYData
): LendingOpportunity {
  // Use 4d APY if available, fallback to 7d, then 1d
  const apy = apyData.apys["4d"] || apyData.apys["7d"] || apyData.apys["1d"] || 0;
  
  // Convert APY from decimal to percentage (e.g., 0.055 -> 5.5)
  const depositApy = apy * 100;
  
  return {
    id: `drift-vault-${config.vaultPubkeyString}`,
    type: "yield",
    provider: {
      id: "drift",
      name: "Drift",
      icon: "https://app.drift.trade/icons/drift-logo.png"
    },
    token: {
      address: config.tokenMint || config.vaultPubkeyString,
      symbol: config.symbol || config.name,
      decimals: config.decimals || 9
    },
    depositApy,
    baseDepositApy: depositApy, // No additional rewards breakdown available
    totalDepositUsd: apyData.totalDeposits || 0,
    actions: {
      deposit: true,
      withdraw: true
    },
    rewards: [],
    assetGroup: getDriftAssetGroup(config.symbol || config.name),
    additionalData: {
      vaultAddress: config.vaultPubkeyString,
      vaultName: config.name,
      vaultRiskProfile: "medium", // Default risk profile
      vaultSlug: config.name.toLowerCase().replace(/\s+/g, "-"),
      shareToken: {
        address: config.vaultPubkeyString,
        symbol: `d${config.symbol || config.name}`,
        decimals: config.decimals || 9
      },
      driftMetrics: {
        "1d": apyData.apys["1d"],
        "4d": apyData.apys["4d"],
        "7d": apyData.apys["7d"],
        "30d": apyData.apys["30d"]
      }
    }
  };
}

/**
 * Fetch Drift vault opportunities with error handling and metrics
 */
async function fetchDriftVaultOpportunities(): Promise<LendingOpportunity[]> {
  const fetchStart = Date.now();
  
  try {
    // Fetch both configs and APYs in parallel
    const [configs, apys] = await Promise.all([
      fetchDriftConfigs(),
      fetchDriftAPYs()
    ]);

    const opportunities: LendingOpportunity[] = [];
    
    for (const config of configs) {
      const apyData = apys[config.vaultPubkeyString];
      
      if (!apyData) {
        logger.debug(
          { vaultPubkey: config.vaultPubkeyString, name: config.name },
          "No APY data found for Drift vault"
        );
        continue;
      }

      // Skip vaults with no meaningful APY data
      const apy = apyData.apys["4d"] || apyData.apys["7d"] || apyData.apys["1d"];
      if (!apy || apy <= 0) {
        logger.debug(
          { vaultPubkey: config.vaultPubkeyString, name: config.name },
          "Skipping Drift vault with zero/invalid APY"
        );
        continue;
      }

      try {
        const opportunity = convertDriftToLendingOpportunity(config, apyData);
        opportunities.push(opportunity);
        
        logger.debug(
          { 
            vaultName: config.name, 
            apy: opportunity.depositApy,
            tvl: opportunity.totalDepositUsd
          },
          "Added Drift vault opportunity"
        );
      } catch (conversionError) {
        logger.warn(
          { 
            error: conversionError instanceof Error ? conversionError.message : String(conversionError), 
            vaultPubkey: config.vaultPubkeyString, 
            name: config.name 
          },
          "Failed to convert Drift vault to opportunity"
        );
      }
    }

    // Sort by APY descending
    opportunities.sort((a, b) => b.depositApy - a.depositApy);

    workerMetrics.inc("drift_api_calls_total", { status: "success" });
    workerMetrics.observe("drift_api_duration_seconds", (Date.now() - fetchStart) / 1000);

    logger.info(
      { 
        totalConfigs: configs.length, 
        validOpportunities: opportunities.length,
        topAPY: opportunities[0]?.depositApy || 0
      },
      "Fetched Drift vault opportunities"
    );

    return opportunities;
  } catch (error) {
    const status = (error instanceof Error && error.name === "AbortError") ? "timeout" : "error";
    workerMetrics.inc("drift_api_calls_total", { status });
    workerMetrics.observe("drift_api_duration_seconds", (Date.now() - fetchStart) / 1000);
    
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to fetch Drift vault opportunities");
    throw error;
  }
}

/**
 * Get Drift vault opportunities with caching (10 min TTL)
 */
export async function getDriftVaultOpportunities(): Promise<LendingOpportunity[]> {
  const now = Date.now();

  // Check if cache is valid
  if (driftOpportunitiesCache && (now - driftOpportunitiesCache.timestamp) < CACHE_TTL_MS) {
    logger.debug(
      { cacheAge: Math.round((now - driftOpportunitiesCache.timestamp) / 1000) },
      "Using cached Drift vault opportunities"
    );
    return driftOpportunitiesCache.data;
  }

  // Fetch fresh data
  logger.info("Fetching fresh Drift vault opportunities");
  const opportunities = await fetchDriftVaultOpportunities();

  // Update cache
  driftOpportunitiesCache = {
    data: opportunities,
    timestamp: now,
  };

  return opportunities;
}

/**
 * Get Drift opportunities filtered by asset mint address
 */
export async function getDriftOpportunitiesForAsset(assetMint: string): Promise<LendingOpportunity[]> {
  try {
    const opportunities = await getDriftVaultOpportunities();
    
    return opportunities.filter(opp => 
      opp.token?.address === assetMint || 
      opp.additionalData?.vaultAddress === assetMint
    );
  } catch (error) {
    logger.warn({ error, assetMint }, "Failed to get Drift opportunities for asset, returning empty array");
    return [];
  }
}

/**
 * Clear the Drift cache (useful for testing or forced refresh)
 */
export function clearDriftCache(): void {
  driftOpportunitiesCache = null;
  logger.info("Drift vault opportunities cache cleared");
}

/**
 * Get Drift cache status for monitoring
 */
export function getDriftCacheStatus(): { isCached: boolean; ageMs: number | null; entryCount: number } {
  if (!driftOpportunitiesCache) {
    return { isCached: false, ageMs: null, entryCount: 0 };
  }
  
  return {
    isCached: true,
    ageMs: Date.now() - driftOpportunitiesCache.timestamp,
    entryCount: driftOpportunitiesCache.data.length,
  };
}

/**
 * Fetch Drift APYs using the exact API structure from user example
 * This is the main function that follows the provided pattern
 */
export async function fetchDriftVaultAPYs(): Promise<LendingOpportunity[]> {
  try {
    // Use the exact API structure from the user's example
    const [configs, apys] = await Promise.all([
      fetch(CONFIGS_URL).then((r) => r.json()),
      fetch(APYS_URL).then((r) => r.json()),
    ]);

    const opportunities: LendingOpportunity[] = [];

    for (const { name, vaultPubkeyString } of configs) {
      const data = apys[vaultPubkeyString];
      if (!data) continue;
      
      const a = data.apys;
      
      // Log the APY info as in the example
      logger.debug(`Drift vault ${name}: 7d APY: ${a['7d']?.toFixed(2)}%`);
      
      // Use 4d APY as primary metric as specified
      const primaryAPY = a['4d'] || a['7d'] || a['1d'] || 0;
      
      if (primaryAPY <= 0) continue;

      const opportunity: LendingOpportunity = {
        id: `drift-vault-${vaultPubkeyString}`,
        type: "yield",
        provider: {
          id: "drift",
          name: "Drift",
        },
        token: {
          address: vaultPubkeyString,
          symbol: name,
          decimals: 9, // Default for Solana
        },
        depositApy: primaryAPY * 100, // Convert to percentage
        totalDepositUsd: data.totalDeposits || 0,
        actions: {
          deposit: true,
          withdraw: true,
        },
        assetGroup: getDriftAssetGroup(name),
        additionalData: {
          vaultAddress: vaultPubkeyString,
          vaultName: name,
          driftMetrics: {
            "1d": a['1d'],
            "4d": a['4d'],
            "7d": a['7d'],
            "30d": a['30d']
          }
        }
      };

      opportunities.push(opportunity);
    }

    return opportunities.sort((a, b) => b.depositApy - a.depositApy);
  } catch (error) {
    logger.error({ error }, "Error in fetchDriftVaultAPYs");
    return []; // Return empty array on error as fallback
  }
}