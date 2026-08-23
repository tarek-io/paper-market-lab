const DEFAULT_LIVE_CONFIG = Object.freeze({
  workingCapitalHours: 1,
  activationDelayMinutes: null,
  activationTimingStatus: "unmeasured",
  minimumReliability: 0.9,
  minimumNetRateUsdPerHour: 0,
  supplierMode: "on-demand",
  requireQueuedDemand: true,
});

export function buildLiveSnapshot(report, inputConfig = {}) {
  const config = { ...DEFAULT_LIVE_CONFIG, ...inputConfig };
  const activationDelayMinutes = finiteOrNull(config.activationDelayMinutes);
  const activationDelayHours = activationDelayMinutes == null
    ? null
    : Math.max(0, activationDelayMinutes) / 60;

  const candidates = (report.candidates || [])
    .filter((candidate) => candidate.demandPass && candidate.economicPass)
    .filter((candidate) => Number(candidate.seller?.reliability || 0) >= config.minimumReliability)
    .filter((candidate) => !config.supplierMode || candidate.seller?.mode === config.supplierMode)
    .filter((candidate) => {
      if (!config.requireQueuedDemand) return true;
      return Number(candidate.market?.queuedJobs || 0) > 0 && Number(candidate.market?.queuedHosts || 0) === 0;
    })
    .map((candidate) => {
      const immediateQueuedDemand =
        Number(candidate.market?.queuedJobs || 0) > 0 && Number(candidate.market?.queuedHosts || 0) === 0;
      const expectedUtilization = immediateQueuedDemand
        ? 1
        : clamp(Number(candidate.market?.marketFillProxy || 0), 0, 1);
      const rewardUsdPerPaidHour = Number(candidate.market?.hostRewardUsdPerHour || 0);
      const supplyCostUsdPerHour = Number(candidate.seller?.effectiveUsdPerHour || 0);
      const orderFeeUsd = Number(candidate.seller?.orderFeeUsd || 0);
      const grossRevenueRateUsdPerHour = rewardUsdPerPaidHour * expectedUtilization;
      const netRateUsdPerHour = grossRevenueRateUsdPerHour - supplyCostUsdPerHour;
      const workingCapitalCostUsd =
        supplyCostUsdPerHour * config.workingCapitalHours + orderFeeUsd;
      const knownFixedPaybackHours =
        netRateUsdPerHour > 0 ? orderFeeUsd / netRateUsdPerHour : null;
      const startupDragUsd = activationDelayHours == null
        ? null
        : grossRevenueRateUsdPerHour * activationDelayHours + orderFeeUsd;
      const breakEvenHours =
        activationDelayHours != null && netRateUsdPerHour > 0
          ? startupDragUsd / netRateUsdPerHour
          : null;
      const capitalEfficiencyPerHour =
        workingCapitalCostUsd > 0 ? netRateUsdPerHour / workingCapitalCostUsd : -Infinity;

      return {
        id: `${candidate.market.slug}:${candidate.seller.serverId}:${candidate.seller.mode}`,
        gpu: candidate.market.name,
        marketSlug: candidate.market.slug,
        buyer: "Nosana",
        buyerMarketAddress: candidate.market.address,
        supplier: "Clore",
        supplierServerId: candidate.seller.serverId,
        supplierMode: candidate.seller.mode,
        paymentBasis: candidate.seller.paymentBasis || null,
        supplierCountry: candidate.seller.technical?.country || null,
        interruptible: Boolean(candidate.seller.interruptible),
        reliability: round(Number(candidate.seller.reliability || 0), 4),
        queuedJobs: Number(candidate.market.queuedJobs || 0),
        queuedHosts: Number(candidate.market.queuedHosts || 0),
        runningNodes: Number(candidate.market.runningNodes || 0),
        jobsLastHour: Number(candidate.market.jobStartsLastHour || 0),
        immediateQueuedDemand,
        expectedUtilization: round(expectedUtilization, 4),
        rewardUsdPerPaidHour: round(rewardUsdPerPaidHour, 6),
        grossRevenueRateUsdPerHour: round(grossRevenueRateUsdPerHour, 6),
        supplyCostUsdPerHour: round(supplyCostUsdPerHour, 6),
        netRateUsdPerHour: round(netRateUsdPerHour, 6),
        orderFeeUsd: round(orderFeeUsd, 6),
        knownFixedPaybackHours:
          knownFixedPaybackHours == null ? null : round(knownFixedPaybackHours, 4),
        workingCapitalHours: config.workingCapitalHours,
        workingCapitalCostUsd: round(workingCapitalCostUsd, 6),
        activationDelayMinutes,
        activationTimingStatus: config.activationTimingStatus,
        startupDragUsd: startupDragUsd == null ? null : round(startupDragUsd, 6),
        breakEvenHours: breakEvenHours == null ? null : round(breakEvenHours, 4),
        capitalEfficiencyPerHour: round(capitalEfficiencyPerHour, 6),
        breakEvenUtilization: round(Number(candidate.breakEvenUtilization || 0), 4),
      };
    })
    .filter(
      (unit) =>
        unit.workingCapitalCostUsd > 0 &&
        unit.netRateUsdPerHour > config.minimumNetRateUsdPerHour,
    );

  const bestByServer = new Map();
  for (const unit of candidates) {
    const key = String(unit.supplierServerId);
    const existing = bestByServer.get(key);
    if (!existing || compareUnits(unit, existing) < 0) bestByServer.set(key, unit);
  }

  const byMarket = new Map();
  for (const unit of bestByServer.values()) {
    const group = byMarket.get(unit.marketSlug) || [];
    group.push(unit);
    byMarket.set(unit.marketSlug, group);
  }

  const inventory = [];
  for (const units of byMarket.values()) {
    units.sort(compareUnits);
    const queueCap = config.requireQueuedDemand
      ? Math.max(0, Number(units[0]?.queuedJobs || 0))
      : units.length;
    inventory.push(...units.slice(0, queueCap));
  }
  inventory.sort(compareUnits);

  const primary = inventory[0] || null;
  const nosanaMarkets = Array.isArray(report.nosana?.markets) ? report.nosana.markets : [];
  const totalQueuedJobs = nosanaMarkets.reduce(
    (sum, market) => sum + Number(market.queuedJobs || 0),
    0,
  );
  const totalQueuedGrossRateUsdPerHour = nosanaMarkets.reduce(
    (sum, market) =>
      sum + Number(market.queuedJobs || 0) * Number(market.hostRewardUsdPerHour || 0),
    0,
  );
  const capturableGrossRateUsdPerHour = inventory.reduce(
    (sum, unit) => sum + unit.grossRevenueRateUsdPerHour,
    0,
  );
  const capturableSupplyCostUsdPerHour = inventory.reduce(
    (sum, unit) => sum + unit.supplyCostUsdPerHour,
    0,
  );
  const capturableNetRateUsdPerHour = inventory.reduce(
    (sum, unit) => sum + unit.netRateUsdPerHour,
    0,
  );

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    observedAt: report.observedAt,
    config: {
      ...config,
      activationDelayMinutes,
    },
    engine: {
      type: "deterministic",
      version: "live-v3",
      rule: "rank reliable on-demand units by current net rate and cap each market to visible queued jobs",
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
      capturableQueuedJobs: inventory.length,
      totalQueuedJobs,
      queuedCaptureFraction: totalQueuedJobs > 0 ? round(inventory.length / totalQueuedJobs, 4) : 0,
      totalQueuedGrossRateUsdPerHour: round(totalQueuedGrossRateUsdPerHour, 4),
      capturableGrossRateUsdPerHour: round(capturableGrossRateUsdPerHour, 4),
      capturableSupplyCostUsdPerHour: round(capturableSupplyCostUsdPerHour, 4),
      capturableNetRateUsdPerHour: round(capturableNetRateUsdPerHour, 4),
      cloreAvailableServers: Number(report.clore?.availableServerCount || 0),
      cloreEligibleOffers: Number(report.clore?.eligibleOfferCount || 0),
      nosanaMarketCount: nosanaMarkets.length,
    },
    primary,
    inventory,
  };
}

export function maximumUsefulCapital(snapshot) {
  const total = (snapshot?.inventory || []).reduce(
    (sum, unit) => sum + Number(unit.workingCapitalCostUsd || 0),
    0,
  );
  return Math.ceil(total * 100) / 100;
}

export function allocateLiveCapital(snapshot, capitalUsd) {
  const capital = clamp(Number(capitalUsd) || 0, 0, 1_000_000_000);
  let remaining = capital;
  const selected = [];

  for (const unit of snapshot.inventory || []) {
    if (unit.workingCapitalCostUsd <= remaining + 1e-9) {
      selected.push(unit);
      remaining -= unit.workingCapitalCostUsd;
    }
  }

  const deployedCapitalUsd = selected.reduce(
    (sum, unit) => sum + unit.workingCapitalCostUsd,
    0,
  );
  const expectedNetRateUsdPerHour = selected.reduce(
    (sum, unit) => sum + unit.netRateUsdPerHour,
    0,
  );
  const grossRevenueRateUsdPerHour = selected.reduce(
    (sum, unit) => sum + unit.grossRevenueRateUsdPerHour,
    0,
  );
  const supplyCostUsdPerHour = selected.reduce(
    (sum, unit) => sum + unit.supplyCostUsdPerHour,
    0,
  );
  const knownEntryFeeUsd = selected.reduce((sum, unit) => sum + unit.orderFeeUsd, 0);
  const knownFixedPaybackHours =
    expectedNetRateUsdPerHour > 0 ? knownEntryFeeUsd / expectedNetRateUsdPerHour : null;
  const hasActivationEstimate = selected.length > 0 && selected.every(
    (unit) => unit.activationDelayMinutes != null,
  );
  const startupDragUsd = hasActivationEstimate
    ? selected.reduce((sum, unit) => sum + Number(unit.startupDragUsd || 0), 0)
    : null;
  const breakEvenHours =
    hasActivationEstimate && expectedNetRateUsdPerHour > 0
      ? startupDragUsd / expectedNetRateUsdPerHour
      : null;

  return {
    action: selected.length ? "DEPLOY" : "WAIT",
    startingCapitalUsd: round(capital, 2),
    units: selected.length,
    workingCapitalHours: Number(snapshot?.config?.workingCapitalHours || 1),
    deployedCapitalUsd: round(deployedCapitalUsd, 2),
    reserveCapitalUsd: round(remaining, 2),
    grossRevenueRateUsdPerHour: round(grossRevenueRateUsdPerHour, 2),
    supplyCostUsdPerHour: round(supplyCostUsdPerHour, 2),
    expectedNetRateUsdPerHour: round(expectedNetRateUsdPerHour, 2),
    knownEntryFeeUsd: round(knownEntryFeeUsd, 4),
    knownFixedPaybackHours:
      knownFixedPaybackHours == null ? null : round(knownFixedPaybackHours, 4),
    activationTimingStatus: snapshot?.config?.activationTimingStatus || "unmeasured",
    startupDragUsd: startupDragUsd == null ? null : round(startupDragUsd, 2),
    breakEvenHours: breakEvenHours == null ? null : round(breakEvenHours, 2),
    selected,
  };
}

function compareUnits(left, right) {
  if (left.netRateUsdPerHour !== right.netRateUsdPerHour) {
    return right.netRateUsdPerHour - left.netRateUsdPerHour;
  }
  if (left.capitalEfficiencyPerHour !== right.capitalEfficiencyPerHour) {
    return right.capitalEfficiencyPerHour - left.capitalEfficiencyPerHour;
  }
  return left.workingCapitalCostUsd - right.workingCapitalCostUsd;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
