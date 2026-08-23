const DEFAULT_LIVE_CONFIG = Object.freeze({
  commitmentHours: 6,
  activationDelayMinutes: 30,
  minimumReliability: 0.9,
  minimumUnitProfitUsd: 0.05,
});

export function buildLiveSnapshot(report, inputConfig = {}) {
  const config = { ...DEFAULT_LIVE_CONFIG, ...inputConfig };
  const earningHours = Math.max(0, config.commitmentHours - config.activationDelayMinutes / 60);
  const candidates = (report.candidates || [])
    .filter((candidate) => candidate.demandPass && candidate.economicPass)
    .filter((candidate) => Number(candidate.seller?.reliability || 0) >= config.minimumReliability)
    .map((candidate) => {
      const expectedUtilization = clamp(Number(candidate.market?.marketFillProxy || 0), 0, 1);
      const rewardUsdPerPaidHour = Number(candidate.market?.hostRewardUsdPerHour || 0);
      const supplyCostUsdPerHour = Number(candidate.seller?.effectiveUsdPerHour || 0);
      const orderFeeUsd = Number(candidate.seller?.orderFeeUsd || 0);
      const commitmentCostUsd = supplyCostUsdPerHour * config.commitmentHours + orderFeeUsd;
      const expectedRevenueUsd = rewardUsdPerPaidHour * expectedUtilization * earningHours;
      const expectedProfitUsd = expectedRevenueUsd - commitmentCostUsd;
      const expectedRoi = commitmentCostUsd > 0 ? expectedProfitUsd / commitmentCostUsd : -Infinity;

      return {
        id: `${candidate.market.slug}:${candidate.seller.serverId}:${candidate.seller.mode}`,
        gpu: candidate.market.name,
        marketSlug: candidate.market.slug,
        buyer: "Nosana",
        buyerMarketAddress: candidate.market.address,
        supplier: "Clore",
        supplierServerId: candidate.seller.serverId,
        supplierMode: candidate.seller.mode,
        supplierCountry: candidate.seller.technical?.country || null,
        interruptible: Boolean(candidate.seller.interruptible),
        reliability: round(Number(candidate.seller.reliability || 0), 4),
        queuedJobs: Number(candidate.market.queuedJobs || 0),
        queuedHosts: Number(candidate.market.queuedHosts || 0),
        runningNodes: Number(candidate.market.runningNodes || 0),
        jobsLastHour: Number(candidate.market.jobStartsLastHour || 0),
        expectedUtilization: round(expectedUtilization, 4),
        rewardUsdPerPaidHour: round(rewardUsdPerPaidHour, 6),
        supplyCostUsdPerHour: round(supplyCostUsdPerHour, 6),
        orderFeeUsd: round(orderFeeUsd, 6),
        commitmentHours: config.commitmentHours,
        activationDelayMinutes: config.activationDelayMinutes,
        earningHours,
        commitmentCostUsd: round(commitmentCostUsd, 6),
        expectedRevenueUsd: round(expectedRevenueUsd, 6),
        expectedProfitUsd: round(expectedProfitUsd, 6),
        expectedRoi: round(expectedRoi, 6),
        breakEvenUtilization: round(Number(candidate.breakEvenUtilization || 0), 4),
      };
    })
    .filter((unit) => unit.commitmentCostUsd > 0 && unit.expectedProfitUsd >= config.minimumUnitProfitUsd);

  const bestByServer = new Map();
  for (const unit of candidates) {
    const key = String(unit.supplierServerId);
    const existing = bestByServer.get(key);
    if (!existing || compareUnits(unit, existing) < 0) bestByServer.set(key, unit);
  }

  const inventory = [...bestByServer.values()].sort(compareUnits);
  const primary = inventory[0] || null;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    observedAt: report.observedAt,
    config,
    engine: {
      type: "deterministic",
      version: "live-v1",
      rule: "rank unique available units by expected ROI after activation delay and fees",
    },
    sources: {
      buyer: {
        name: "Nosana",
        role: "buyer / revenue",
        endpoint: report.sources?.nosanaMarkets || "https://dashboard.k8s.prd.nos.ci/api/markets",
        jobsEndpoint: report.sources?.nosanaJobs || "https://dashboard.k8s.prd.nos.ci/api/jobs",
        status: "ok",
      },
      supplier: {
        name: "Clore",
        role: "supplier / cost",
        endpoint: report.sources?.cloreMarketplace || "https://api.clore.ai/v1/marketplace",
        status: "ok",
      },
      queueVerifier: {
        name: "Solana",
        role: "Nosana queue verification",
        endpoint: Array.isArray(report.sources?.solanaMarketAccounts)
          ? report.sources.solanaMarketAccounts[0]
          : null,
        status: "ok",
      },
    },
    market: {
      qualifyingUnits: inventory.length,
      cloreAvailableServers: Number(report.clore?.availableServerCount || 0),
      cloreEligibleOffers: Number(report.clore?.eligibleOfferCount || 0),
      nosanaMarketCount: Array.isArray(report.nosana?.markets) ? report.nosana.markets.length : 0,
    },
    primary,
    inventory,
  };
}

export function maximumUsefulCapital(snapshot) {
  const total = (snapshot?.inventory || []).reduce(
    (sum, unit) => sum + Number(unit.commitmentCostUsd || 0),
    0,
  );
  return Math.ceil(total * 100) / 100;
}

export function allocateLiveCapital(snapshot, capitalUsd) {
  const capital = clamp(Number(capitalUsd) || 0, 0, 1_000_000_000);
  let remaining = capital;
  const selected = [];

  for (const unit of snapshot.inventory || []) {
    if (unit.commitmentCostUsd <= remaining + 1e-9) {
      selected.push(unit);
      remaining -= unit.commitmentCostUsd;
    }
  }

  const deployedCapitalUsd = selected.reduce((sum, unit) => sum + unit.commitmentCostUsd, 0);
  const expectedProfitUsd = selected.reduce((sum, unit) => sum + unit.expectedProfitUsd, 0);

  return {
    action: selected.length ? "DEPLOY" : "WAIT",
    startingCapitalUsd: round(capital, 2),
    units: selected.length,
    deployedCapitalUsd: round(deployedCapitalUsd, 2),
    reserveCapitalUsd: round(remaining, 2),
    expectedProfitUsd: round(expectedProfitUsd, 2),
    expectedEndingCapitalUsd: round(capital + expectedProfitUsd, 2),
    selected,
  };
}

function compareUnits(left, right) {
  if (left.expectedRoi !== right.expectedRoi) return right.expectedRoi - left.expectedRoi;
  if (left.expectedProfitUsd !== right.expectedProfitUsd) return right.expectedProfitUsd - left.expectedProfitUsd;
  return left.commitmentCostUsd - right.commitmentCostUsd;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
