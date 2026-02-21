import express from 'express';
import { Registry, Gauge, Counter, collectDefaultMetrics } from 'prom-client';

// Hubra vaults configuration
const VAULTS = {
  usdc: '3maCuTJVPteZ2dFA8dADxz2EbpJHfoAG5txYhXDs6gNQ',
  usdt: '3kzb6rcDJxSdkWCwXXP9PULSqBy6rVDNWanzw5dBCYCj',
  usd1: '663azFYEnHDTLGf4CEk8KpNTje8XxZVLnQwo9LjbSejy',
  usds: '5mv1cURMSaPU3q3wFVoN4mKMWNFVvUtH3UZrG4Z2Mgfz',
  usdg: '7VZ1XKK7Zns6UzRc1Wz54u6cypN7zaduasVXXr7NysxH'
};

const PORT = process.env.PORT || 9101;
const SCRAPE_INTERVAL_MS = 60_000; // 1 minute

// Create registry
const register = new Registry();
collectDefaultMetrics({ register });

// Define metrics
const vaultTvlGauge = new Gauge({
  name: 'voltr_vault_tvl_usd',
  help: 'Total Value Locked in vault (USD)',
  labelNames: ['asset', 'vault_address'],
  registers: [register]
});

const vaultApyGauge = new Gauge({
  name: 'voltr_vault_apy_percent',
  help: 'Vault APY by time period',
  labelNames: ['asset', 'period'],
  registers: [register]
});

const poolAllocationGauge = new Gauge({
  name: 'voltr_pool_allocation_usd',
  help: 'Current allocation per pool (USD)',
  labelNames: ['asset', 'org', 'strategy'],
  registers: [register]
});

const dailyTvlGauge = new Gauge({
  name: 'voltr_daily_tvl_usd',
  help: 'Historical daily TVL',
  labelNames: ['asset', 'date'],
  registers: [register]
});

const dailyApyGauge = new Gauge({
  name: 'voltr_daily_apy_percent',
  help: 'Historical daily APY',
  labelNames: ['asset', 'date'],
  registers: [register]
});

const idleFundsGauge = new Gauge({
  name: 'voltr_idle_funds_usd',
  help: 'Unallocated idle funds (USD)',
  labelNames: ['asset'],
  registers: [register]
});

const allocationCountGauge = new Gauge({
  name: 'voltr_active_allocations',
  help: 'Number of pools with active allocations',
  labelNames: ['asset'],
  registers: [register]
});

const tokenPriceGauge = new Gauge({
  name: 'voltr_token_price_usd',
  help: 'Token price in USD',
  labelNames: ['asset'],
  registers: [register]
});

const scrapeErrorCounter = new Counter({
  name: 'voltr_scrape_errors_total',
  help: 'Total scrape errors',
  labelNames: ['asset'],
  registers: [register]
});

const scrapeDurationGauge = new Gauge({
  name: 'voltr_scrape_duration_seconds',
  help: 'Time to scrape all vaults',
  registers: [register]
});

// Track allocation changes for rebalance detection
let previousAllocations = {};

const allocationChangeCounter = new Counter({
  name: 'voltr_allocation_changes_total',
  help: 'Number of allocation changes detected (proxy for rebalances)',
  labelNames: ['asset'],
  registers: [register]
});

async function fetchVaultData(asset, address) {
  const response = await fetch(`https://api.voltr.xyz/vault/${address}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error('API returned success=false');
  }
  return data.vault;
}

function detectAllocationChanges(asset, allocations) {
  const currentAllocs = {};
  for (const alloc of allocations) {
    const key = `${alloc.orgName}:${alloc.strategyDescription}`;
    currentAllocs[key] = alloc.positionValue;
  }

  const prev = previousAllocations[asset] || {};
  let changes = 0;

  // Check for significant changes (>$1 difference)
  for (const [key, value] of Object.entries(currentAllocs)) {
    const prevValue = prev[key] || 0;
    if (Math.abs(value - prevValue) > 1_000_000) { // $1 in smallest units
      changes++;
    }
  }

  previousAllocations[asset] = currentAllocs;
  return changes;
}

async function scrapeVaults() {
  const startTime = Date.now();
  
  for (const [asset, address] of Object.entries(VAULTS)) {
    try {
      const vault = await fetchVaultData(asset, address);
      const decimals = vault.token?.decimals || 6;
      const divisor = Math.pow(10, decimals);
      const price = vault.token?.price || 1;

      // TVL
      const tvlUsd = (vault.totalValue / divisor) * price;
      vaultTvlGauge.set({ asset, vault_address: address }, tvlUsd);

      // Token price
      tokenPriceGauge.set({ asset }, price);

      // APY
      if (vault.apy) {
        if (vault.apy.oneDay != null) {
          vaultApyGauge.set({ asset, period: '1d' }, vault.apy.oneDay);
        }
        if (vault.apy.sevenDays != null) {
          vaultApyGauge.set({ asset, period: '7d' }, vault.apy.sevenDays);
        }
        if (vault.apy.thirtyDays != null) {
          vaultApyGauge.set({ asset, period: '30d' }, vault.apy.thirtyDays);
        }
        if (vault.apy.allTime != null) {
          vaultApyGauge.set({ asset, period: 'all' }, vault.apy.allTime);
        }
      }

      // Pool allocations
      let totalAllocated = 0;
      let activeAllocations = 0;
      
      if (vault.allocations) {
        for (const alloc of vault.allocations) {
          const allocUsd = (alloc.positionValue / divisor) * price;
          poolAllocationGauge.set({
            asset,
            org: alloc.orgName || 'unknown',
            strategy: alloc.strategyDescription || 'unknown'
          }, allocUsd);
          
          totalAllocated += alloc.positionValue;
          if (alloc.positionValue > 0) {
            activeAllocations++;
          }
        }

        // Detect allocation changes (rebalances)
        const changes = detectAllocationChanges(asset, vault.allocations);
        if (changes > 0) {
          allocationChangeCounter.inc({ asset }, changes);
        }
      }

      allocationCountGauge.set({ asset }, activeAllocations);

      // Idle funds
      const idleFunds = vault.totalValue - totalAllocated;
      const idleFundsUsd = (idleFunds / divisor) * price;
      idleFundsGauge.set({ asset }, Math.max(0, idleFundsUsd));

      // Daily stats (last 7 days for efficiency)
      if (vault.dailyStats) {
        const { dateLabels, apyData, tvlData } = vault.dailyStats;
        const recentCount = Math.min(7, dateLabels?.length || 0);
        
        for (let i = dateLabels.length - recentCount; i < dateLabels.length; i++) {
          const date = dateLabels[i];
          if (apyData[i] != null) {
            dailyApyGauge.set({ asset, date }, apyData[i]);
          }
          if (tvlData[i] != null) {
            const dailyTvlUsd = (tvlData[i] / divisor) * price;
            dailyTvlGauge.set({ asset, date }, dailyTvlUsd);
          }
        }
      }

      console.log(`[${new Date().toISOString()}] Scraped ${asset}: TVL=$${tvlUsd.toFixed(2)}, APY=${vault.apy?.oneDay?.toFixed(2) || 'N/A'}%`);

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error scraping ${asset}:`, error.message);
      scrapeErrorCounter.inc({ asset });
    }
  }

  const duration = (Date.now() - startTime) / 1000;
  scrapeDurationGauge.set(duration);
  console.log(`[${new Date().toISOString()}] Scrape completed in ${duration.toFixed(2)}s`);
}

// Express app
const app = express();

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', vaults: Object.keys(VAULTS).length });
});

// Start
async function main() {
  // Initial scrape
  await scrapeVaults();
  
  // Schedule periodic scrapes
  setInterval(scrapeVaults, SCRAPE_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Voltr exporter listening on port ${PORT}`);
    console.log(`Metrics: http://localhost:${PORT}/metrics`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
}

main().catch(console.error);
