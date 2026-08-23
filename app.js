import { generateScenario, simulate } from "./model.mjs";

const state = {
  config: {
    seed: 421337,
    days: 14,
    stepMinutes: 15,
    startCashUsd: 100,
    commitmentHours: 6,
    activationDelayMinutes: 30,
    activationFeeUsd: 0.1,
    forecastLookbackHours: 6,
    minimumExpectedProfitUsd: 0.05,
  },
  directives: [],
  scenario: null,
  simulation: null,
  cursor: 0,
};

const $ = (id) => document.getElementById(id);

await rerun();

$("timeSlider").addEventListener("input", (event) => {
  state.cursor = Number(event.target.value);
  render();
});

document.querySelectorAll("[data-jump]").forEach((button) => {
  button.addEventListener("click", () => {
    state.cursor = clamp(state.cursor + Number(button.dataset.jump), 0, state.scenario.timeline.length - 1);
    render();
  });
});

$("jumpEnd").addEventListener("click", () => {
  state.cursor = state.scenario.timeline.length - 1;
  render();
});

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    const mode = button.dataset.mode;
    state.directives = state.directives.filter((directive) => directive.index !== state.cursor);
    state.directives.push({ index: state.cursor, mode });
    state.directives.sort((a, b) => a.index - b.index);
    await rerun({ preserveCursor: true });
    $("directiveMessage").textContent = `${mode.toUpperCase()} now persists from this timestamp until another directive changes it.`;
  });
});

$("clearDirectives").addEventListener("click", async () => {
  state.directives = [];
  await rerun({ preserveCursor: true });
  $("directiveMessage").textContent = "Manual decisions cleared. The model controls the entire replay.";
});

$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  for (const [key, value] of data.entries()) state.config[key] = Number(value);
  state.directives = [];
  await rerun();
});

async function rerun({ preserveCursor = false } = {}) {
  const oldCursor = state.cursor;
  state.scenario = generateScenario(state.config);
  state.simulation = simulate({
    scenario: state.scenario,
    config: state.config,
    directives: state.directives,
  });
  state.config = state.simulation.config;
  state.cursor = preserveCursor ? clamp(oldCursor, 0, state.scenario.timeline.length - 1) : 0;
  $("timeSlider").max = String(state.scenario.timeline.length - 1);
  $("startTime").textContent = formatTime(state.scenario.timeline[0].timestamp);
  $("endTime").textContent = formatTime(state.scenario.timeline.at(-1).timestamp);
  syncForm();
  $("serviceStatus").textContent = location.protocol === "file:" ? "local simulator" : "hosted simulator online";
  $("serviceStatus").parentElement.classList.add("ok");
  render();
}

function render() {
  const market = state.scenario.timeline[state.cursor];
  const sim = state.simulation.results[state.cursor];
  $("timeSlider").value = String(state.cursor);
  $("virtualTime").textContent = formatTime(market.timestamp);
  $("positionText").textContent = `Step ${state.cursor + 1} of ${state.scenario.timeline.length}`;
  $("cash").textContent = usd(sim.cashUsd);
  setSigned($("pnl"), sim.pnlUsd, `P&L ${signedUsd(sim.pnlUsd)}`);
  $("supplyState").textContent = sim.supplyOn ? (sim.supplyReady ? "ON / earning capable" : "STARTING") : "OFF";
  $("lockState").textContent = sim.locked ? `Committed until step ${sim.lockedUntilIndex + 1}` : "No active commitment lock";
  $("recommendation").textContent = sim.autoWantsOn ? "ON" : "OFF";
  setSigned($("expectedProfit"), sim.expectedWindowProfitUsd, `Expected next ${state.config.commitmentHours}h ${signedUsd(sim.expectedWindowProfitUsd)}`);

  $("jobQueue").textContent = String(market.jobQueue);
  $("hostQueue").textContent = String(market.hostQueue);
  $("jobsPerHour").textContent = market.jobsPerHour.toFixed(1);
  $("reward").textContent = `${usd(market.rewardUsdPerPaidHour)}/paid h`;
  $("cost").textContent = `${usd(market.supplyCostUsdPerHour)}/on h`;
  $("marketFill").textContent = percent(market.marketFill);
  $("predictedUtil").textContent = percent(sim.predictedUtilization);
  $("realizedUtil").textContent = percent(market.realizedUtilization);

  const signal = $("marketSignal");
  signal.className = "signal";
  if (market.jobQueue > 0 && market.hostQueue === 0) {
    signal.textContent = "BUYER QUEUE";
    signal.classList.add("good");
  } else if (market.hostQueue > 0) {
    signal.textContent = "HOST QUEUE";
    signal.classList.add("bad");
  } else {
    signal.textContent = "BALANCED";
  }

  renderDirective();
  renderChart();
  renderEvents();
}

function renderDirective() {
  const exact = state.directives.find((directive) => directive.index === state.cursor);
  if (exact) {
    $("directiveMessage").textContent = `Manual directive at this timestamp is ${exact.mode.toUpperCase()}.`;
    return;
  }
  const active = [...state.directives].reverse().find((directive) => directive.index < state.cursor);
  $("directiveMessage").textContent = active ? `${active.mode.toUpperCase()} inherited from step ${active.index + 1}.` : "No manual directive. The model controls this timestamp.";
}

function renderEvents() {
  const list = $("eventLog");
  list.innerHTML = "";
  const events = state.simulation.events.filter((event) => event.index <= state.cursor).slice(-14).reverse();
  if (!events.length) {
    const item = document.createElement("li");
    item.textContent = "No decisions yet.";
    list.append(item);
    return;
  }
  for (const event of events) {
    const item = document.createElement("li");
    item.textContent = `${formatShort(state.scenario.timeline[event.index].timestamp)} · ${event.text}`;
    list.append(item);
  }
}

function renderChart() {
  const svg = $("chart");
  const visible = state.simulation.results.slice(0, state.cursor + 1);
  const width = 1000;
  const height = 300;
  const pad = 42;
  const pnlValues = visible.map((row) => row.pnlUsd);
  const edgeValues = visible.map((row) => row.expectedWindowProfitUsd);
  const all = [...pnlValues, ...edgeValues, 0];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (Math.abs(max - min) < 0.001) { min -= 1; max += 1; }
  const x = (index) => pad + (index / Math.max(1, visible.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / (max - min)) * (height - pad * 2);
  const path = (values) => values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  svg.innerHTML = `<line x1="${pad}" x2="${width - pad}" y1="${zeroY}" y2="${zeroY}" stroke="#2d3948" stroke-width="1" />
    <text x="${pad}" y="22" fill="#8f9bad" font-size="12">visible history only</text>
    <path d="${path(pnlValues)}" fill="none" stroke="#56d69a" stroke-width="3" vector-effect="non-scaling-stroke" />
    <path d="${path(edgeValues)}" fill="none" stroke="#88aaff" stroke-width="2" stroke-dasharray="6 5" vector-effect="non-scaling-stroke" />
    <text x="${width - pad}" y="22" fill="#8f9bad" font-size="12" text-anchor="end">range ${signedUsd(min)} to ${signedUsd(max)}</text>`;
}

function syncForm() {
  for (const element of $("settingsForm").elements) {
    if (element.name && state.config[element.name] !== undefined) element.value = state.config[element.name];
  }
}

function setSigned(element, value, text) {
  element.textContent = text;
  element.classList.toggle("positive", value > 0);
  element.classList.toggle("negative", value < 0);
}

function usd(value) { return `$${Number(value).toFixed(2)}`; }
function signedUsd(value) { return `${value >= 0 ? "+" : "−"}$${Math.abs(Number(value)).toFixed(2)}`; }
function percent(value) { return `${(Number(value) * 100).toFixed(1)}%`; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function formatTime(value) { return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function formatShort(value) { return formatTime(value); }
