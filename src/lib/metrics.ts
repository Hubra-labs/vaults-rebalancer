import { Registry, Counter, Gauge, Histogram } from "prom-client";
import { config } from "../config";

export const register = new Registry();

const enabled = config.metricsEnabled;

function counter(opts: { name: string; help: string; labelNames?: string[] }) {
  const c = new Counter({ ...opts, labelNames: opts.labelNames ?? [], registers: [] });
  if (enabled) register.registerMetric(c);
  return c;
}

function gauge(opts: { name: string; help: string; labelNames?: string[] }) {
  const g = new Gauge({ ...opts, labelNames: opts.labelNames ?? [], registers: [] });
  if (enabled) register.registerMetric(g);
  return g;
}

function histogram(opts: { name: string; help: string; labelNames?: string[]; buckets?: number[] }) {
  const h = new Histogram({ ...opts, labelNames: opts.labelNames ?? [], registers: [] });
  if (enabled) register.registerMetric(h);
  return h;
}

// --- Gauges ---

export const vaultTotalValue = gauge({
  name: "vault_total_value",
  help: "Total vault value in token units",
});

export const vaultIdleBalance = gauge({
  name: "vault_idle_balance",
  help: "Idle (unallocated) balance in token units",
});

export const strategyPositionValue = gauge({
  name: "strategy_position_value",
  help: "Per-strategy current position value",
  labelNames: ["strategy_id", "strategy_type"],
});

export const strategyTargetValue = gauge({
  name: "strategy_target_value",
  help: "Per-strategy target value after rebalance",
  labelNames: ["strategy_id", "strategy_type"],
});

export const yieldWinnerApy = gauge({
  name: "yield_winner_apy",
  help: "Current yield winner APY",
});

export const yieldWinnerTvl = gauge({
  name: "yield_winner_tvl",
  help: "Current yield winner TVL in USD",
});

export const workerRestarts = gauge({
  name: "worker_restarts",
  help: "Rebalance worker restart count",
});

// --- Counters ---

export const rebalanceTotal = counter({
  name: "rebalance_total",
  help: "Total rebalances executed",
  labelNames: ["trigger"],
});

export const rebalanceErrorsTotal = counter({
  name: "rebalance_errors_total",
  help: "Total failed rebalances",
});

export const rebalanceFallbackTotal = counter({
  name: "rebalance_fallback_total",
  help: "Equal-weight fallback count",
  labelNames: ["reason", "strategy"],
});

export const yieldApiCallsTotal = counter({
  name: "yield_api_calls_total",
  help: "Yield API call count by status",
  labelNames: ["status", "provider"],
});

export const txTotal = counter({
  name: "tx_total",
  help: "Transactions sent",
  labelNames: ["type", "status"],
});

export const loopErrorsTotal = counter({
  name: "loop_errors_total",
  help: "Errors per loop",
  labelNames: ["loop"],
});

export const loopIterationsTotal = counter({
  name: "loop_iterations_total",
  help: "Iterations per loop",
  labelNames: ["loop"],
});

// --- Histograms ---

export const rebalanceDurationSeconds = histogram({
  name: "rebalance_duration_seconds",
  help: "End-to-end rebalance duration",
  buckets: [1, 5, 10, 30, 60, 120, 300],
});

export const yieldApiDurationSeconds = histogram({
  name: "yield_api_duration_seconds",
  help: "Dial API call latency",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

export const txDurationSeconds = histogram({
  name: "tx_duration_seconds",
  help: "Transaction confirmation time",
  labelNames: ["type"],
  buckets: [1, 5, 10, 30, 60, 120],
});

export const txComputeUnits = histogram({
  name: "tx_compute_units",
  help: "Compute units used per transaction",
  labelNames: ["type"],
  buckets: [50_000, 100_000, 200_000, 400_000, 800_000, 1_400_000],
});

export const txPriorityFee = histogram({
  name: "tx_priority_fee",
  help: "Priority fee paid (microLamports)",
  labelNames: ["type"],
  buckets: [10, 50, 100, 500, 1_000, 5_000, 10_000],
});

// --- Info gauge for winner ---

export const yieldWinnerInfo = gauge({
  name: "yield_winner_info",
  help: "Current yield winner (label-only info metric)",
  labelNames: ["strategy_id", "provider", "pool_pubkey", "vault_address"],
});

// --- Metric message types for worker bridge ---

export type MetricAction = "inc" | "set" | "observe";

export interface MetricMessage {
  type: "metric";
  name: string;
  action: MetricAction;
  value: number;
  labels?: Record<string, string>;
}

const metricMap: Record<string, Counter | Gauge | Histogram> = {
  vault_total_value: vaultTotalValue,
  vault_idle_balance: vaultIdleBalance,
  strategy_position_value: strategyPositionValue,
  strategy_target_value: strategyTargetValue,
  yield_winner_apy: yieldWinnerApy,
  yield_winner_tvl: yieldWinnerTvl,
  yield_winner_info: yieldWinnerInfo,
  rebalance_total: rebalanceTotal,
  rebalance_errors_total: rebalanceErrorsTotal,
  rebalance_fallback_total: rebalanceFallbackTotal,
  yield_api_calls_total: yieldApiCallsTotal,
  tx_total: txTotal,
  loop_errors_total: loopErrorsTotal,
  loop_iterations_total: loopIterationsTotal,
  rebalance_duration_seconds: rebalanceDurationSeconds,
  yield_api_duration_seconds: yieldApiDurationSeconds,
  tx_duration_seconds: txDurationSeconds,
  tx_compute_units: txComputeUnits,
  tx_priority_fee: txPriorityFee,
};

export function applyMetricMessage(msg: MetricMessage) {
  const metric = metricMap[msg.name];
  if (!metric) return;

  const labels = msg.labels ?? {};

  switch (msg.action) {
    case "inc":
      (metric as Counter).inc(labels, msg.value);
      break;
    case "set":
      (metric as Gauge).set(labels, msg.value);
      break;
    case "observe":
      (metric as Histogram).observe(labels, msg.value);
      break;
  }
}
