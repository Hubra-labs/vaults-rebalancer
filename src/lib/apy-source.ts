import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "./utils";
import { getPerenaApy, USDSTAR_MINT } from "./perena";
import { StrategyConfig, strategyRegistry } from "./strategy-config";
import type { LendingOpportunity } from "./lending-playbook";

/**
 * Our own APY source: current APY for each whitelisted strategy, straight from
 * the protocol APIs.
 *   kaminoVault -> Kamino /kvaults/{address}/metrics (apy)
 *   jupiterLend -> Jupiter Lend /earn/tokens (totalRate, bps)
 *   perena      -> Perena /usdstar/apy (7d); TVL = USD* supply x price
 */

const KAMINO_API_URL = "https://api.kamino.finance";
const JUPITER_LEND_TOKENS_URL = "https://lite-api.jup.ag/lend/v1/earn/tokens";
const PERENA_PRICE_URL = "https://api.perena.org/api/usdstar/price";

const PROVIDERS: Record<string, { id: string; name: string }> = {
  kaminoVault: { id: "kamino", name: "Kamino" },
  jupiterLend: { id: "jupiter", name: "Jupiter" },
  perena: { id: "perena", name: "Perena" },
};

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(config.yieldApiTimeoutMs) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function fetchApy(s: StrategyConfig): Promise<{ apy: number; tvlUsd: number }> {
  if (s.type === "kaminoVault") {
    const m = await getJson(`${KAMINO_API_URL}/kvaults/${s.address}/metrics`);
    return { apy: Number(m.apy), tvlUsd: Number(m.tokensInvestedUsd) + Number(m.tokensAvailableUsd) };
  }
  if (s.type === "jupiterLend") {
    const tokens = await getJson(JUPITER_LEND_TOKENS_URL);
    const t = tokens.find((x: any) => x.assetAddress === String(config.assetMintAddress));
    if (!t) throw new Error("Jupiter Lend market not found");
    return { apy: Number(t.totalRate) / 10_000, tvlUsd: (Number(t.totalAssets) / 10 ** t.decimals) * Number(t.asset.price) };
  }
  if (s.type === "perena") {
    const [apy, { price }, supply] = await Promise.all([
      getPerenaApy(),
      getJson(PERENA_PRICE_URL),
      new Connection(config.rpcUrl, "confirmed").getTokenSupply(USDSTAR_MINT),
    ]);
    return { apy, tvlUsd: Number(supply.value.uiAmount) * Number(price) };
  }
  throw new Error(`no APY source for strategy type ${s.type}`);
}

export async function fetchStrategyApys(): Promise<LendingOpportunity[]> {
  const results = await Promise.allSettled(strategyRegistry.strategies.map(fetchApy));

  const opportunities: LendingOpportunity[] = [];
  const apys: Record<string, string> = {};
  results.forEach((r, i) => {
    const s = strategyRegistry.strategies[i];
    if (r.status === "rejected") {
      logger.error({ strategyId: s.id, err: String(r.reason) }, "APY fetch failed — strategy skipped");
      return;
    }
    apys[s.id] = `${(r.value.apy * 100).toFixed(2)}%`;
    opportunities.push({
      id: s.id,
      type: "yield",
      provider: PROVIDERS[s.type] ?? { id: s.type, name: s.type },
      token: { address: String(config.assetMintAddress), symbol: process.env.ASSET_SYMBOL ?? "", decimals: 6 },
      depositApy: r.value.apy,
      totalDepositUsd: r.value.tvlUsd,
      additionalData: s.type === "kaminoVault" ? { vaultAddress: String(s.address) } : {},
    });
  });

  if (opportunities.length === 0) throw new Error("APY fetch failed for all strategies");
  logger.info({ apys }, "Fetched strategy APYs");

  // Unfiltered: min-TVL eligibility is applied at winner selection, so the
  // current holding's APY is always known for the switch threshold.
  return opportunities;
}
