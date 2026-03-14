/**
 * Independent metrics refresh loop.
 *
 * Fetches vault state from the Voltr REST API on a fixed interval (default 60s)
 * and updates Prometheus gauges directly in the main thread.
 *
 * This decouples metrics reporting from the rebalance worker — even if no
 * rebalance runs for hours, Grafana dashboards will always reflect the actual
 * on-chain state.
 */

import { config } from "./config";
import { isShuttingDown, logger, sleep } from "./lib/utils";
import {
  vaultTotalValue,
  vaultIdleBalance,
  strategyPositionValue,
  yieldWinnerApy,
} from "./lib/metrics";

const METRICS_LOOP_INTERVAL_MS = 60_000; // 60 seconds

interface VoltrAllocation {
  orgName: string;
  strategyDescription: string;
  tokenName: string;
  positionValue: number;
}

interface VoltrVaultResponse {
  success: boolean;
  vault: {
    pubkey: string;
    name: string;
    totalValue: number;
    token: {
      name: string;
      decimals: number;
    };
    apy: {
      oneDay: number;
      sevenDays: number;
      thirtyDays: number;
      allTime: number;
    };
    allocations: VoltrAllocation[];
  };
}

export async function runMetricsLoop(): Promise<void> {
  const vaultAddress = config.voltrVaultAddress as string;
  const apiUrl = `https://api.voltr.xyz/vault/${vaultAddress}`;

  logger.info(
    { vaultAddress, intervalMs: METRICS_LOOP_INTERVAL_MS },
    "Starting independent metrics refresh loop"
  );

  while (!isShuttingDown()) {
    try {
      const resp = await fetch(apiUrl, {
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        logger.warn(
          { status: resp.status },
          "Voltr API returned non-OK status for metrics refresh"
        );
        await sleep(METRICS_LOOP_INTERVAL_MS);
        continue;
      }

      const data = (await resp.json()) as VoltrVaultResponse;

      if (!data.success || !data.vault) {
        logger.warn("Voltr API returned unsuccessful response for metrics");
        await sleep(METRICS_LOOP_INTERVAL_MS);
        continue;
      }

      const vault = data.vault;
      const decimals = vault.token?.decimals ?? 6;
      const divisor = 10 ** decimals;

      // Total vault value
      const totalValue = vault.totalValue / divisor;
      vaultTotalValue.set(totalValue);

      // Calculate allocated total and per-strategy values
      let allocatedTotal = 0;
      for (const alloc of vault.allocations) {
        const value = alloc.positionValue / divisor;
        allocatedTotal += value;

        if (alloc.positionValue > 0) {
          // Build a strategy_id label from org + description (matches what Grafana expects)
          const strategyId = `${alloc.orgName}_${alloc.strategyDescription}`
            .toLowerCase()
            .replace(/\s+/g, "_");

          strategyPositionValue.set(
            { strategy_id: strategyId, strategy_type: alloc.orgName.toLowerCase() },
            value
          );
        }
      }

      // Idle balance = total - allocated
      const idleBalance = totalValue - allocatedTotal;
      vaultIdleBalance.set(Math.max(0, idleBalance));

      // Set APY from Voltr (1-day APY as the "current" yield)
      if (vault.apy?.oneDay != null) {
        yieldWinnerApy.set(vault.apy.oneDay / 100); // Voltr returns percentage, metric expects fraction
      }

      logger.debug(
        {
          totalValue: totalValue.toFixed(2),
          allocatedTotal: allocatedTotal.toFixed(2),
          idleBalance: idleBalance.toFixed(2),
          allocations: vault.allocations.filter((a) => a.positionValue > 0).length,
          apy1d: vault.apy?.oneDay?.toFixed(2),
        },
        "Metrics refreshed from Voltr API"
      );
    } catch (error) {
      logger.warn(
        { err: error },
        "Error fetching Voltr API for metrics refresh (will retry next cycle)"
      );
    }

    await sleep(METRICS_LOOP_INTERVAL_MS);
  }

  logger.info("Metrics refresh loop stopped");
}
