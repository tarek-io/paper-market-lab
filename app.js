import { allocateCapital, generateScenario } from "./model.mjs?v=capital-1";

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
const index = scenario.timeline.length - 1;
const input = document.getElementById("capitalInput");

input.addEventListener("input", render);
document.getElementById("capitalForm").addEventListener("submit", (event) => event.preventDefault());

render();

function render() {
  const capital = Math.max(0, Number(input.value || 0));
  const result = allocateCapital({ timeline: scenario.timeline, index, capitalUsd: capital, config });

  const action = document.getElementById("action");
  action.textContent = result.action === "DEPLOY" ? `DEPLOY ${result.units} UNIT${result.units === 1 ? "" : "S"}` : "WAIT";
  action.className = `action ${result.action === "DEPLOY" ? "deploy" : "wait"}`;

  document.getElementById("startingCapital").textContent = money(result.startingCapitalUsd);
  document.getElementById("endingCapital").textContent = money(result.expectedEndingCapitalUsd);

  const profit = document.getElementById("profit");
  profit.textContent = result.expectedProfitUsd > 0
    ? `Expected profit +${money(result.expectedProfitUsd)} over ${config.commitmentHours} hours`
    : `Expected profit ${money(result.expectedProfitUsd)} over ${config.commitmentHours} hours`;
  profit.className = `profit ${result.expectedProfitUsd > 0 ? "positive" : result.expectedProfitUsd < 0 ? "negative" : ""}`;

  document.getElementById("explanation").textContent = explanation(result);
}

function explanation(result) {
  if (!result.shouldActivate) return `The deterministic rule says stay out. Expected profit per supply unit is ${signedMoney(result.expectedProfitPerUnitUsd)}, below the activation threshold.`;
  if (result.units < 1) return `The opportunity passes the rule, but one supply unit requires ${money(result.commitmentCostPerUnitUsd)} of fake capital for the next ${config.commitmentHours}-hour commitment.`;
  return `${money(result.deployedCapitalUsd)} is deployed across ${result.units} whole supply unit${result.units === 1 ? "" : "s"}. ${money(result.reserveCapitalUsd)} remains unused. Expected profit per deployed unit is ${signedMoney(result.expectedProfitPerUnitUsd)}.`;
}

function money(value) { return `$${Number(value).toFixed(2)}`; }
function signedMoney(value) { const number = Number(value); return `${number >= 0 ? "+" : "−"}$${Math.abs(number).toFixed(2)}`; }
