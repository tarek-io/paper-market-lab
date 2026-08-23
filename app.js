import { generateScenario, simulate } from "./model.mjs?v=minimal-1";

const config = {
  seed: 421337,
  days: 14,
  stepMinutes: 15,
  startCashUsd: 100,
  commitmentHours: 6,
  activationDelayMinutes: 30,
  activationFeeUsd: 0.1,
  forecastLookbackHours: 6,
  minimumExpectedProfitUsd: 0.05,
};

const scenario = generateScenario(config);
const simulation = simulate({ scenario, config, directives: [] });
let cursor = scenario.timeline.length - 1;

const $ = (id) => document.getElementById(id);
const slider = $("timeSlider");
slider.max = String(scenario.timeline.length - 1);
slider.value = String(cursor);

slider.addEventListener("input", () => {
  cursor = Number(slider.value);
  render();
});

render();

function render() {
  const market = scenario.timeline[cursor];
  const model = simulation.results[cursor];

  const decision = $("modelDecision");
  decision.textContent = model.supplyOn ? "ON" : "OFF";
  decision.className = `decision ${model.supplyOn ? "on" : "off"}`;

  $("decisionReason").textContent = reasonFor(market, model);

  const pnl = $("pnlValue");
  pnl.textContent = signedUsd(model.pnlUsd);
  pnl.className = model.pnlUsd > 0 ? "positive" : model.pnlUsd < 0 ? "negative" : "";

  $("virtualTime").textContent = formatTime(market.timestamp);
  $("timePosition").textContent = `${cursor + 1} / ${scenario.timeline.length}`;
  $("demand").textContent = demandText(market);

  const edge = $("edge");
  edge.textContent = signedUsd(model.expectedWindowProfitUsd);
  edge.className = model.expectedWindowProfitUsd > 0 ? "positive" : model.expectedWindowProfitUsd < 0 ? "negative" : "";

  $("utilization").textContent = `${(model.predictedUtilization * 100).toFixed(0)}%`;
  drawChart();
}

function reasonFor(market, model) {
  if (model.supplyOn && model.locked) return `Supply is committed through the current ${config.commitmentHours}-hour window.`;
  if (model.supplyOn) return `Expected next-window profit is ${signedUsd(model.expectedWindowProfitUsd)}.`;
  if (market.hostQueue > 0) return `${market.hostQueue} hosts are already waiting for work, so the model stays out.`;
  if (market.jobQueue > 0) return `${market.jobQueue} buyer jobs are waiting, but expected profit still does not clear the model threshold.`;
  return `Expected next-window profit is ${signedUsd(model.expectedWindowProfitUsd)}, below the activation threshold.`;
}

function demandText(market) {
  if (market.jobQueue > 0) return `${market.jobQueue} jobs waiting`;
  if (market.hostQueue > 0) return `${market.hostQueue} hosts waiting`;
  return "balanced";
}

function drawChart() {
  const svg = $("chart");
  const rows = simulation.results.slice(0, cursor + 1);
  const values = rows.map((row) => row.pnlUsd);
  const width = 900;
  const height = 150;
  const pad = 4;
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (max - min < 0.01) { min -= 1; max += 1; }
  const x = (index) => pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / (max - min)) * (height - pad * 2);
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const stroke = values.at(-1) >= 0 ? "#16a36a" : "#d94d4d";
  svg.innerHTML = `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="3" vector-effect="non-scaling-stroke" />`;
}

function signedUsd(value) {
  const number = Number(value);
  return `${number >= 0 ? "+" : "−"}$${Math.abs(number).toFixed(2)}`;
}

function formatTime(value) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
