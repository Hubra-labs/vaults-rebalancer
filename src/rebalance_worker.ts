import { parentPort } from "worker_threads";
import { logger, recursiveTryCatch, setShuttingDown } from "./lib/utils";
import { runRebalanceLoop, triggerManualRebalance } from "./rebalance_loop";
import { startApyRefreshLoop } from "./lib/lending-playbook";

// Listen for messages from parent
parentPort?.on("message", (msg: { type: string }) => {
  if (msg.type === "shutdown") {
    logger.info("Rebalance worker received shutdown signal");
    setShuttingDown();
  } else if (msg.type === "trigger_rebalance") {
    logger.info("Rebalance worker received manual trigger");
    triggerManualRebalance();
  }
});

// Notify parent that the worker has started
parentPort?.postMessage({ type: "started" });

// Hourly APY snapshot used to pick the yield winner
startApyRefreshLoop();

// Run the rebalance loop with retry wrapper
recursiveTryCatch(() => runRebalanceLoop(), "rebalance-worker").catch(
  (error) => {
    logger.error({ err: error }, "Fatal error in rebalance worker");
    process.exit(1);
  }
);
