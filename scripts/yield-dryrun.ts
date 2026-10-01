/**
 * Dry run of yield target selection — read-only, sends no transactions.
 * Prints each whitelisted strategy's current APY/TVL and our position, then
 * the pool the rebalancer would allocate 100% to (including the
 * MIN_APY_ADVANTAGE hold rule).
 *
 * Usage:
 *   ENV_FILE=.env-usdc ASSET_SYMBOL=USDC npx tsx scripts/yield-dryrun.ts
 */
import { Connection } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { config } from "../src/config";
import { getOpportunitiesForAsset } from "../src/lib/lending-playbook";
import { chooseTarget } from "../src/lib/yield-api";
import { strategyRegistry } from "../src/lib/strategy-config";
import { toPublicKey } from "../src/lib/convert";
import { logger } from "../src/lib/utils";

logger.level = "warn";

const pct = (x: number | null) => (x === null ? "unknown" : `${(x * 100).toFixed(2)}%`);

const main = async () => {
  const voltrClient = new VoltrClient(new Connection(config.rpcUrl, "confirmed"));
  const receipts = await voltrClient.fetchAllStrategyInitReceiptAccountsOfVault(toPublicKey(config.voltrVaultAddress));
  const positions = new Map(receipts.map((r) => [r.account.strategy.toBase58(), r.account.positionValue.toNumber() / 1e6]));

  const current = strategyRegistry.strategies
    .filter((s) => (positions.get(String(s.address)) ?? 0) > 0)
    .sort((a, b) => positions.get(String(b.address))! - positions.get(String(a.address))!)[0];

  const markets = await getOpportunitiesForAsset(String(config.assetMintAddress));
  const decision = chooseTarget(markets, current?.id ?? null, (s) => positions.has(String(s.address)));

  console.log(`vault ${config.voltrVaultAddress}  (min TVL $${config.minTvlUsd.toLocaleString()}, switch if winner > current by ${pct(config.minApyAdvantage)})\n`);
  console.log(`  ${"strategy".padEnd(44)}${"APY".padStart(8)}${"TVL".padStart(16)}${"our position".padStart(16)}  note`);
  for (const m of markets) {
    const s = strategyRegistry.byId.get(m.id)!;
    const pos = positions.get(String(s.address));
    const note =
      pos === undefined ? "not initialized on-chain" :
      m.totalDepositUsd <= config.minTvlUsd ? "below min TVL" : "";
    const mark = m.id === decision?.targetId ? "→ " : "  ";
    console.log(
      `${mark}${m.id.padEnd(44)}${pct(m.depositApy).padStart(8)}` +
        `${("$" + Math.round(m.totalDepositUsd).toLocaleString()).padStart(16)}` +
        `${(pos === undefined ? "-" : "$" + pos.toLocaleString(undefined, { maximumFractionDigits: 2 })).padStart(16)}  ${note}`
    );
  }

  if (!decision) {
    console.log("\nNo eligible pool — rebalance would be skipped.");
    return;
  }
  console.log(`\nWinner:  ${decision.winner.strategy.id} @ ${pct(decision.winner.market.depositApy)}`);
  console.log(`Current: ${decision.currentId ?? "none (all idle)"} @ ${pct(decision.currentApy)}`);
  console.log(`Target:  ${decision.targetId} @ ${pct(decision.targetApy)}  — ${decision.switched ? "SWITCH" : "HOLD"}: ${decision.reason}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
