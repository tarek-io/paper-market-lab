import { allocateLiveCapital, maximumUsefulCapital } from "./live-model.mjs?v=live-4";

const LIVE_URL = "https://tarek-codex-cloud.duckdns.org/paper-live/api/live";
const PUBLIC_POLL_MS = 1_000;
const ENGINE_STALE_THRESHOLD_MS = 90_000;

let snapshot = null;
let capital = 100;
const input = document.getElementById("capitalInput");
const maxCapitalToggle = document.getElementById("maxCapitalToggle");

input.addEventListener("input", () => {
  capital = Math.max(0, Number(input.value || 0));
  renderAllocation();
});

maxCapitalToggle.addEventListener("change", () => {
  input.readOnly = maxCapitalToggle.checked;
  if (maxCapitalToggle.checked) syncCapitalToMaximum();
  renderAllocation();
});

await refresh();
setInterval(refresh, PUBLIC_POLL_MS);
setInterval(renderHeartbeat, 1_000);

async function refresh() {
  try {
    const response = await fetch(`${LIVE_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`heartbeat ${response.status}`);
    snapshot = await response.json();
    renderSnapshot();
  } catch {
    renderOffline();
  }
}

function renderSnapshot() {
  const primary = snapshot?.primary;
  const live = isExecutionLive();

  document.getElementById("inventoryBadge").textContent = `${snapshot?.market?.qualifyingUnits || 0} AVAILABLE`;
  document.getElementById("gpuName").textContent = primary?.gpu?.replace("NVIDIA ", "") || "NO MATCH";
  document.getElementById("serverName").textContent = primary ? `server ${primary.supplierServerId} · ${primary.supplierMode}` : "waiting";
  document.getElementById("supplierPrice").textContent = primary ? `${money(primary.supplyCostUsdPerHour)}/h cost` : "—";
  document.getElementById("buyerPrice").textContent = primary ? `${money(primary.rewardUsdPerPaidHour)}/h payout` : "—";

  document.getElementById("demandValue").textContent = primary
    ? primary.queuedJobs > 0
      ? `${primary.queuedJobs} queued`
      : `${primary.jobsLastHour}/h`
    : "—";
  document.getElementById("demandSub").textContent = primary
    ? primary.queuedHosts > 0
      ? `${primary.queuedHosts} hosts waiting`
      : `${primary.runningNodes} hosts running`
    : "no qualifying route";
  document.getElementById("demandMeter").style.width = primary ? `${Math.min(100, primary.queuedJobs > 0 ? 100 : primary.jobsLastHour * 5)}%` : "0%";

  const util = Number(primary?.expectedUtilization || 0);
  document.getElementById("utilValue").textContent = primary ? `${Math.round(util * 100)}%` : "—";
  document.getElementById("utilSub").textContent = primary ? `break-even ${Math.round(primary.breakEvenUtilization * 100)}%` : "market fill";
  document.getElementById("utilMeter").style.width = `${Math.round(util * 100)}%`;

  const edge = Number(primary?.expectedProfitUsd || 0);
  const edgeEl = document.getElementById("edgeValue");
  edgeEl.textContent = primary ? signedMoney(edge) : "—";
  edgeEl.className = edge > 0 ? "positive-text" : edge < 0 ? "negative-text" : "";
  document.getElementById("edgeSub").textContent = primary ? `${Math.round(primary.expectedRoi * 100)}% expected ROI` : "next 6h";
  document.getElementById("edgeMeter").style.width = primary ? `${Math.max(0, Math.min(100, primary.expectedRoi * 160))}%` : "0%";

  document.getElementById("cloreSourceDot").classList.toggle("live", isSourceFresh("clore"));
  document.getElementById("nosanaSourceDot").classList.toggle("live", isSourceFresh("nosana"));
  document.getElementById("solanaSourceDot").classList.toggle("live", isSourceFresh("solana"));
  document.getElementById("vmStatusDot").classList.toggle("live", live);
  document.getElementById("lastSnapshot").textContent = snapshot?.observedAt ? `market ${formatClock(snapshot.observedAt)}` : "no market timestamp";
  renderHeartbeat();
  renderAllocation();
}

function renderAllocation() {
  if (!snapshot) return;
  if (maxCapitalToggle.checked) syncCapitalToMaximum();
  const allocation = allocateLiveCapital(snapshot, capital);
  const commitmentHours = Number(snapshot?.config?.commitmentHours || 6);
  const maxCapital = maximumUsefulCapital(snapshot);
  const maxAllocation = allocateLiveCapital(snapshot, maxCapital);

  document.getElementById("endingCapitalLabel").textContent = `CAPITAL AFTER ${formatHours(commitmentHours)}`;
  document.getElementById("profitLabel").textContent = `EXPECTED ${formatHours(commitmentHours)} PROFIT`;
  document.getElementById("endingCapital").textContent = money(allocation.expectedEndingCapitalUsd);
  document.getElementById("capitalHint").textContent = snapshot.inventory?.length
    ? `Max useful capital ${money(maxCapital)} · ${snapshot.inventory.length} qualifying units · max profit ${signedMoney(maxAllocation.expectedProfitUsd)}`
    : "No currently qualifying units";
  maxCapitalToggle.disabled = !snapshot.inventory?.length;
  input.readOnly = maxCapitalToggle.checked;
  document.getElementById("unitCount").textContent = String(allocation.units);
  document.getElementById("deployedCapital").textContent = money(allocation.deployedCapitalUsd);
  document.getElementById("reserveCapital").textContent = money(allocation.reserveCapitalUsd);

  const profit = document.getElementById("profitBadge");
  profit.textContent = allocation.expectedProfitUsd === 0 ? "$0.00" : signedMoney(allocation.expectedProfitUsd);
  profit.className = `profit-badge ${allocation.expectedProfitUsd > 0 ? "positive" : allocation.expectedProfitUsd < 0 ? "negative" : "neutral"}`;

  const decision = document.getElementById("decisionChip");
  decision.textContent = allocation.action;
  decision.className = `decision-chip ${allocation.action === "DEPLOY" ? "deploy" : "wait"}`;
}

function renderHeartbeat() {
  if (!snapshot) return;
  const badge = document.getElementById("liveBadge");
  const engineAge = engineHeartbeatAgeMs();
  const freshEngine = engineAge < ENGINE_STALE_THRESHOLD_MS;
  const degraded = snapshot.heartbeat?.status === "degraded";
  const healthy = freshEngine && !degraded;
  const liveData = isExecutionLive();

  if (!healthy) {
    badge.className = `live-badge ${freshEngine ? "degraded" : "offline"}`;
    document.getElementById("liveLabel").textContent = freshEngine ? "DEGRADED" : "OFFLINE";
    document.getElementById("pollDetail").textContent = freshEngine ? "market feed degraded" : "market feed offline";
    document.getElementById("vmStatusDot").classList.remove("live");
    return;
  }

  if (liveData) {
    badge.className = "live-badge live";
    document.getElementById("liveLabel").textContent = "LIVE";
    document.getElementById("pollDetail").textContent = "market feed active";
  } else {
    badge.className = "live-badge degraded";
    document.getElementById("liveLabel").textContent = "DELAYED";
    document.getElementById("pollDetail").textContent = "market feed outside freshness window";
  }
  document.getElementById("vmStatusDot").classList.toggle("live", liveData);
}

function renderOffline() {
  const badge = document.getElementById("liveBadge");
  badge.className = "live-badge offline";
  document.getElementById("liveLabel").textContent = "OFFLINE";
  document.getElementById("pollDetail").textContent = "cannot reach public VM heartbeat";
}

function engineHeartbeatAgeMs() {
  const time = snapshot?.heartbeat?.cycleCompletedAt || snapshot?.generatedAt;
  if (!time) return Infinity;
  return Math.max(0, Date.now() - new Date(time).getTime());
}

function isHeartbeatFresh() {
  return engineHeartbeatAgeMs() < ENGINE_STALE_THRESHOLD_MS && snapshot?.heartbeat?.status === "live";
}

function isExecutionLive() {
  return isHeartbeatFresh() && isSourceFresh("nosana") && isSourceFresh("clore") && isSourceFresh("solana");
}

function isSourceFresh(source) {
  const freshness = snapshot?.freshness || {};
  const observedKey = `${source}ObservedAt`;
  const maxAgeKey = `${source}MaxAgeSeconds`;
  const observedAt = freshness[observedKey] || snapshot?.observedAt;
  const maxAgeSeconds = Number(freshness[maxAgeKey] || 15);
  if (!observedAt) return false;
  return Date.now() - new Date(observedAt).getTime() <= maxAgeSeconds * 1000;
}

function marketDataAgeMs() {
  const time = snapshot?.observedAt;
  if (!time) return Infinity;
  return Math.max(0, Date.now() - new Date(time).getTime());
}

function syncCapitalToMaximum() {
  if (!snapshot) return;
  capital = maximumUsefulCapital(snapshot);
  input.value = capital.toFixed(2);
}

function formatHours(value) {
  return Number.isInteger(value) ? `${value}H` : `${value.toFixed(1)}H`;
}

function money(value) { return `$${Number(value || 0).toFixed(2)}`; }
function signedMoney(value) { const number = Number(value || 0); return `${number >= 0 ? "+" : "−"}$${Math.abs(number).toFixed(2)}`; }
function formatClock(value) { return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
