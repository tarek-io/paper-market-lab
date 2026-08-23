import { allocateLiveCapital } from "./live-model.mjs?v=live-1";

const LIVE_URL = "https://api.github.com/repos/tarek-io/paper-market-lab/contents/live.json?ref=live";
const PUBLIC_POLL_MS = 75_000;
const STALE_AFTER_MS = 210_000;

let snapshot = null;
let capital = 100;
const input = document.getElementById("capitalInput");

input.addEventListener("input", () => {
  capital = Math.max(0, Number(input.value || 0));
  renderAllocation();
});

await refresh();
setInterval(refresh, PUBLIC_POLL_MS);
setInterval(renderHeartbeat, 1_000);

async function refresh() {
  try {
    const response = await fetch(LIVE_URL, {
      cache: "no-store",
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`heartbeat ${response.status}`);
    const envelope = await response.json();
    const encoded = String(envelope.content || "").replace(/\s/g, "");
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    snapshot = JSON.parse(new TextDecoder().decode(bytes));
    renderSnapshot();
  } catch {
    renderOffline();
  }
}

function renderSnapshot() {
  const primary = snapshot?.primary;
  const live = isHeartbeatFresh();

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

  for (const dot of document.querySelectorAll(".source-dot")) dot.classList.toggle("live", live);
  document.getElementById("vmStatusDot").classList.toggle("live", live);
  document.getElementById("lastSnapshot").textContent = snapshot?.observedAt ? `market ${formatClock(snapshot.observedAt)}` : "no market timestamp";
  renderHeartbeat();
  renderAllocation();
}

function renderAllocation() {
  if (!snapshot) return;
  const allocation = allocateLiveCapital(snapshot, capital);
  document.getElementById("endingCapital").textContent = money(allocation.expectedEndingCapitalUsd);
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
  const age = heartbeatAgeMs();
  const fresh = age < STALE_AFTER_MS;
  const degraded = snapshot.heartbeat?.status === "degraded";
  badge.className = `live-badge ${fresh ? degraded ? "degraded" : "live" : "offline"}`;
  document.getElementById("liveLabel").textContent = fresh ? degraded ? "DEGRADED" : "LIVE" : "STALE";
  document.getElementById("liveAge").textContent = `${ageLabel(age)} ago`;
  document.getElementById("pollDetail").textContent = fresh
    ? `VM ${snapshot.heartbeat?.pollIntervalSeconds || 60}s · dashboard 75s · sequence ${snapshot.heartbeat?.sequence || "—"}`
    : "heartbeat is stale";
  document.getElementById("vmStatusDot").classList.toggle("live", fresh && !degraded);
}

function renderOffline() {
  const badge = document.getElementById("liveBadge");
  badge.className = "live-badge offline";
  document.getElementById("liveLabel").textContent = "OFFLINE";
  document.getElementById("liveAge").textContent = "no heartbeat";
  document.getElementById("pollDetail").textContent = "cannot reach public VM heartbeat";
}

function heartbeatAgeMs() {
  const time = snapshot?.heartbeat?.cycleCompletedAt || snapshot?.generatedAt;
  if (!time) return Infinity;
  return Math.max(0, Date.now() - new Date(time).getTime());
}

function isHeartbeatFresh() {
  return heartbeatAgeMs() < STALE_AFTER_MS && snapshot?.heartbeat?.status === "live";
}

function ageLabel(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "∞";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function money(value) { return `$${Number(value || 0).toFixed(2)}`; }
function signedMoney(value) { const number = Number(value || 0); return `${number >= 0 ? "+" : "−"}$${Math.abs(number).toFixed(2)}`; }
function formatClock(value) { return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
