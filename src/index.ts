import http from "http";
import path from "path";
import { Worker } from "worker_threads";
import { config } from "./config";
import {
  logger,
  recursiveTryCatch,
  setShuttingDown,
  isShuttingDown,
  sleep,
} from "./lib/utils";
import {
  destroyConnectionManager,
  getConnectionManager,
} from "./lib/connection";
import { runRefreshLoop } from "./refresh_loop";
import { runClaimKvaultRewardLoop } from "./claim_kvault_reward_loop";
import { runHarvestFeeLoop } from "./harvest_fee_loop";
import { runClaimKmarketRewardLoop } from "./claim_kmarket_reward_loop";
import { register, applyMetricMessage, workerRestarts, MetricMessage } from "./lib/metrics";
import { getLendingOpportunities, getCacheStatus, clearCache } from "./lib/lending-playbook";

// --- Health server ---
let healthServer: http.Server;

function startHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    healthServer = http.createServer((_req, res) => {
      if (_req.url === "/health") {
        if (isShuttingDown()) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "shutting_down" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        }
      } else if (_req.url === "/metrics" && config.metricsEnabled) {
        register.metrics().then((metrics) => {
          res.writeHead(200, { "Content-Type": register.contentType });
          res.end(metrics);
        }).catch((err) => {
          res.writeHead(500);
          res.end(String(err));
        });
        return;
      } else if (_req.url === "/rebalance" && _req.method === "POST") {
        if (!rebalanceWorker) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rebalance worker not running" }));
        } else {
          rebalanceWorker.postMessage({ type: "trigger_rebalance" });
          logger.info("Manual rebalance triggered via HTTP");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "triggered" }));
        }
      } else if (_req.url === "/lending") {
        // Test endpoint for lending opportunities cache
        const start = Date.now();
        getLendingOpportunities()
          .then((opportunities) => {
            const duration = Date.now() - start;
            const cacheStatus = getCacheStatus();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              count: opportunities.length,
              durationMs: duration,
              cache: {
                hit: cacheStatus.isCached && cacheStatus.ageMs! < 10 * 60 * 1000,
                ageMs: cacheStatus.ageMs,
                entries: cacheStatus.entryCount,
              },
              sample: opportunities.slice(0, 3).map(o => ({
                id: o.id,
                token: o.token?.symbol,
                apy: (o.depositApy * 100).toFixed(2) + "%",
                tvl: "$" + Math.round(o.totalDepositUsd).toLocaleString(),
                provider: o.provider.name,
              })),
            }, null, 2));
          })
          .catch((err) => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          });
        return;
      } else if (_req.url === "/lending/clear" && _req.method === "POST") {
        // Clear cache for testing
        clearCache();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "cache_cleared" }));
        return;
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    healthServer.listen(config.healthServerPort, () => {
      logger.info(
        { port: config.healthServerPort },
        "Health server listening"
      );
      resolve();
    });
  });
}

// --- Graceful shutdown ---
let shutdownInProgress = false;

async function gracefulShutdown(signal: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  logger.info({ signal }, "Received shutdown signal, initiating graceful shutdown...");

  // Safety timeout: force exit if graceful shutdown takes too long
  const safetyTimeout = setTimeout(() => {
    logger.error("Safety timeout reached, forcing exit");
    process.exit(1);
  }, 15_000);
  safetyTimeout.unref();

  // Signal all loops to stop
  setShuttingDown();

  // Signal rebalance worker to stop and wait for it
  if (rebalanceWorker) {
    rebalanceWorker.postMessage({ type: "shutdown" });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10_000);
      rebalanceWorker!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    logger.info("Rebalance worker shut down");
  }

  // Wait up to 10 seconds for other loops to exit their current iteration
  const shutdownStart = Date.now();
  const maxWaitMs = 10_000;
  while (Date.now() - shutdownStart < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Cleanup
  destroyConnectionManager();

  if (healthServer) {
    healthServer.close();
    logger.info("Health server closed");
  }

  logger.info("Graceful shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// --- Rebalance worker management ---
let rebalanceWorker: Worker | null = null;
let rebalanceWorkerRestarts = 0;
const MAX_WORKER_RESTARTS = 3;

function spawnRebalanceWorker() {
  const isTsNode = __filename.endsWith(".ts");
  const ext = isTsNode ? ".ts" : ".js";
  const workerPath = path.resolve(__dirname, `rebalance_worker${ext}`);
  const worker = new Worker(workerPath, {
    resourceLimits: { maxOldGenerationSizeMb: config.workerMaxMemoryMb },
    ...(isTsNode && { execArgv: ["--require", "ts-node/register"] }),
  });

  worker.on("message", (msg: { type: string }) => {
    if (msg.type === "started") {
      logger.info("Rebalance worker started successfully");
    } else if (msg.type === "metric") {
      applyMetricMessage(msg as MetricMessage);
    }
  });

  worker.on("error", (err) => {
    logger.error({ err }, "Rebalance worker error");
  });

  worker.on("exit", async (code) => {
    logger.warn({ code }, "Rebalance worker exited");
    rebalanceWorker = null;

    if (!isShuttingDown() && rebalanceWorkerRestarts < MAX_WORKER_RESTARTS) {
      rebalanceWorkerRestarts++;
      workerRestarts.set(rebalanceWorkerRestarts);
      const delayMs = 1000 * Math.pow(2, rebalanceWorkerRestarts - 1);
      logger.info(
        { attempt: rebalanceWorkerRestarts, delayMs },
        "Restarting rebalance worker"
      );
      await sleep(delayMs);
      if (!isShuttingDown()) {
        rebalanceWorker = spawnRebalanceWorker();
      }
    } else if (rebalanceWorkerRestarts >= MAX_WORKER_RESTARTS) {
      logger.error("Max rebalance worker restarts reached, giving up");
    }
  });

  rebalanceWorker = worker;
  return worker;
}

// --- Main ---
async function main() {
  // Initialize connection manager eagerly
  getConnectionManager();

  // Start health server before loops
  await startHealthServer();

  // Launch rebalance loop in a worker thread
  if (config.enableRebalanceLoop) {
    logger.info("Starting rebalance loop (worker thread)");
    spawnRebalanceWorker();
  }
  if (config.enableRefreshLoop) {
    logger.info("Starting refresh loop");
    recursiveTryCatch(() => runRefreshLoop(), "refresh-loop");
  }
  if (config.enableClaimKmarketRewardLoop) {
    logger.info("Starting claim kmarket reward loop");
    recursiveTryCatch(
      () => runClaimKmarketRewardLoop(),
      "claim-kmarket-reward-loop"
    );
  }
  if (config.enableClaimKvaultRewardLoop) {
    logger.info("Starting claim kvault reward loop");
    recursiveTryCatch(() => runClaimKvaultRewardLoop(), "claim-kvault-reward-loop");
  }
  if (config.enableHarvestFeeLoop) {
    logger.info("Starting harvest fee loop");
    recursiveTryCatch(() => runHarvestFeeLoop(), "harvest-fee-loop");
  }
}

main().catch((error) => {
  logger.error({ err: error }, "Fatal error in main application");
  process.exit(1);
});
