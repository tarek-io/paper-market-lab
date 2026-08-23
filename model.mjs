const DEFAULT_CONFIG = Object.freeze({
  seed: 421337,
  days: 14,
  stepMinutes: 15,
  startCashUsd: 100,
  commitmentHours: 6,
  activationDelayMinutes: 30,
  activationFeeUsd: 0.1,
  forecastLookbackHours: 6,
  minimumExpectedProfitUsd: 0.05,
});

export function normalizeConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input };
  config.seed = integer(config.seed, DEFAULT_CONFIG.seed, 1, 2_147_483_647);
  config.days = number(config.days, DEFAULT_CONFIG.days, 1, 90);
  config.stepMinutes = integer(config.stepMinutes, DEFAULT_CONFIG.stepMinutes, 5, 60);
  config.startCashUsd = number(config.startCashUsd, DEFAULT_CONFIG.startCashUsd, 0, 1_000_000);
  config.commitmentHours = number(config.commitmentHours, DEFAULT_CONFIG.commitmentHours, 0.25, 72);
  config.activationDelayMinutes = number(config.activationDelayMinutes, DEFAULT_CONFIG.activationDelayMinutes, 0, 360);
  config.activationFeeUsd = number(config.activationFeeUsd, DEFAULT_CONFIG.activationFeeUsd, 0, 100);
  config.forecastLookbackHours = number(config.forecastLookbackHours, DEFAULT_CONFIG.forecastLookbackHours, 0.25, 72);
  config.minimumExpectedProfitUsd = number(config.minimumExpectedProfitUsd, DEFAULT_CONFIG.minimumExpectedProfitUsd, -1000, 1000);
  return config;
}

export function generateScenario(input = {}) {
  const config = normalizeConfig(input);
  const rng = mulberry32(config.seed);
  const stepHours = config.stepMinutes / 60;
  const count = Math.round((config.days * 24) / stepHours);
  const start = Date.UTC(2026, 7, 9, 0, 0, 0);
  const timeline = [];
  let reward = 0.19;
  let cost = 0.115;
  let regime = 0;

  for (let index = 0; index < count; index += 1) {
    if (index % Math.max(1, Math.round(24 / stepHours)) === 0 && index > 0) {
      const draw = rng();
      regime = draw < 0.22 ? -1 : draw > 0.72 ? 1 : 0;
    }

    const date = new Date(start + index * config.stepMinutes * 60_000);
    const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
    const dailyWave = 0.5 + 0.5 * Math.sin(((hour - 7) / 24) * Math.PI * 2);
    const shorterWave = 0.5 + 0.5 * Math.sin((index / Math.max(1, 8 / stepHours)) * Math.PI * 2);
    const demandPressure = clamp(0.44 + 0.32 * dailyWave + 0.12 * shorterWave + 0.14 * regime + normal(rng) * 0.08, 0.05, 1.35);
    const supplyPressure = clamp(0.62 + 0.08 * Math.sin(index / 31) + normal(rng) * 0.045, 0.35, 1.1);

    reward = clamp(reward + normal(rng) * 0.002 + (demandPressure - 0.7) * 0.0015, 0.12, 0.31);
    cost = clamp(cost + normal(rng) * 0.0015 + (rng() - 0.5) * 0.0008, 0.075, 0.18);

    const imbalance = demandPressure - supplyPressure;
    const jobQueue = imbalance > 0.08 ? Math.max(1, Math.round(imbalance * 22 + rng() * 3)) : 0;
    const hostQueue = imbalance < -0.08 ? Math.max(1, Math.round(-imbalance * 28 + rng() * 5)) : 0;
    const marketFill = clamp(0.52 + imbalance * 0.7 + (jobQueue > 0 ? 0.18 : 0) - (hostQueue > 0 ? 0.05 : 0), 0.08, 1);
    const jobsPerHour = Math.max(0, 1.5 + demandPressure * 23 + normal(rng) * 2.2);
    const realizedUtilization = clamp(marketFill + (jobQueue > 0 ? 0.08 : 0) - Math.min(0.22, hostQueue * 0.006) + normal(rng) * 0.06, 0, 1);

    timeline.push({
      index,
      timestamp: date.toISOString(),
      rewardUsdPerPaidHour: round(reward, 5),
      supplyCostUsdPerHour: round(cost, 5),
      jobsPerHour: round(jobsPerHour, 2),
      jobQueue,
      hostQueue,
      marketFill: round(marketFill, 4),
      realizedUtilization: round(realizedUtilization, 4),
    });
  }

  return { config, timeline };
}

export function simulate({ scenario, config: inputConfig, directives = [] }) {
  const config = normalizeConfig({ ...scenario.config, ...inputConfig });
  const timeline = scenario.timeline;
  const stepHours = config.stepMinutes / 60;
  const commitmentTicks = Math.max(1, Math.ceil(config.commitmentHours / stepHours));
  const delayTicks = Math.max(0, Math.ceil(config.activationDelayMinutes / config.stepMinutes));
  const sortedDirectives = normalizeDirectives(directives, timeline.length);
  const results = [];
  const events = [];
  let cash = config.startCashUsd;
  let cumulativeRevenue = 0;
  let cumulativeCost = 0;
  let supplyOn = false;
  let readyAt = -1;
  let lockedUntil = -1;
  let directiveCursor = 0;
  let currentMode = "auto";

  for (let index = 0; index < timeline.length; index += 1) {
    while (directiveCursor < sortedDirectives.length && sortedDirectives[directiveCursor].index === index) {
      currentMode = sortedDirectives[directiveCursor].mode;
      events.push({ index, type: "directive", text: `Mode set to ${currentMode.toUpperCase()}` });
      directiveCursor += 1;
    }

    const market = timeline[index];
    const forecast = forecastAt(timeline, index, config);
    const activationCost = supplyOn ? 0 : config.activationFeeUsd;
    const expectedWindowProfit = forecast.rewardUsdPerPaidHour * forecast.predictedUtilization * config.commitmentHours - market.supplyCostUsdPerHour * config.commitmentHours - activationCost;
    const autoWantsOn = expectedWindowProfit > config.minimumExpectedProfitUsd;
    const desiredOn = currentMode === "on" ? true : currentMode === "off" ? false : autoWantsOn;

    if (!supplyOn && desiredOn) {
      supplyOn = true;
      readyAt = index + delayTicks;
      lockedUntil = index + commitmentTicks;
      cash -= config.activationFeeUsd;
      cumulativeCost += config.activationFeeUsd;
      events.push({ index, type: "start", text: `Supply started. Ready in ${config.activationDelayMinutes}m and committed for ${config.commitmentHours}h` });
    } else if (supplyOn && !desiredOn && index >= lockedUntil) {
      supplyOn = false;
      readyAt = -1;
      events.push({ index, type: "stop", text: "Supply stopped at a commitment boundary" });
    }

    const locked = supplyOn && index < lockedUntil;
    const ready = supplyOn && index >= readyAt;
    const cost = (supplyOn ? market.supplyCostUsdPerHour : 0) * stepHours;
    const paidUtilization = ready ? market.realizedUtilization : 0;
    const revenue = market.rewardUsdPerPaidHour * paidUtilization * stepHours;
    cash += revenue - cost;
    cumulativeRevenue += revenue;
    cumulativeCost += cost;

    results.push({
      index,
      timestamp: market.timestamp,
      cashUsd: round(cash, 5),
      pnlUsd: round(cash - config.startCashUsd, 5),
      cumulativeRevenueUsd: round(cumulativeRevenue, 5),
      cumulativeCostUsd: round(cumulativeCost, 5),
      supplyOn,
      supplyReady: ready,
      locked,
      lockedUntilIndex: lockedUntil,
      mode: currentMode,
      autoWantsOn,
      expectedWindowProfitUsd: round(expectedWindowProfit, 5),
      predictedUtilization: round(forecast.predictedUtilization, 4),
      predictedRewardUsdPerPaidHour: round(forecast.rewardUsdPerPaidHour, 5),
      actualUtilization: market.realizedUtilization,
      stepRevenueUsd: round(revenue, 6),
      stepCostUsd: round(cost, 6),
    });
  }

  return { config, results, events, directives: sortedDirectives };
}

export function forecastAt(timeline, index, configInput = {}) {
  const config = normalizeConfig(configInput);
  const stepHours = config.stepMinutes / 60;
  const lookbackTicks = Math.max(1, Math.round(config.forecastLookbackHours / stepHours));
  const start = Math.max(0, index - lookbackTicks + 1);
  let totalWeight = 0;
  let weightedFill = 0;
  let weightedReward = 0;

  for (let cursor = start; cursor <= index; cursor += 1) {
    const age = index - cursor;
    const weight = Math.pow(0.84, age);
    const row = timeline[cursor];
    let signal = row.marketFill;
    if (row.jobQueue > 0 && row.hostQueue === 0) signal = Math.max(signal, 0.92);
    if (row.hostQueue > 0) signal *= 1 / (1 + row.hostQueue * 0.018);
    weightedFill += signal * weight;
    weightedReward += row.rewardUsdPerPaidHour * weight;
    totalWeight += weight;
  }

  return {
    predictedUtilization: clamp(weightedFill / totalWeight, 0, 1),
    rewardUsdPerPaidHour: weightedReward / totalWeight,
  };
}

function normalizeDirectives(directives, length) {
  const byIndex = new Map();
  for (const raw of Array.isArray(directives) ? directives : []) {
    const index = integer(raw.index, 0, 0, Math.max(0, length - 1));
    const mode = ["auto", "on", "off"].includes(raw.mode) ? raw.mode : "auto";
    byIndex.set(index, { index, mode });
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function integer(value, fallback, min, max) {
  return Math.round(number(value, fallback, min, max));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normal(rng) {
  const u = Math.max(Number.EPSILON, rng());
  const v = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}
