const $ = (id) => document.getElementById(id);

const IS_SHARED_VIEW = new URLSearchParams(window.location.search).get("shared") === "1";
const IS_GITHUB_PORTAL = window.location.hostname === "mvisl.github.io";
const PORTAL_API_ORIGIN = IS_GITHUB_PORTAL ? "https://institute.167-99-214-34.sslip.io" : window.location.origin;
const PORTAL_ACCESS_TOKEN_KEY = "institute_portal_access_token";
let currentState = null;
let periodRangeMs = 60 * 60 * 1000;
let chartRangeMs = null;
let feedFilter = "trades";
let chartFilter = "all";
let chartLaneFilter = "all";
let insightFilter = "all";
let strategyMetric = "sum";
let strategyRangeMs = null;
let strategyProviderFilter = "combined";
let dashboardStrategyView = null;
let audioContext = null;
let soundArmed = false;
let seenClosedReviewIds = null;
let activeMobileSection = null;
let eventSource = null;
let lastRenderAt = 0;
let fallbackRefreshInFlight = false;
let apiLocked = false;
let robotStopCountdown = null;
let activePortalPage = "dashboard";
let researchContourFilter = "ACTIVE";
const PORTAL_PAGES = [
  { id: "dashboard", label: "Dashboard", icon: "◫", visible: true, order: 10 },
  { id: "research", label: "Research", icon: "⌁", visible: true, order: 20 },
  { id: "handoff", label: "Handoff", icon: "⇄", visible: true, order: 30 },
  { id: "council", label: "Council", icon: "◇", visible: true, order: 40 },
];
const REAL_DASHBOARD_VIEWS = new Set(["real", "earn"]);
const DEMO_DASHBOARD_VIEWS = new Set(["demo", "investigate", "demo_earn"]);
const DEMO_EARN_EVENT_RE = /demo_earn|earn_challenger|parallel_discovery/i;

if (IS_SHARED_VIEW) {
  document.body.classList.add("shared-view");
}

function portalAccessToken() {
  return IS_GITHUB_PORTAL ? sessionStorage.getItem(PORTAL_ACCESS_TOKEN_KEY) || "" : "";
}

function portalApiUrl(value) {
  if (/^https?:\/\//i.test(String(value || ""))) return String(value);
  return new URL(String(value || "").replace(/^\//, ""), `${PORTAL_API_ORIGIN}/`).toString();
}

async function portalFetch(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = portalAccessToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(portalApiUrl(pathname), {
    ...options,
    headers,
    cache: options.cache || "no-store",
  });
}

function showPortalLogin(message = "Dashboard code required.") {
  if (!IS_GITHUB_PORTAL) return;
  $("portalAuthOverlay")?.removeAttribute("hidden");
  setText("portalAuthStatus", message);
  $("portalAuthCode")?.focus();
}

function hidePortalLogin() {
  $("portalAuthOverlay")?.setAttribute("hidden", "");
  setText("portalAuthStatus", "");
}

function bindPortalLogin() {
  const form = $("portalAuthForm");
  if (!form || !IS_GITHUB_PORTAL) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = String($("portalAuthCode")?.value || "");
    setText("portalAuthStatus", "Connecting…");
    try {
      const response = await portalFetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.accessToken) throw new Error(payload.error || "Wrong dashboard code");
      sessionStorage.setItem(PORTAL_ACCESS_TOKEN_KEY, payload.accessToken);
      if ($("portalAuthCode")) $("portalAuthCode").value = "";
      hidePortalLogin();
      await refreshState("login");
    } catch (error) {
      setText("portalAuthStatus", error.message || "Login failed");
    }
  });
  if (!portalAccessToken()) showPortalLogin();
}

const TRADE_FEED_TYPES = new Set([
  "demo_open_trade_snapshot",
  "real_open_trade_snapshot",
  "demo_trade_opened",
  "demo_pending_order_opened",
  "demo_trade_failed",
  "demo_pending_order_failed",
  "real_calibration_trade_opened",
  "real_calibration_auto_close",
  "real_calibration_trade_failed",
  "real_micro_validation_planned",
  "real_micro_validation_skipped",
  "real_micro_validation_trade_opened",
  "real_micro_validation_auto_close",
  "real_micro_validation_trade_failed",
  "real_micro_validation_failed",
  "real_long_probe_planned",
  "real_long_horizon_probe_opened",
  "real_long_probe_auto_close",
  "real_long_probe_failed",
  "real_long_probe_auto_close_failed",
  "real_earn_planned",
  "real_earn_skipped",
  "real_earn_trade_opened",
  "real_earn_auto_close",
  "real_earn_trade_failed",
  "closed_trade_review",
  "open_trade_review",
]);
const EARN_HIDDEN_SECTION_IDS = [
  "insights-section",
  "strategy-balance-section",
  "hypothesis-health-section",
  "execution-section",
  "scanner-section",
  "market-section",
  "codex-handoff",
];

function fmtTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    hour12: false,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? "-";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function compactText(value, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= max) return text || "-";
  const clipped = text.slice(0, Math.max(0, max - 1)).trimEnd();
  return `${clipped}…`;
}

function setCompactText(id, value, max = 180) {
  const el = $(id);
  if (!el) return;
  const full = String(value ?? "-").trim() || "-";
  el.textContent = compactText(full, max);
  el.dataset.fullText = full;
  const hasDetails = full.length > max;
  el.classList.toggle("has-details", hasDetails);
  el.title = hasDetails ? "Нажми, чтобы открыть подробности" : "";
}

function executionState(state) {
  return state?.execution || {
    provider: "CDP_LEGACY",
    current: "CDP_LEGACY",
    online: Boolean(state?.cdp?.connected),
    mt5: state?.mt5 || {},
  };
}

function mt5Lane(state, role) {
  return state?.mt5?.[role] || state?.execution?.mt5?.[role] || {};
}

function ageLabel(ms) {
  if (!Number.isFinite(Number(ms))) return "-";
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function mt5LaneStatusText(lane) {
  const heartbeat = lane?.heartbeat || {};
  const online = Boolean(heartbeat.ok);
  const positions = Number(lane?.counts?.positions || 0);
  const history = Number(lane?.counts?.history || 0);
  const pending = Number(lane?.counts?.pendingOrders || 0);
  return `${online ? "online" : "offline"} · positions ${positions} · pending ${pending} · history ${history}`;
}

function mt5LaneMetaText(lane) {
  const heartbeat = lane?.heartbeat || {};
  const login = lane?.login || "login ?";
  const server = lane?.server || "server ?";
  const age = ageLabel(heartbeat.ageMs);
  const trade = heartbeat.tradeAllowed === null ? "trade ?" : heartbeat.tradeAllowed ? "trade allowed" : "trade blocked";
  const errors = Array.isArray(lane?.errors) && lane.errors.length ? ` · ${lane.errors.slice(0, 2).join(" · ")}` : "";
  return `${lane?.accountSource || "MT5"} · ${login} @ ${server} · heartbeat ${age} · ${trade}${errors}`;
}

function normalizeReviewExecutionProvider(value) {
  const text = String(value || "").trim().toUpperCase();
  if (text === "MT5" || text === "MT5_DEMO") return "MT5_DEMO";
  if (text === "MT5_REAL") return "MT5_REAL";
  if (text === "CDP" || text === "CDP_LEGACY" || text === "LIBERTEX_CDP") return "CDP_LEGACY";
  return "CDP_LEGACY";
}

function reviewExecutionProvider(item) {
  return normalizeReviewExecutionProvider(item?.executionProvider || item?.execution?.provider || item?.executionSource || item?.provider);
}

function reviewProviderLabel(item) {
  const provider = reviewExecutionProvider(item);
  if (provider === "MT5_DEMO") return "MT5 Demo";
  if (provider === "MT5_REAL") return "MT5 Real";
  return "CDP legacy";
}

function reviewMatchesProviderFilter(item, filter = strategyProviderFilter) {
  const provider = reviewExecutionProvider(item);
  if (filter === "mt5") return provider.startsWith("MT5");
  if (filter === "cdp") return provider === "CDP_LEGACY";
  return true;
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${sign}$${Math.abs(number).toFixed(2)}`;
}

function percentText(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${Math.round(Number(value) * 100)}%`;
}

function percentPointText(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(Math.abs(number) >= 1 ? 2 : 3)}%`;
}

function durationText(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "-";
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
}

function compactMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  const abs = Math.abs(number);
  const trim = (text) => text.replace(/\.0$/, "");
  if (abs >= 1000000) return `${sign}$${trim((abs / 1000000).toFixed(abs < 10000000 ? 1 : 0))}M`;
  if (abs >= 1000) return `${sign}$${trim((abs / 1000).toFixed(abs < 10000 ? 1 : 0))}K`;
  if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
  if (abs === 0) return "$0";
  return `${sign}$${trim(abs.toFixed(1))}`;
}

function currentDashboardView(state = currentState) {
  const requested = dashboardStrategyView || "demo_earn";
  if (REAL_DASHBOARD_VIEWS.has(requested)) return "real";
  if (DEMO_DASHBOARD_VIEWS.has(requested)) return "demo";
  return "demo";
}

function dashboardUsesRealMetrics(state = currentState) {
  return currentDashboardView(state) === "real";
}

function currentDashboardLane(state = currentState) {
  const requested = dashboardStrategyView || "demo_earn";
  if (REAL_DASHBOARD_VIEWS.has(requested)) return "real";
  if (requested === "investigate") return "investigate";
  if (requested === "demo" || requested === "demo_earn") return "demo_earn";
  return demoStrategyMode(state);
}

function demoStrategyMode(state = currentState) {
  return state?.strategyMode === "earn" ? "earn" : "investigate";
}

function activeDemoDashboardLane(state = currentState) {
  const exposureMode = String(state?.performance?.demoExposureMode || "").toLowerCase();
  if (exposureMode === "earn") return "demo_earn";
  if (["explore", "investigate"].includes(exposureMode)) return "investigate";
  return demoStrategyMode(state) === "earn" ? "demo_earn" : "investigate";
}

function demoEarnIsActive(state = currentState) {
  return demoStrategyMode(state) === "earn";
}

function demoEarnEvent(item) {
  const payload = item?.payload || {};
  const type = String(item?.type || "");
  const mode = String(payload.tradePolicy?.mode || payload.mode || payload.strategyMode || "").toLowerCase();
  const lane = String(payload.lane || payload.accountLane || payload.tradePolicy?.lane || payload.strategyLane || "").toLowerCase();
  const risk = String(payload.tradePolicy?.riskProfile || payload.riskProfile || payload.hypothesis || payload.reason || "").toLowerCase();
  return type === "demo_open_trade_snapshot"
    ? String(payload.mode || "").toLowerCase() === "demo_earn"
    : mode === "earn" ||
      lane === "demo_earn" ||
      payload.demoEarnChallenger?.enabled === true ||
      payload.demoEarnParallelDiscovery?.enabled === true ||
      DEMO_EARN_EVENT_RE.test(`${type} ${mode} ${lane} ${risk}`);
}

function demoInvestigateEvent(item) {
  return !isEarnFeedItem(item) && !demoEarnEvent(item);
}

function realLaneStatus(state = currentState) {
  return String(state?.risk?.realLane?.status || "DISABLED");
}

function realLaneIsActive(state = currentState) {
  return ["ARMED", "LIVE", "DRAINING"].includes(realLaneStatus(state));
}

function globalStopStatus(state = currentState) {
  return String(state?.globalStop?.status || "IDLE").toUpperCase();
}

function clearRobotStopCountdown({ rerender = true } = {}) {
  if (!robotStopCountdown) return;
  clearTimeout(robotStopCountdown.timeoutId);
  clearInterval(robotStopCountdown.intervalId);
  robotStopCountdown = null;
  if (rerender && currentState) render(currentState);
}

async function confirmRobotStopCountdown() {
  if (!robotStopCountdown || robotStopCountdown.submitting) return;
  robotStopCountdown.submitting = true;
  clearTimeout(robotStopCountdown.timeoutId);
  clearInterval(robotStopCountdown.intervalId);
  try {
    clearRobotStopCountdown({ rerender: false });
    render(await postJson("/api/robot-toggle", { running: false }));
  } catch (error) {
    clearRobotStopCountdown({ rerender: false });
    throw error;
  }
}

function startRobotStopCountdown() {
  clearRobotStopCountdown({ rerender: false });
  const deadline = Date.now() + 5000;
  robotStopCountdown = {
    deadline,
    submitting: false,
    timeoutId: null,
    intervalId: null,
  };
  robotStopCountdown.timeoutId = setTimeout(() => {
    confirmRobotStopCountdown().catch((error) => console.warn("robot stop failed", error));
  }, Math.max(0, deadline - Date.now()));
  robotStopCountdown.intervalId = setInterval(() => {
    if (!robotStopCountdown) return;
    if (Date.now() >= robotStopCountdown.deadline) return;
    if (currentState) render(currentState);
  }, 200);
  if (currentState) render(currentState);
}

function realLaneSummary(state = currentState) {
  const summary = state?.risk?.realLane?.summary || {};
  const realTerminal = state?.realTerminal || {};
  const terminalOpenTrades = Math.max(
    Number(realTerminal.activeTradesCount || 0) || 0,
    Array.isArray(realTerminal.activeTrades) ? realTerminal.activeTrades.length : 0,
    Number(realTerminal.usedValue || 0) > 0.01 || Math.abs(Number(realTerminal.profitValue || 0)) > 0.01 ? 1 : 0,
  );
  const openTrades = Math.max(Number(summary.openTrades || 0) || 0, terminalOpenTrades);
  const closedTradesAll = Number(summary.closedTradesAll ?? summary.closedTrades ?? 0) || 0;
  const closedTrades24h = Number(summary.closedTrades24h ?? 0) || 0;
  const closedTrades = closedTradesAll;
  const totalTrades = Number.isFinite(Number(summary.totalTradesAll ?? summary.totalTrades))
    ? Number(summary.totalTradesAll ?? summary.totalTrades)
    : (openTrades + closedTradesAll);
  const totalTrades24h = Number.isFinite(Number(summary.totalTrades24h))
    ? Number(summary.totalTrades24h)
    : (openTrades + closedTrades24h);
  const openProfitUsd = Number.isFinite(Number(realTerminal.profitValue))
    ? Number(realTerminal.profitValue)
    : Number(summary.openProfitUsd || 0);
  const realizedProfitUsd = Number(summary.realizedProfitAllUsd ?? summary.realizedProfitUsd ?? 0) || 0;
  const netProfitUsd = Number.isFinite(Number(summary.netProfitAllUsd ?? summary.netProfitUsd))
    ? Number(summary.netProfitAllUsd ?? summary.netProfitUsd)
    : (openProfitUsd + realizedProfitUsd);
  return {
    openTrades,
    closedTrades,
    closedTradesAll,
    closedTrades24h,
    totalTrades,
    totalTradesAll: totalTrades,
    totalTrades24h,
    openProfitUsd,
    realizedProfitUsd,
    realizedProfitAllUsd: realizedProfitUsd,
    netProfitUsd,
    netProfitAllUsd: netProfitUsd,
  };
}

function realTerminalSnapshot(state = currentState) {
  const terminal = state?.realTerminal || {};
  return {
    account: terminal.account || null,
    accountType: terminal.accountType || null,
    accountGuard: terminal.accountGuard || "real-required",
    balanceValue: Number(terminal.balanceValue || 0) || 0,
    balanceText: terminal.balance || null,
    profitValue: Number(terminal.profitValue || 0) || 0,
    profitText: terminal.profit || null,
    usedValue: Number(terminal.usedValue || 0) || 0,
    usedText: terminal.used || null,
    availableValue: Number(terminal.availableValue || 0) || 0,
    availableText: terminal.available || null,
    activeTradesCount: Number(terminal.activeTradesCount || 0) || 0,
    pendingTradesCount: Number(terminal.pendingTradesCount || 0) || 0,
    closedTrades24hCount: Number(terminal.closedTrades24hCount || 0) || 0,
    lastError: terminal.lastError || null,
  };
}

function realLaneHasFundedActivity(state = currentState) {
  const summary = realLaneSummary(state);
  const realTerminal = realTerminalSnapshot(state);
  const liveEnabled = Boolean(state?.risk?.liveTradingEnabled);
  return liveEnabled ||
    realTerminal.accountType === "real" ||
    (realTerminal.accountType === "real" && realTerminal.balanceValue > 0) ||
    summary.totalTrades > 0 ||
    summary.openTrades > 0 ||
    Math.abs(summary.netProfitUsd) > 0.001;
}

function currentFeedItems(state = currentState) {
  const view = currentDashboardView(state);
  if (view === "real") {
    const openSnapshots = currentRealOpenFeedItems(state);
    const reviews = (state?.learning?.realClosedTradeReviews || []).map((review) => ({
      type: "closed_trade_review",
      time: review.time || review.closeTimestamp || review.createdAt || null,
      payload: {
        ...review,
        lane: "real",
        mode: "earn",
      },
    }));
    return aggregateRepeatedFeedItems([...openSnapshots, ...reviews, ...(state?.scanner?.realDecisions || [])]
      .sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0)));
  }
  const lane = currentDashboardLane(state);
  const activeDemoLane = activeDemoDashboardLane(state);
  const openSnapshots = lane === activeDemoLane ? currentDemoOpenFeedItems(state, lane) : [];
  const demoEvents = (state?.scanner?.decisions || [])
    .filter((item) => !isEarnFeedItem(item))
    .filter((item) => lane === "demo_earn" ? demoEarnEvent(item) : demoInvestigateEvent(item));
  return aggregateRepeatedFeedItems([...openSnapshots, ...demoEvents]
    .sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0)));
}

function buildOpenTradeFeedItems(terminal = {}, type, lane, mode, fallbackInstrument) {
  const openTrades = Array.isArray(terminal.activeTrades) ? terminal.activeTrades : [];
  const usedValue = Number(terminal.usedValue || 0) || 0;
  const profitValue = Number(terminal.profitValue || 0) || 0;
  const hasExposureSnapshot = Math.abs(usedValue) > 0.01 || Math.abs(profitValue) > 0.01;
  const activeCount = Number(terminal.activeTradesCount || openTrades.length || (hasExposureSnapshot ? 1 : 0) || 0) || 0;
  if (openTrades.length > 0) {
    return openTrades.map((trade, index) => {
      const time = trade.stats?.firstSeenAt || parseOpenTradeDateForUi(trade.openingDate) || terminal.lastGoodSnapshotAt || new Date().toISOString();
      return {
        type,
        time,
        payload: {
          ...trade,
          lane,
          mode,
          instrument: trade.instrument || terminal.selectedInstrument || fallbackInstrument,
          amount: firstDefined(trade.amount, trade.resultValue, terminal.usedValue),
          multiplier: trade.multiplier,
          profitText: trade.profitText || terminal.profit || money(terminal.profitValue || 0),
          profitValue: Number.isFinite(Number(trade.profitValue)) ? Number(trade.profitValue) : Number(terminal.profitValue || 0),
          snapshotIndex: index + 1,
          snapshotTotal: openTrades.length,
        },
      };
    });
  }
  if (activeCount <= 0) return [];
  return [{
    type,
    time: terminal.lastGoodSnapshotAt || new Date().toISOString(),
    payload: {
      lane,
      mode,
      instrument: terminal.selectedInstrument || fallbackInstrument,
      amount: terminal.usedValue || null,
      profitText: terminal.profit || money(terminal.profitValue || 0),
      profitValue: Number(terminal.profitValue || 0) || 0,
      snapshotIndex: 1,
      snapshotTotal: activeCount,
      reason: hasExposureSnapshot ? "live_terminal_exposure_snapshot" : "live_real_terminal_snapshot",
    },
  }];
}

function currentDemoOpenFeedItems(state = currentState, requestedLane = null) {
  const activeLane = activeDemoDashboardLane(state);
  if (requestedLane && requestedLane !== activeLane) return [];
  return buildOpenTradeFeedItems(state?.terminal || {}, "demo_open_trade_snapshot", "demo", activeLane, "Demo-сделка");
}

function currentDemoLaneOpenCount(state = currentState, requestedLane = null) {
  const activeLane = activeDemoDashboardLane(state);
  const lane = requestedLane || currentDashboardLane(state);
  if (lane !== activeLane) return 0;
  const terminal = state?.terminal || {};
  const exposureOpenCount = Number(terminal.usedValue || 0) > 0.01 || Math.abs(Number(terminal.profitValue || 0)) > 0.01
    ? 1
    : 0;
  return Math.max(
    Number(terminal.activeTradesCount || 0) || 0,
    Array.isArray(terminal.activeTrades) ? terminal.activeTrades.length : 0,
    exposureOpenCount,
  );
}

function currentRealOpenFeedItems(state = currentState) {
  return buildOpenTradeFeedItems(state?.realTerminal || {}, "real_open_trade_snapshot", "real", "earn", "Real-сделка");
}

function parseOpenTradeDateForUi(value) {
  const match = String(value || "").match(/^(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, day, monthName, hour, minute, second] = match;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(monthName);
  if (month < 0) return null;
  const date = new Date();
  date.setMonth(month, Number(day));
  date.setHours(Number(hour), Number(minute), Number(second), 0);
  if (date.getTime() - Date.now() > 24 * 60 * 60 * 1000) date.setFullYear(date.getFullYear() - 1);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function currentClosedReviewItems(state = currentState) {
  const view = currentDashboardView(state);
  return view === "real"
    ? (state?.learning?.realClosedTradeReviews || [])
    : (state?.learning?.closedTradeReviews || []);
}

function realClosedReviewState(state = currentState) {
  const summary = realLaneSummary(state);
  const reviews = state?.learning?.realClosedTradeReviews || [];
  const backlog = Math.max(0, Number(summary.closedTradesAll || 0) - reviews.length);
  return {
    closedAll: summary.closedTradesAll,
    closed24h: summary.closedTrades24h,
    reviewed: reviews.length,
    backlog,
    realized: summary.realizedProfitAllUsd,
    net: summary.netProfitAllUsd,
    hasSummaryOnly: summary.closedTradesAll > 0 && reviews.length === 0,
    hasBacklog: backlog > 0,
  };
}

function buildRealMetricHistory(state = currentState) {
  const reviews = [...(state?.learning?.realClosedTradeReviews || [])]
    .sort((a, b) => reviewTimestamp(a) - reviewTimestamp(b));
  const summary = realLaneSummary(state);
  const realTerminal = realTerminalSnapshot(state);
  const realLane = state?.risk?.realLane || {};
  const points = [];
  let cumulativeNet = 0;

  const terminalHistory = Array.isArray(state?.realTerminal?.history) ? state.realTerminal.history : [];
  for (const point of terminalHistory) {
    if (!Number.isFinite(Date.parse(point.time || 0))) continue;
    points.push({
      time: point.time,
      balance: Number.isFinite(Number(point.balance)) ? Number(point.balance) : (realTerminal.balanceValue || null),
      used: Number(point.used || 0) || 0,
      openProfit: Number(point.openProfit || 0) || 0,
      profitKnown: true,
      strategyMode: "earn",
      lane: "real",
    });
  }

  for (const review of reviews) {
    const timestamp = reviewTimestamp(review);
    if (!Number.isFinite(timestamp)) continue;
    cumulativeNet = Number((cumulativeNet + reviewProfitValue(review)).toFixed(2));
    points.push({
      time: new Date(timestamp).toISOString(),
      balance: realTerminal.balanceValue || null,
      used: 0,
      openProfit: cumulativeNet,
      profitKnown: true,
      strategyMode: "earn",
      lane: "real",
    });
  }

  if (!points.length && (summary.closedTradesAll > 0 || Number(realLane.longProbeCompletedCount || 0) > 0)) {
    const closeTime = Date.parse(realLane.lastLongProbeCloseAt || realLane.lastTransitionAt || 0);
    const openTime = Date.parse(realLane.lastLongProbeOpenAt || 0);
    const net = Number(summary.netProfitAllUsd ?? summary.netProfitUsd ?? 0) || 0;
    if (Number.isFinite(openTime)) {
      points.push({
        time: new Date(openTime).toISOString(),
        balance: realTerminal.balanceValue || null,
        used: 10,
        openProfit: 0,
        profitKnown: true,
        strategyMode: "earn",
        lane: "real",
        synthetic: true,
      });
    }
    if (Number.isFinite(closeTime)) {
      points.push({
        time: new Date(closeTime).toISOString(),
        balance: realTerminal.balanceValue || null,
        used: 0,
        openProfit: net,
        profitKnown: true,
        strategyMode: "earn",
        lane: "real",
        synthetic: true,
      });
      cumulativeNet = net;
    }
  }

  const currentNet = Number((cumulativeNet + Number(summary.openProfitUsd || 0)).toFixed(2));
  if (points.length || realTerminal.activeTradesCount > 0 || Math.abs(currentNet) > 0.001) {
    const last = points.at(-1);
    if (!last && realTerminal.activeTradesCount > 0) {
      points.push({
        time: new Date(Date.now() - 60 * 1000).toISOString(),
        balance: realTerminal.balanceValue || null,
        used: realTerminal.usedValue || 0,
        openProfit: currentNet,
        profitKnown: true,
        strategyMode: "earn",
        lane: "real",
        synthetic: true,
      });
    }
    const currentPoint = {
      time: new Date().toISOString(),
      balance: realTerminal.balanceValue || null,
      used: realTerminal.usedValue || 0,
      openProfit: currentNet,
      profitKnown: true,
      strategyMode: "earn",
      lane: "real",
    };
    if (!last || Math.abs(Number(last.openProfit || 0) - currentPoint.openProfit) > 0.0001 || Number(last.used || 0) !== currentPoint.used || Date.now() - Date.parse(last.time || 0) > 60 * 1000) {
      points.push(currentPoint);
    }
  }

  return [...points].sort((a, b) => Date.parse(a.time || 0) - Date.parse(b.time || 0));
}

function strongestRealPromotion(state = currentState) {
  const promotions = state?.learning?.improvement?.promotions || [];
  return promotions[0] || null;
}

function weakestMatureRealBlocker(state = currentState) {
  const cohorts = state?.learning?.improvement?.cohorts || [];
  return cohorts
    .filter((item) => Number(item?.effectiveN || 0) >= 20)
    .filter((item) => item?.status === "reject_or_cooldown" || item?.status === "mature_mixed")
    .sort((a, b) => (
      Number(b?.effectiveN || 0) - Number(a?.effectiveN || 0) ||
      Number(a?.wilsonLower || 0) - Number(b?.wilsonLower || 0)
    ))[0] || null;
}

function nextRealMaturityTarget(state = currentState) {
  const targets = state?.learning?.improvement?.maturityTargets || [];
  return targets[0] || null;
}

function cohortShortText(item) {
  if (!item) return "";
  const instrument = item.instrument || "unknown";
  const side = item.side || "UNKNOWN";
  const bracket = setupLabel(item.bracketProfile) || "профиль ?";
  const n = Number(item.effectiveN || item.rawN || 0);
  const wins = Number(item.effectiveWins || item.wins || 0);
  const net = money(Number(item.net || 0));
  const pf = item.profitFactor === "Infinity" ? "inf" : Number(item.profitFactor || 0).toFixed(2);
  const wilson = Math.round(Number(item.wilsonLower || 0) * 100);
  return `${instrument} ${side} ${bracket}: n=${n}, wins=${wins}, net ${net}, PF ${pf}, Wilson ${wilson}%`;
}

function cohortGateUiText(item) {
  if (!item) return "";
  const n = Number(item.effectiveN || item.rawN || 0);
  const targetN = Number(item.matureTargetN || 20);
  const needed = Math.max(0, Number(item.needed ?? item.sampleGap ?? Math.max(0, targetN - n)) || 0);
  const quality = Number(item.setupQualityMedian ?? item.setupQualityP75 ?? 0);
  const qualityRequired = Number(item.setupQualityRequired || 30);
  const wilson = Number(item.wilsonLower || 0);
  const promoteWilson = Number(item.promoteWilsonTarget || 0.41);
  const earnWilson = Number(item.earnWilsonTarget || 0.45);
  const pf = item.profitFactor === "Infinity" || item.profitFactor === Infinity
    ? Infinity
    : Number(item.profitFactor || 0);
  const pfRequired = Number(item.promoteProfitFactorRequired || 1.15);
  const net = Number(item.net || 0);
  const blockers = [];
  if (quality < qualityRequired) blockers.push(`качество ${quality.toFixed(1)}/${qualityRequired}`);
  if (wilson < promoteWilson) blockers.push(`Wilson ${Math.round(wilson * 100)}%/${Math.round(promoteWilson * 100)}%`);
  if (!(pf >= pfRequired)) blockers.push(`PF ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}/${pfRequired}`);
  if (!(net > 0)) blockers.push(`net ${money(net)}`);
  const sample = `выборка ${n}/${targetN}${needed ? `, ещё ${needed}` : ""}`;
  const gate = blockers.length
    ? `real-ready недостижим по текущим метрикам: ${blockers.join(", ")}`
    : `метрики похожи на проходные; после оценки нужен earn-Wilson ${Math.round(earnWilson * 100)}%`;
  return `${sample}; ${gate}`;
}

function edgeProgressLabel(score, promotions = []) {
  if (promotions.length > 0) return "есть кандидат на real";
  if (score >= 0.55) return "перспективно, но ещё не доказано";
  if (score >= 0.25) return "слабый след, нужен добор качества";
  return "нет доказанного преимущества";
}

function cohortEtaText(target, ratePerHour) {
  if (!target) return "";
  const needed = Math.max(0, Number(target.sampleGap ?? target.needed ?? 0));
  if (needed <= 0) return "закрытия уже добраны";
  const eta = buildEtaTarget(needed, ratePerHour, Date.now());
  if (eta.ready) return "закрытия уже добраны";
  if (eta.stalled) return `нужно ещё ${needed} независимых закрытий, но текущий темп слишком низкий и ETA пока плавающий`;
  return `нужно ещё ${needed} независимых закрытий, это примерно ${shortDuration(eta.hours * 3600000)} при текущем темпе (ориентир ${fmtEtaMoment(eta.etaAt)})`;
}

function nextTargetEta(state = currentState, target = nextRealMaturityTarget(state)) {
  if (!target) return null;
  const health = buildHypothesisHealth(state);
  const needed = Math.max(0, Number(target.sampleGap ?? target.needed ?? 0));
  const rate = Number(target.ratePerHour || target.pace || health.sustainableRate || 0);
  return {
    needed,
    ratePerHour: rate,
    target: buildEtaTarget(needed, rate, Date.now()),
  };
}

function realLaneWhyNow(state = currentState) {
  const explicit = String(state?.risk?.realLane?.nextStep || "").trim();
  if (explicit) return explicit;
  const summary = realLaneSummary(state);
  const improvement = state?.learning?.improvement || {};
  const totals = improvement.totals || {};
  const promote = Number(totals.promote || 0);
  const mature = Number(totals.mature || 0);
  const promotion = strongestRealPromotion(state);
  const matureBlocker = weakestMatureRealBlocker(state);
  const nextTarget = nextRealMaturityTarget(state);
  const nextEta = nextTargetEta(state, nextTarget);
  const calibrationDone = Math.max(
    Number(state?.risk?.realLane?.completedProbeCount || 0),
    Number(state?.risk?.realLane?.calibrationOpenedCount || 0),
  );
  const calibrationTarget = Math.max(1, Number(state?.risk?.realLane?.targetProbeCount || 0) || 1);

  if (summary.openTrades > 0) {
    return `real уже в рынке: открыто ${summary.openTrades}, новых входов не даю, пока не освободится слот.`;
  }
  if (promote > 0) {
    const promotionText = promotion ? ` Лучшая готовая когорта: ${cohortShortText(promotion)}.` : "";
    return `калибровка ${calibrationDone}/${calibrationTarget} завершена, и уже есть ${promote} когорты для normal earn.${promotionText}`;
  }
  if (mature > 0) {
    const blockerText = matureBlocker
      ? `зрелая когорта уже есть, но она плохая по качеству: ${cohortShortText(matureBlocker)}`
      : `зрелые когорты уже есть (${mature}), но ни одна не прошла real-promote gate`;
    if (!nextTarget) {
      return `калибровка ${calibrationDone}/${calibrationTarget} завершена, но новых real-входов нет: ${blockerText}.`;
    }
    if (nextEta?.target?.stalled) {
      return `калибровка ${calibrationDone}/${calibrationTarget} завершена, но новых real-входов нет: ${blockerText}. Следующая живая когорта ${nextTarget.instrument} ${nextTarget.side} ${setupLabel(nextTarget.bracketProfile)} пока без внятного ETA: ей нужно ещё ${nextEta.needed} независимых закрытий.`.trim();
    }
    if (nextEta?.target?.ready) {
      return `калибровка ${calibrationDone}/${calibrationTarget} завершена, но новых real-входов нет: ${blockerText}. Следующая когорта ${nextTarget.instrument} ${nextTarget.side} ${setupLabel(nextTarget.bracketProfile)} уже добрала выборку, но real стартует только если она ещё и пройдёт прибыль/Wilson gate.`.trim();
    }
    return `калибровка ${calibrationDone}/${calibrationTarget} завершена, но новых real-входов нет: ${blockerText}. Следующая живая когорта ${nextTarget.instrument} ${nextTarget.side} ${setupLabel(nextTarget.bracketProfile)} доберёт выборку примерно через ${shortDuration(nextEta.target.hours * 3600000)} (${fmtEtaMoment(nextEta.target.etaAt)}), но это только ETA до оценки, не до real-сделки: ${cohortGateUiText(nextTarget)}.`.trim();
  }
  if (!nextTarget) {
    return `калибровка ${calibrationDone}/${calibrationTarget} завершена, но real ещё не торгует: ни одна когорта ещё не набрала достаточную выборку.`;
  }
  if (nextEta?.target?.stalled) {
    return `калибровка ${calibrationDone}/${calibrationTarget} завершена, но real ещё не торгует: пока нет ни одной когорты с достаточной выборкой. Ближайшая ${nextTarget.instrument} ${nextTarget.side} ${setupLabel(nextTarget.bracketProfile)} требует ещё ${nextEta.needed} независимых закрытий, а текущий темп слишком рваный, чтобы честно назвать ETA.`.trim();
  }
  return `калибровка ${calibrationDone}/${calibrationTarget} завершена, но real ещё не торгует: пока нет ни одной когорты с достаточной выборкой, которая могла бы пройти в earn. Ближайшая ${nextTarget.instrument} ${nextTarget.side} ${setupLabel(nextTarget.bracketProfile)} требует ещё ${nextEta?.needed ?? "?"} независимых закрытий; ориентир по выборке сейчас ${nextEta?.target?.ready ? "уже добран" : `${shortDuration((nextEta?.target?.hours || 0) * 3600000)} (${fmtEtaMoment(nextEta?.target?.etaAt)})`}. Это ETA до оценки; ${cohortGateUiText(nextTarget)}.`.trim();
}

function realLaneHumanReason(state = currentState) {
  return `Почему новых real-сделок нет: ${realLaneWhyNow(state)}`;
}

const REAL_PROBE_RISK_CHECK_MS = 180 * 60 * 1000;
const REAL_PROBE_MAX_HOLD_MS = 12 * 60 * 60 * 1000;

function fmtRealEtaMoment(value) {
  const time = Number(value);
  if (!Number.isFinite(time)) return "-";
  const date = new Date(time);
  const clock = new Intl.DateTimeFormat("ru-RU", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return `${clock} сегодня`;
  if (sameDay(date, tomorrow)) return `${clock} завтра`;
  return `${clock} ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" }).format(date)}`;
}

function realActiveTrade(state = currentState) {
  const trades = Array.isArray(state?.realTerminal?.activeTrades) ? state.realTerminal.activeTrades : [];
  if (trades.length) return trades[0];
  const terminal = realTerminalSnapshot(state);
  if (terminal.activeTradesCount <= 0 && terminal.usedValue <= 0.01 && Math.abs(terminal.profitValue) <= 0.01) return null;
  return {
    instrument: state?.realTerminal?.selectedInstrument || "Real",
    amount: terminal.usedValue,
    profitText: terminal.profitText || money(terminal.profitValue),
    profitValue: terminal.profitValue,
  };
}

function realTradeOpenAt(state = currentState, trade = realActiveTrade(state)) {
  const realLane = state?.risk?.realLane || {};
  const candidates = [
    trade?.stats?.firstSeenAt,
    parseOpenTradeDateForUi(trade?.openingDate),
    trade?.openedAt,
    trade?.time,
    realLane.currentLongProbeOpenAt,
    realLane.lastLongProbeOpenAt,
    realLane.lastTransitionAt,
  ];
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate || 0);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return NaN;
}

function compactBlockerText(state = currentState) {
  const realLane = state?.risk?.realLane || {};
  const nextStep = String(realLane.nextStep || "").trim();
  const reviewScan = state?.learning?.lastClosedReviewScan || {};
  if (reviewScan.error) return `review pipeline: ${reviewScan.error}`;
  if (/critical_jit_no_profit/i.test(nextStep)) return "critical JIT: нет профита после costs";
  if (/real_long_probe_recent_net_stop/i.test(nextStep)) return "cooldown после убыточной real-пробы";
  if (/real_long_probe_loss_streak_stop/i.test(nextStep)) return "стоп серии real-probe losses";
  if (/closed review|разбор/i.test(nextStep)) return "нужен закрытый разбор";
  if (/promote|когорт/i.test(nextStep)) return "нет promoted-когорты";
  if (/session|browser|CDP|endpoint/i.test(nextStep)) return "real execution-сессия";
  return compactText(nextStep || realLaneHumanReason(state), 90);
}

function moneyLike(value) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return money(numeric);
  return String(value);
}

function renderRealEtaPanel(state = currentState) {
  const card = $("realEtaCard");
  if (!card) return;
  card.classList.remove("danger");
  const realSummary = realLaneSummary(state);
  const terminal = realTerminalSnapshot(state);
  const trade = realActiveTrade(state);
  const openAt = realTradeOpenAt(state, trade);
  const now = Date.now();
  const hasOpen = Boolean(trade) || realSummary.openTrades > 0;
  const instrument = trade?.instrument || state?.realTerminal?.selectedInstrument || "инструмент не выбран";
  const side = trade?.side ? ` ${trade.side}` : "";
  const amount = firstDefined(trade?.amount, trade?.resultValue, terminal.usedValue);
  const multiplierValue = Number(trade?.multiplier);
  const multiplier = Number.isFinite(multiplierValue) && multiplierValue > 0 ? ` x${multiplierValue}` : "";
  const riskLadder = Number.isFinite(multiplierValue) && multiplierValue >= 10 ? " · риск-лестница x10" : "";
  const profit = trade?.profitText || terminal.profitText || money(realSummary.openProfitUsd || 0);
  const reviewed = Number((state?.learning?.realClosedTradeReviews || []).length || 0);
  const closed = Number(realSummary.closedTradesAll || 0);
  const reviewGap = Math.max(0, closed - reviewed);
  const reviewText = reviewGap > 0
    ? `${reviewed}/${closed}; добрать ${reviewGap} сейчас, цель +10 за 24ч`
    : `${reviewed}/${closed}; цель +10 качественных за 24ч`;

  let pill = "план";
  let title = "Следующая real-сделка";
  let current = hasOpen
    ? `${instrument}${side} · ${moneyLike(amount) || "размер ?"}${multiplier}${riskLadder} · ${profit}`
    : `нет открытых · closed net ${money(realSummary.netProfitUsd || 0)}`;
  let risk = "после нового входа";
  let hard = "12ч после входа";
  let next = "после кандидата + review";

  if (hasOpen && Number.isFinite(openAt)) {
    const riskAt = openAt + REAL_PROBE_RISK_CHECK_MS;
    const hardAt = openAt + REAL_PROBE_MAX_HOLD_MS;
    const age = shortDuration(now - openAt);
    title = `${instrument}${side || ""}: active real`;
    current = `${current} · возраст ${age}`;
    if (now < riskAt) {
      risk = `${fmtRealEtaMoment(riskAt)}; закрывать только если риск плохой`;
      next = `не раньше ${fmtRealEtaMoment(riskAt)}, если close+review освободят слот`;
      pill = "ждём risk-check";
    } else if (now < hardAt) {
      risk = `пройден; держим ради движения, если риск ок`;
      next = `после close+review; максимум до ${fmtRealEtaMoment(hardAt)}`;
      pill = "держим до сигнала";
    } else {
      risk = "TTL прошёл: close/review сейчас";
      next = "после аварийного close+review";
      pill = "нужен close";
      card.classList.add("danger");
    }
    hard = fmtRealEtaMoment(hardAt);
  } else {
    const blocker = compactBlockerText(state);
    hard = "Лестница: L0 $20 x5; L1 $20 x10; L2 $30 x10 после review>=0";
    if (reviewGap > 0) {
      next = `после разбора ${reviewGap} закрытий`;
      pill = "нужны разборы";
    } else if (terminal.accountType !== "real") {
      next = "после восстановления real-сессии";
      pill = "execution";
    } else {
      next = blocker ? `после снятия: ${compactText(blocker, 42)}` : "при первом validated candidate";
      pill = "ищем кандидат";
    }
  }

  setText("realEtaTitle", title);
  setText("realEtaPill", pill);
  setText("realEtaCurrent", current);
  setText("realEtaRisk", risk);
  setText("realEtaHard", hard);
  setText("realEtaNext", next);
  setText("realEtaBlocker", `Блокер: ${compactBlockerText(state)}`);
  setText("realEtaReview", `Разборы: ${reviewText}`);
  card.classList.toggle("active", hasOpen);
  card.classList.toggle("blocked", !hasOpen && (reviewGap > 0 || terminal.accountType !== "real"));
}

function earnBlockerText(state = currentState) {
  const realLane = state?.risk?.realLane || {};
  const realTerminal = realTerminalSnapshot(state);
  const realCdp = state?.cdp?.real || {};
  const status = String(realLane.status || "DISABLED").toLowerCase();
  if (!realCdp.configured) {
    return "Earn пуст не из-за рынка: для real ещё не поднят отдельный browser endpoint. Нужен второй Chrome-профиль Libertex под real, чтобы робот не путал счета.";
  }
  if (!realCdp.connected) {
    return "Earn пуст не из-за рынка: отдельный real-browser endpoint настроен, но сейчас недоступен. Поднимем вторую Chrome-сессию и сразу пустим real через неё.";
  }
  if (realTerminal.accountType === "demo") {
    return "Earn пуст не из-за рынка: вторая сессия уже подключена, но в ней всё ещё открыт demo-счёт. Нужно переключить именно эту отдельную сессию на real.";
  }
  if (!realTerminal.accountType) {
    return "Earn пуст не из-за рынка: вторая real-сессия уже поднята, но Libertex Real в ней ещё не подтверждён. Обычно это значит, что во втором окне нужно войти или дойти до страницы real-счёта.";
  }
  if (realLane.separateBrowserProfilesRequired) {
    return `Earn пуст не из-за рынка. Деньги на real уже есть, но робот ещё не видит отдельную real-сессию Libertex. Пока demo и real могут делить одно и то же состояние браузера, робот не открывает real-сделку, чтобы не нажать не в тот счёт. Как только подключим отдельную real-сессию, он начнёт с маленькой калибровочной сделки и измерит исполнение, проскальзывание и закрытие.`;
  }
  return `Earn пока пуст: ${realLaneHumanReason(state)}`;
}

function realLaneCanArm(state = currentState) {
  const status = realLaneStatus(state);
  return !["ARMED", "LIVE", "DRAINING"].includes(status);
}

function configuredRealBalanceUsd(state = currentState) {
  return Number(
    state?.risk?.realLane?.firstDepositUsd ??
    state?.risk?.realTransition?.firstRealDepositEur ??
    0
  ) || 0;
}

function configuredRealBalanceText(state = currentState) {
  const snapshot = realTerminalSnapshot(state);
  if (snapshot.balanceValue > 0 && snapshot.accountType === "real") {
    return snapshot.balanceText || `$${snapshot.balanceValue.toFixed(2)}`;
  }
  const value = configuredRealBalanceUsd(state);
  return value > 0 ? `$${value.toFixed(2)}` : "$0.00";
}

function fallbackDemoBalanceText(state = currentState) {
  return state?.terminal?.balance ||
    (state?.performance?.currentBalance !== null && state?.performance?.currentBalance !== undefined
      ? `$${Number(state.performance.currentBalance).toFixed(2)}`
      : "-");
}

function dashboardMetricView(state = currentState) {
  const useReal = dashboardUsesRealMetrics(state);
  const dashboardLane = currentDashboardLane(state);
  const realSummary = realLaneSummary(state);
  const realTerminal = realTerminalSnapshot(state);
  const realStatus = realLaneStatus(state);
  const realFunded = realLaneHasFundedActivity(state);
  const configuredBalanceUsd = configuredRealBalanceUsd(state);
  const configuredBalanceText = configuredRealBalanceText(state);
  const fallbackBalance = fallbackDemoBalanceText(state);

  if (!useReal) {
    const rawHistory = state?.performance?.history || [];
    const laneHistory = dashboardLane === "demo_earn"
      ? filterDemoHistoryByLane(rawHistory, "earn")
      : filterDemoHistoryByLane(rawHistory, "explore");
    const laneNet = historyNetChange(laneHistory, Number(state?.terminal?.profitValue || 0) || 0);
    const laneOpenProfit = Number(laneNet.currentOpen ?? state?.terminal?.profitValue ?? 0) || 0;
    const activeLane = activeDemoDashboardLane(state);
    const laneIsLive = dashboardLane === activeLane;
    const laneLabel = dashboardLane === "demo_earn" ? "Demo Earn" : "Demo Investigate";
    return {
      usesReal: false,
      dashboardLane,
      funded: true,
      balanceText: fallbackBalance,
      laneNetText: money(laneNet.value),
      accountText: state?.terminal?.account ? `${state.terminal.account} ${state.terminal.accountType || ""}` : "-",
      openProfitValue: laneOpenProfit,
      openProfitText: money(laneOpenProfit).replace(/^\+/, ""),
      usedText: laneIsLive ? (state?.terminal?.used || "$0.00") : money(Number(laneHistory.at(-1)?.used || 0)).replace(/^\+/, ""),
      availableText: state?.terminal?.available || "-",
      history: laneHistory,
      statusPill: laneLabel,
      runtimeText: `${state?.performance?.runtimeMinutes ?? 0} min runtime`,
      chartEmptyText: `${laneLabel}: собираю историю`,
      chartEmptyMeta: dashboardLane === "demo_earn" ? "earn history" : "investigate history",
    };
  }

  if (!realFunded) {
    const statusPill = realStatus === "DRAINING"
      ? "Stopping"
      : realStatus === "ARMED"
        ? "Armed"
        : realStatus === "LIVE"
          ? "Real live"
          : "Not funded";
    const runtimeText = realStatus === "ARMED"
      ? "real armed · waiting for isolated real session"
      : realStatus === "DRAINING"
        ? "draining real lane"
        : "waiting for first real funding";
    return {
      usesReal: true,
      funded: false,
      balanceText: configuredBalanceText,
      accountText: configuredBalanceUsd > 0
        ? `real lane ${String(realStatus || "disabled").toLowerCase()} · funded, waiting for separate real session`
        : `real lane ${String(realStatus || "disabled").toLowerCase()} · waiting for separate real session`,
      openProfitValue: 0,
      openProfitText: "$0.00",
      usedText: "$0.00",
      availableText: configuredBalanceText,
      history: [],
      statusPill,
      runtimeText,
      chartEmptyText: configuredBalanceUsd > 0 ? "Waiting for first verified real trade" : "No funded real activity yet",
      chartEmptyMeta: configuredBalanceUsd > 0 ? "real lane armed, no verified history yet" : "waiting for first verified real snapshot",
    };
  }

  return {
    usesReal: true,
    funded: true,
    balanceText: realTerminal.balanceText || configuredBalanceText,
    accountText: realTerminal.account
      ? `${realTerminal.account} ${realTerminal.accountType || "real"}`
      : `real lane ${String(realStatus || "armed").toLowerCase()}`,
    openProfitValue: realTerminal.accountType === "real" ? realTerminal.profitValue : realSummary.openProfitUsd,
    openProfitText: realTerminal.accountType === "real"
      ? (realTerminal.profitText || money(realTerminal.profitValue).replace(/^\+/, ""))
      : money(realSummary.openProfitUsd).replace(/^\+/, ""),
    usedText: realTerminal.usedText || "$0.00",
    availableText: realTerminal.availableText || configuredBalanceText,
    history: buildRealMetricHistory(state),
    statusPill: state?.risk?.liveTradingEnabled ? "Real live" : "Real active",
    runtimeText: realTerminal.accountType === "real" ? "real session verified" : "real lane summary",
    chartEmptyText: realTerminal.activeTradesCount > 0 ? "Real-сделка открыта; история ещё набирается" : "Waiting for real-lane history",
    chartEmptyMeta: realTerminal.activeTradesCount > 0 ? "live real snapshot" : "real history is syncing",
  };
}

function parseLooseTradeTime(value) {
  if (!value) return NaN;
  const match = String(value).match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const months = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const [, day, monthName, hour, minute, second = "0"] = match;
    const month = months[monthName];
    if (month === undefined) return NaN;
    const year = new Date().getFullYear();
    return new Date(year, month, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  }
  const direct = Date.parse(value);
  return Number.isNaN(direct) ? NaN : direct;
}

function reviewTimestamp(item) {
  const directCandidates = [
    item?.closeTimestamp,
    item?.time,
    item?.createdAt,
    item?.latestAt,
  ];
  for (const value of directCandidates) {
    const parsed = Date.parse(value || 0);
    if (Number.isFinite(parsed)) return parsed;
  }
  const loose = parseLooseTradeTime(item?.closeTime || item?.openTime);
  return Number.isFinite(loose) ? loose : NaN;
}

function strategyRangeLabel() {
  if (!strategyRangeMs) return "все разобранные";
  if (strategyRangeMs === 10 * 60 * 1000) return "последние 10м";
  if (strategyRangeMs === 60 * 60 * 1000) return "последний час";
  if (strategyRangeMs === 4 * 60 * 60 * 1000) return "последние 4ч";
  if (strategyRangeMs === 24 * 60 * 60 * 1000) return "последний день";
  if (strategyRangeMs === 7 * 24 * 60 * 60 * 1000) return "последняя неделя";
  return `последние ${Math.round(strategyRangeMs / 60000)}м`;
}

function chartRangeLabel() {
  if (!chartRangeMs) return "вся история";
  return periodLabel(chartRangeMs);
}

function chartFilterLabel(value = chartFilter) {
  return {
    all: "всё",
    invested: "занято",
    profit: "прибыль",
  }[value] || "фильтр";
}

function chartLaneFilterLabel(value = chartLaneFilter) {
  return {
    all: "все demo",
    explore: "explore",
    earn: "earn",
  }[value] || "demo";
}

function historyCoverage(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return {
      points: Array.isArray(points) ? points.length : 0,
      coverageMs: 0,
      startedAt: points?.[0]?.time || null,
    };
  }
  const startedAt = points[0]?.time || null;
  const endedAt = points.at(-1)?.time || null;
  return {
    points: points.length,
    coverageMs: Math.max(0, Date.parse(endedAt || 0) - Date.parse(startedAt || 0)),
    startedAt,
  };
}

function updateChartRangeButtons(allPoints, options = {}) {
  const totalCoverage = historyCoverage(allPoints);
  document.querySelectorAll("[data-chart-range]").forEach((button) => {
    if (button.dataset.chartRange === "all") {
      button.classList.remove("insufficient");
      button.title = totalCoverage.coverageMs > 0
        ? `Вся записанная история: ${shortDuration(totalCoverage.coverageMs)} с ${fmtTime(totalCoverage.startedAt)}`
        : "Вся записанная история";
      return;
    }
    const requestedMs = Number(button.dataset.chartRange);
    const windowPointCount = (allPoints || []).filter((point) => Date.parse(point.time) >= Date.now() - requestedMs).length;
    const insufficient = options.strictRange
      ? windowPointCount < 2
      : totalCoverage.coverageMs > 0 && totalCoverage.coverageMs + 60 * 1000 < requestedMs;
    button.classList.toggle("insufficient", insufficient);
    button.title = insufficient
      ? (options.strictRange
        ? `В этом окне пока ${windowPointCount} real-точек; нужна минимум 2, чтобы линия отличалась.`
        : `Пока записано только ${shortDuration(totalCoverage.coverageMs)}, поэтому этот период сейчас почти не отличается.`)
      : `Показать ${periodLabel(requestedMs)}`;
  });
  syncChartControls();
}

function updatePeriodRangeButtons(history, strictWindow) {
  document.querySelectorAll("[data-period-range]").forEach((button) => {
    const requestedMs = Number(button.dataset.periodRange);
    const windowPointCount = (history || []).filter((point) => (
      Number.isFinite(Number(point.openProfit)) &&
      Date.parse(point.time) >= Date.now() - requestedMs
    )).length;
    const insufficient = Boolean(strictWindow && windowPointCount < 2);
    button.classList.toggle("insufficient", insufficient);
    button.title = insufficient
      ? `В этом real-окне пока ${windowPointCount} точек; дельта будет 0, пока не появится ещё одна.`
      : `Показать изменение за ${periodLabel(requestedMs)}`;
  });
}

function syncChartControls() {
  document.querySelectorAll("[data-chart-filter]").forEach((button) => {
    const isActive = (button.dataset.chartFilter || "all") === chartFilter;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  document.querySelectorAll("[data-chart-lane]").forEach((button) => {
    const isActive = (button.dataset.chartLane || "all") === chartLaneFilter;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  document.querySelectorAll("[data-chart-range]").forEach((button) => {
    const isActive = button.dataset.chartRange === "all"
      ? chartRangeMs === null
      : Number(button.dataset.chartRange) === Number(chartRangeMs);
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function setMoney(id, value) {
  const el = $(id);
  el.textContent = money(value);
  el.classList.toggle("positive", Number(value) > 0);
  el.classList.toggle("negative", Number(value) < 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function postJson(url, body = {}) {
  const response = await portalFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    if (IS_GITHUB_PORTAL) sessionStorage.removeItem(PORTAL_ACCESS_TOKEN_KEY);
    showPortalLogin("Session expired. Enter the dashboard code again.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function renderInstruments(items) {
  const rows = $("instrumentRows");
  rows.innerHTML = "";

  if (!items.length) {
    rows.innerHTML = `<tr><td colspan="3">No instruments captured yet</td></tr>`;
    return;
  }

  for (const item of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.score}</td>
      <td>${item.status}</td>
    `;
    rows.appendChild(tr);
  }
}

function isTradeFeedItem(item) {
  if (TRADE_FEED_TYPES.has(item.type)) return true;
  if (item.type !== "decision") return false;
  const action = item.payload?.action;
  const reason = item.payload?.reason || item.payload?.hypothesis || "";
  if (passiveFeedAction(action, reason)) return false;
  return ["CANDIDATE", "BLOCKED", "READY_TO_TEST"].includes(action);
}

function isOpenFeedItem(item) {
  return item?.type === "demo_open_trade_snapshot" || item?.type === "real_open_trade_snapshot";
}

function isEarnFeedItem(item) {
  const payload = item?.payload || {};
  const type = String(item?.type || "");
  const lane = String(payload.lane || payload.accountLane || payload.tradePolicy?.lane || "").toLowerCase();
  const accountType = String(payload.accountType || "").toLowerCase();
  return item?.type === "real_lane_changed" ||
    type.startsWith("real_") ||
    lane === "real" ||
    accountType === "real";
}

function isSystemLogItem(item) {
  return !isTradeFeedItem(item);
}

const ACTION_LABELS = {
  BUY: { label: "Покупка", tone: "buy", title: "Покупка" },
  SELL: { label: "Продажа", tone: "sell", title: "Продажа" },
  HOLD: { label: "Ждать", tone: "hold", title: "Наблюдение" },
  WATCH: { label: "Наблюдать", tone: "hold", title: "Наблюдение" },
  CANDIDATE: { label: "Кандидат", tone: "info", title: "Кандидат" },
  READY_TO_TEST: { label: "Готово к тесту", tone: "info", title: "Готово к тесту" },
  NO_ENTRY: { label: "Без входа", tone: "hold", title: "Вход не нужен" },
  SKIP: { label: "Пропуск", tone: "hold", title: "Пропуск" },
  BLOCKED: { label: "Заблокировано", tone: "danger", title: "Вход заблокирован" },
  TAKE_PROFIT_WATCH: { label: "Следит за прибылью", tone: "profit", title: "Робот ждёт, можно ли забрать прибыль без слишком раннего выхода." },
  TAKE_PROFIT_READY: { label: "Забрать прибыль", tone: "profit", title: "Робот готовит фиксацию прибыли." },
  CLOSE_STALE_READY: { label: "Импульс не пошёл", tone: "danger", title: "Сделка долго не дала импульса; робот готовит закрытие." },
  CLOSE_RISK_READY: { label: "Риск закрытия", tone: "danger", title: "Сделку пора закрывать по риску." },
  CLOSE_JAM: { label: "Закрытие застряло", tone: "danger", title: "Есть сделки, которые пора закрывать, но терминал пока не подтвердил закрытие." },
  CLOSE_WATCH: { label: "Следить", tone: "hold", title: "Следить за закрытием" },
  CLOSE_PROFIT_READY: { label: "Зафиксировать", tone: "profit", title: "Проверить фиксацию" },
  INSTANT_DUMP: { label: "Срочно закрыть", tone: "danger", title: "Срочное закрытие" },
};

const LANE_LABELS = {
  real: { label: "Реал", tone: "real" },
  demo: { label: "Демо", tone: "demo" },
  demo_earn: { label: "Demo Earn", tone: "demo" },
  earn: { label: "Earn", tone: "real" },
};

const SETUP_LABELS = {
  real_calibration_probe: {
    label: "Проверка real-канала",
    tone: "real",
    title: "Калибровочная real-сделка: проверяем, что открытие, закрытие, спред и проскальзывание измеряются корректно.",
  },
  REAL_A_ATR_CALIBRATION: {
    label: "Калибровка волатильности",
    tone: "real",
    title: "Пробная real-сделка для измерения исполнения относительно текущей волатильности.",
  },
  PENDING_BREAKOUT: {
    label: "Пробой по заявке",
    tone: "demo",
    title: "Робот ставит отложенную заявку и ждёт, подтвердит ли рынок пробой.",
  },
  PENDING_COVERAGE_BRACKET_PROBE: {
    label: "Пробой по заявке",
    tone: "demo",
    title: "Отложенная заявка для сбора статистики по пробоям.",
  },
  pending_coverage_bracket_probe: {
    label: "Пробой по заявке",
    tone: "demo",
    title: "Отложенная заявка для сбора статистики по пробоям.",
  },
  pending_bracket: {
    label: "Пробой по заявке",
    tone: "demo",
    title: "Отложенная заявка с заранее заданными TP/SL.",
  },
  A31: {
    label: "TP больше SL",
    tone: "demo",
    title: "Цель по прибыли дальше стопа. Сделка должна дать хороший импульс, иначе идея слабая.",
  },
  A31_LONG: {
    label: "Длиннее движение",
    tone: "demo",
    title: "Робот даёт FX-сделке больше пространства и проверяет, не съедал ли короткий профиль весь шанс спредом и шумом.",
  },
  S22: {
    label: "TP и SL близкие",
    tone: "demo",
    title: "Цель и стоп близко. Такой профиль проверяет короткое движение.",
  },
};

const HEALTH_LABELS = {
  HEALTHY: { label: "Работает", title: "Сканер и цикл сделок живые." },
  PAUSED: { label: "Пауза", title: "Новые действия остановлены." },
  LOGIN_REQUIRED: { label: "Нужен логин", title: "Libertex-сессия разлогинена. Перед ручным входом сканер надо поставить на паузу, чтобы капча не сбрасывалась." },
  STALLED: { label: "Застрял", title: "Сканер жив, но давно не было подтверждённых открытий или закрытий." },
  CLOSE_JAM: { label: "Закрытия застряли", title: "Очередь закрытия или сверки сделок не разгружается достаточно быстро." },
  DEGRADED_DATA: { label: "Данные неполные", title: "Терминал или источник данных сейчас дают неполную картину." },
  THROTTLED: { label: "Темп снижен", title: "Робот работает осторожнее из-за нагрузки или риска." },
};

const MODE_LABELS = {
  "demo-armed": { label: "Демо: тестирует", title: "Робот может открывать demo-сделки для проверки гипотез." },
  "demo-confirmed": { label: "Демо подтверждён", title: "Терминал точно находится на demo-счёте." },
  "demo-login-required": { label: "Демо: нужен логин", title: "Demo Chrome открыт, но Libertex просит войти заново." },
  "earn-view": { label: "Реал: просмотр", title: "Показывается только real-дорожка." },
  "real-confirmed": { label: "Реал подтверждён", title: "Терминал точно находится на real-счёте." },
  "real-login-required": { label: "Реал: нужен логин", title: "Real Chrome открыт, но Libertex просит войти заново." },
  "real-live": { label: "Реал: активен", title: "Real-сессия подтверждена и Earn-дорожка активна." },
  "real-armed": { label: "Реал: готов", title: "Real-дорожка готова, но входы зависят от фильтров качества." },
  fail_closed: { label: "защита", title: "Новые действия закрыты защитой." },
  running: { label: "работает", title: "Процесс активен." },
  paused: { label: "пауза", title: "Процесс остановлен." },
  live: { label: "живая", title: "Сессия подключена и подтверждена." },
  armed: { label: "готова", title: "Дорожка включена и ждёт разрешённый вход." },
};

function normalizeCode(value) {
  return String(value || "").trim();
}

function humanizeRawCode(value) {
  const key = normalizeCode(value);
  if (!key) return "";
  return key
    .replace(/^real:/i, "real ")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function withDebugTitle(info, rawCode) {
  if (!info) return info;
  return info;
}

function actionInfo(code) {
  const key = normalizeCode(code);
  if (!key) return null;
  return withDebugTitle(ACTION_LABELS[key], key) || { label: "Внутренний статус", tone: "raw", title: "Технический статус робота. Подробности доступны по клику." };
}

function laneInfo(value) {
  const key = normalizeCode(value);
  if (!key) return null;
  return withDebugTitle(LANE_LABELS[key] || LANE_LABELS[key.toLowerCase()] || modeInfo(key), key) || { label: "Внутренний режим", tone: "raw", title: "Технический режим робота. Подробности доступны по клику." };
}

function setupInfo(value) {
  const key = normalizeCode(value);
  if (!key) return null;
  return withDebugTitle(SETUP_LABELS[key] || SETUP_LABELS[key.toUpperCase()], key) || { label: "Профиль проверки", tone: "demo", title: "Технический профиль проверки. Подробности доступны по клику." };
}

function setupLabel(value) {
  return setupInfo(value)?.label || "";
}

function healthInfo(value) {
  const key = normalizeCode(value);
  if (!key) return null;
  return withDebugTitle(HEALTH_LABELS[key], key) || { label: "Состояние робота", title: "Техническое состояние робота. Подробности доступны по клику." };
}

function modeInfo(value) {
  const key = normalizeCode(value);
  if (!key) return null;
  return withDebugTitle(MODE_LABELS[key] || MODE_LABELS[key.toLowerCase()], key) || null;
}

function modeLabel(value) {
  return modeInfo(value)?.label || humanizeRawCode(value);
}

function scannerLabel(state, earnView) {
  if (earnView) return modeLabel(String(realLaneStatus(state)).toLowerCase());
  const base = state.scannerRunning ? "работает" : "пауза";
  const health = healthInfo(state.health?.state);
  if (health && !["HEALTHY", "PAUSED"].includes(state.health?.state)) {
    return `${base} · ${health.label.toLowerCase()}`;
  }
  return base;
}

function eventBadges(item) {
  const payload = item.payload || {};
  const status = eventStatusBadge(item);
  const badges = status ? [status] : [];
  const rawMode = payload.tradePolicy?.mode || payload.mode || payload.strategyMode;
  const lane = payload.lane || (String(item?.type || "").startsWith("real_")
    ? rawMode
    : rawMode === "earn"
      ? "demo_earn"
      : rawMode);
  const laneCode = normalizeCode(lane);
  if (laneCode === "INSTANT_DUMP") {
    badges.push(actionInfo(laneCode));
  } else {
    const laneBadge = laneInfo(lane);
    const skipLaneBadge = item.type === "real_earn_skipped" || item.type === "real_micro_validation_skipped";
    if (!skipLaneBadge && laneBadge && !["HOLD"].includes(laneCode)) badges.push(laneBadge);
  }
  if (item.type === "real_calibration_trade_opened" || item.type === "real_calibration_auto_close") {
    badges.push({ label: "Калибровка", tone: "real" });
  }
  if (
    item.type === "real_open_trade_snapshot" ||
    item.type === "real_micro_validation_trade_opened" ||
    item.type === "real_micro_validation_auto_close" ||
    item.type === "real_long_horizon_probe_opened" ||
    item.type === "real_long_probe_auto_close" ||
    item.type === "real_earn_trade_opened" ||
    item.type === "real_earn_auto_close"
  ) {
    badges.push({ label: "Реальная сделка", tone: "real" });
  }
  const action = actionInfo(payload.action || payload.side);
  if (action) badges.push(action);
  const setup = payload.bracketProfile || payload.tradePolicy?.bracketProfile;
  const setupBadge = setupInfo(setup);
  if (setupBadge) badges.push(setupBadge);
  const seen = new Set();
  return badges.filter((badge) => {
    const key = `${badge.tone}:${badge.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function eventStatusBadge(item) {
  const payload = item.payload || {};
  if (item.type === "demo_open_trade_snapshot" || item.type === "real_open_trade_snapshot") return { label: "Открыта сейчас", tone: "open" };
  if (item.type === "demo_trade_opened" || item.type === "demo_pending_order_opened" || item.type?.endsWith("_trade_opened") || item.type === "real_long_horizon_probe_opened") return { label: "Сделка открыта", tone: "success" };
  if (item.type?.includes("auto_close") || item.type === "closed_trade_review") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    const value = Number(firstDefined(trade?.profitValue, payload.profitValue, 0));
    return { label: value >= 0 ? "Закрыта в плюс" : "Закрыта в минус", tone: value >= 0 ? "success" : "danger" };
  }
  if (item.type?.includes("failed") || item.type?.includes("rejected")) return { label: "Не открыта", tone: "danger" };
  if (item.type?.includes("skipped")) return { label: "Пропуск", tone: "hold" };
  if (item.type?.includes("planned") || payload.action === "READY_TO_TEST") return { label: "Готово к тесту", tone: "info" };
  if (payload.action === "CANDIDATE") return { label: "Кандидат", tone: "info" };
  if (item.type === "open_trade_review") return { label: "Открытая: разбор", tone: "open" };
  return null;
}

function eventTitle(item) {
  const payload = item.payload || {};
  const instrument = eventInstrumentLabel(payload);
  const side = payload.side || payload.plan?.side || payload.longProbe?.item?.side || payload.longProbe?.scoring?.side || "";
  const action = actionInfo(payload.action || side);
  if (item.type === "decision" && Number(payload.aggregateCount || 0) > 1) {
    const label = payload.action === "CANDIDATE"
      ? "наблюдение кандидата"
      : payload.action === "READY_TO_TEST"
        ? "слежу за сетапом"
        : action?.title || "наблюдение";
    return `${instrument} · ${label}`;
  }
  if (item.type === "closed_trade_review") return `${instrument} · Разбор закрытия`;
  if (item.type === "open_trade_review") return `${instrument} · ${action?.title || "Разбор открытой сделки"}`;
  if (item.type === "demo_experiment_planned") return `${instrument} · План теста`;
  if (item.type === "demo_experiment_failed") return `${instrument} · Тест не прошёл`;
  if (item.type === "demo_experiment_skipped") return `${instrument} · Тест пропущен`;
  if (item.type === "demo_open_trade_snapshot") return `${instrument} · Открыта сейчас`;
  if (item.type === "demo_trade_opened") return `${instrument} · Сделка открыта`;
  if (item.type === "demo_pending_order_opened") return `${instrument} · Отложенная заявка открыта`;
  if (item.type === "real_calibration_trade_opened") return `${instrument} · Real-калибровка`;
  if (item.type === "real_calibration_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return `${trade?.instrument || payload.instrument || "Real"} · Калибровка закрыта`;
  }
  if (item.type === "real_calibration_trade_failed") return `${instrument} · Real-калибровка не открыта`;
  if (item.type === "real_open_trade_snapshot") return `${instrument} · Открыта сейчас`;
  if (item.type === "real_micro_validation_planned") return `${instrument} · Micro-real запланирован`;
  if (item.type === "real_micro_validation_skipped") return `${instrument}${side ? ` ${side}` : ""} · Micro-real не разрешён`;
  if (item.type === "real_micro_validation_trade_opened") return `${instrument} · Micro-real открыт`;
  if (item.type === "real_micro_validation_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return `${trade?.instrument || payload.instrument || "Real"} · Micro-real закрыт`;
  }
  if (item.type === "real_micro_validation_trade_failed" || item.type === "real_micro_validation_failed") return `${instrument} · Micro-real не открыт`;
  if (item.type === "real_long_probe_planned") return `${instrument} · A31_LONG запланирован`;
  if (item.type === "real_long_horizon_probe_opened") return `${instrument} · A31_LONG real-проба`;
  if (item.type === "real_long_probe_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return `${trade?.instrument || payload.instrument || "Real"} · A31_LONG закрыт`;
  }
  if (item.type === "real_long_probe_failed" || item.type === "real_long_probe_auto_close_failed") return `${instrument} · A31_LONG не прошёл`;
  if (item.type === "real_earn_planned") return `${instrument} · Real-вход запланирован`;
  if (item.type === "real_earn_skipped") return `${instrument}${side ? ` ${side}` : ""} · Вход заблокирован`;
  if (item.type === "real_earn_trade_opened") return `${instrument} · Real-сделка открыта`;
  if (item.type === "real_earn_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return `${trade?.instrument || payload.instrument || "Real"} · Real-сделка закрыта`;
  }
  if (item.type === "real_earn_trade_failed") return `${instrument} · Real-сделка не открыта`;
  if (item.type?.includes("failed")) return `${instrument} · Исполнение не прошло`;
  return `${instrument} · ${action?.title || "Обновление"}`;
}

function eventInstrument(payload = {}) {
  return payload.instrument ||
    payload.plan?.instrument ||
    payload.longProbe?.instrument ||
    payload.longProbe?.item?.instrument ||
    payload.longProbe?.scoring?.instrument ||
    payload.candidate?.instrument ||
    payload.candidate?.item?.instrument ||
    payload.costGate?.instrument ||
    "Событие";
}

function instrumentTickerLabel(name) {
  const text = String(name || "").trim();
  if (!text) return "";
  const map = [
    [/^Bitcoin$/i, "BTC/USD"],
    [/^Ethereum$/i, "ETH/USD"],
    [/^Binance Coin$/i, "BNB/USD"],
    [/^Chainlink$/i, "LINK/USD"],
    [/^Cardano$/i, "ADA/USD"],
    [/^Polkadot$/i, "DOT/USD"],
    [/^Ripple$/i, "XRP/USD"],
    [/^Litecoin$/i, "LTC/USD"],
    [/^Dogecoin$/i, "DOGE/USD"],
    [/^Solana$/i, "SOL/USD"],
    [/^Polygon$/i, "MATIC/USD"],
    [/^Gold$/i, "XAU/USD"],
    [/^Silver$/i, "XAG/USD"],
  ];
  const ticker = map.find(([pattern]) => pattern.test(text))?.[1];
  if (ticker && !text.includes(ticker)) return `${text} (${ticker})`;
  return text;
}

function eventInstrumentLabel(payload = {}) {
  return instrumentTickerLabel(eventInstrument(payload));
}

function eventDetail(item) {
  const payload = item.payload || {};
  const base = payload.summary || payload.rationale || payload.reason || payload.message || payload.score || "";
  if (item.type === "demo_open_trade_snapshot" || item.type === "real_open_trade_snapshot") {
    return [
      `Открытая позиция сейчас видна в терминале: ${payload.side || "сторона уточняется"} ${payload.instrument || "instrument"}`,
      payload.profitText || money(payload.profitValue || 0),
      payload.amount ? `занято ${money(payload.amount)}` : "",
      payload.multiplier ? `x${payload.multiplier}` : "",
      "это live-снимок, а не новая команда на вход",
    ].filter(Boolean).join(" · ");
  }
  if (["demo_trade_opened", "demo_pending_order_opened", "demo_experiment_planned", "real_calibration_trade_opened", "real_micro_validation_planned", "real_micro_validation_trade_opened", "real_long_probe_planned", "real_long_horizon_probe_opened", "real_earn_planned", "real_earn_trade_opened"].includes(item.type)) {
    return demoTradeEventDetail(item, base);
  }
  if (item.type === "real_calibration_auto_close" || item.type === "real_micro_validation_auto_close" || item.type === "real_long_probe_auto_close" || item.type === "real_earn_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    if (trade) {
      const profitText = trade.profitText || money(Number(trade.profitValue || 0));
      const reason = trade.reason === "real_calibration_hard_ttl"
        ? "калибровочный TTL завершён, слот освобождён"
        : trade.reason === "first_real_earn_review"
          ? "первая real-сделка закрыта; поток ждёт ревью исполнения"
          : failureReasonLabel(trade.reason || "unknown");
      return [
        `${item.type === "real_earn_auto_close" ? "Real-сделка" : item.type === "real_long_probe_auto_close" ? "A31_LONG real-проба" : item.type === "real_micro_validation_auto_close" ? "Micro-real" : "Real calibration"} ${trade.side || "trade"} по ${trade.instrument || "instrument"} закрыта`,
        profitText,
        reason,
        item.type === "real_earn_auto_close"
          ? "результат идёт в отдельный real-review и может остановить следующие входы"
          : "сделка нужна была для проверки реального исполнения, а не для разгона прибыли",
      ].filter(Boolean).join(" · ");
    }
  }
  if (["demo_trade_failed", "demo_pending_order_failed", "demo_experiment_failed", "demo_experiment_rejected", "demo_experiment_skipped", "real_calibration_trade_failed", "real_micro_validation_trade_failed", "real_micro_validation_failed", "real_micro_validation_skipped", "real_long_probe_failed", "real_long_probe_auto_close_failed", "real_earn_trade_failed", "real_earn_skipped"].includes(item.type)) {
    return demoFailureEventDetail(item, base);
  }
  if (item.type === "decision") {
    return decisionEventDetail(item, base);
  }
  const profit = payload.profitText || "";
  const action = actionInfo(payload.action);
  const lane = laneInfo(payload.lane);
  if (item.type === "closed_trade_review" || item.type === "open_trade_review") {
    const parts = [];
    if (lane) parts.push(`Режим: ${lane.label.toLowerCase()}`);
    if (action) parts.push(`Решение: ${action.label.toLowerCase()}`);
    if (profit) parts.push(profit);
    if (base) parts.push(base);
    return parts.filter(Boolean).join(" · ");
  }
  if (item.type === "robot_health_changed") {
    const health = healthInfo(payload.state);
    return [health?.label, payload.reason, payload.silentMinutes ? `${payload.silentMinutes} мин без действия` : ""].filter(Boolean).join(" · ");
  }
  return base;
}

function eventCompactDetail(item) {
  const payload = item.payload || {};
  const reason = payload.reason || payload.message || payload.summary || payload.rationale || "";
  if (payload.aggregateCount > 1) {
    return compactText(`слежу ${fmtTime(payload.aggregateFirstTime)}-${fmtTime(payload.aggregateLastTime)} · ${payload.aggregateCount} раз · ${reason || payload.reason || "без нового сигнала"}`, 140);
  }
  if (item.type === "demo_open_trade_snapshot" || item.type === "real_open_trade_snapshot") {
    return compactText([payload.profitText || money(payload.profitValue || 0), payload.amount ? `занято ${money(payload.amount)}` : "", "live"].filter(Boolean).join(" · "), 120);
  }
  if (item.type === "real_earn_skipped" || item.type === "real_micro_validation_skipped") {
    return compactText(reason || "Real-вход сейчас заблокирован правилами допуска.", 120);
  }
  if (item.type === "real_calibration_auto_close" || item.type === "real_micro_validation_auto_close" || item.type === "real_long_probe_auto_close" || item.type === "real_earn_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return compactText(`${trade?.profitText || money(Number(trade?.profitValue || 0))} · сделка закрыта, подробности по клику`, 120);
  }
  if (item.type?.includes("failed")) {
    return compactText(`Исполнение не прошло: ${failureReasonLabel(reason || "ошибка")}`, 120);
  }
  if (item.type === "decision") {
    return compactText(decisionEventDetail(item, reason) || reason || "Сканирую рынок.", 120);
  }
  if (item.type === "closed_trade_review" || item.type === "open_trade_review") {
    return compactText([payload.profitText, chartVisionText(payload), payload.nextRule || payload.summary || payload.reason].filter(Boolean).join(" · "), 140);
  }
  return compactText(eventDetail(item), 120);
}

function aggregateRepeatedFeedItems(items = []) {
  const aggregates = new Map();
  const result = [];
  for (const item of items) {
    const payload = item.payload || {};
    const key = repeatedFeedObservationKey(item);
    if (!key) {
      result.push(item);
      continue;
    }
    const current = aggregates.get(key);
    if (!current) {
      const aggregate = {
        ...item,
        payload: {
          ...payload,
          aggregateKey: key,
          aggregateCount: 1,
          aggregateFirstTime: item.time,
          aggregateLastTime: item.time,
        },
      };
      aggregates.set(key, aggregate);
      result.push(aggregate);
      continue;
    }
    const currentFirst = Date.parse(current.payload.aggregateFirstTime || current.time || 0) || Date.parse(item.time || 0) || 0;
    const currentLast = Date.parse(current.payload.aggregateLastTime || current.time || 0) || Date.parse(item.time || 0) || 0;
    const eventTime = Date.parse(item.time || 0) || 0;
    current.payload.aggregateCount = Number(current.payload.aggregateCount || 1) + 1;
    current.payload.aggregateFirstTime = new Date(Math.min(currentFirst || eventTime, eventTime || currentFirst)).toISOString();
    current.payload.aggregateLastTime = new Date(Math.max(currentLast || eventTime, eventTime || currentLast)).toISOString();
    current.payload.rationale = payload.rationale || current.payload.rationale;
    current.payload.score = Math.max(Number(current.payload.score || 0), Number(payload.score || 0));
  }
  return result;
}

function passiveFeedAction(action, reason = "") {
  const normalizedAction = String(action || "");
  const normalizedReason = String(reason || "");
  if (["NO_ENTRY", "SKIP", "WATCH"].includes(normalizedAction)) return true;
  if (normalizedAction === "READY_TO_TEST" && /human_chart_|chart_vision_|volatile_watchlist|no_validated_side|needs_more_ticks|parallel_discovery|mse_human|pending_probe|opposite_after_buy_guard/i.test(normalizedReason)) return true;
  return normalizedAction === "CANDIDATE" && /watchlist|needs_more_ticks|no_validated_side|learning_guard|parallel_discovery|mse_human/i.test(normalizedReason);
}

function repeatedFeedObservationKey(item) {
  const payload = item.payload || {};
  const instrument = eventInstrument(payload);
  const reason = payload.reason || "";
  if (item.type === "demo_experiment_planned") {
    const hypothesis = payload.hypothesis || payload.microPattern || reason;
    if (/human_chart_|chart_vision_|volatile_watchlist|parallel_discovery|mse_human|pending_probe|ready/i.test(String(hypothesis))) {
      return instrument && hypothesis ? `${item.type}:${instrument}:${payload.side || ""}:${hypothesis}` : null;
    }
  }
  if ([
    "demo_pending_order_failed",
    "demo_trade_failed",
    "demo_experiment_failed",
    "demo_experiment_rejected",
    "demo_experiment_skipped",
    "real_earn_skipped",
    "real_close_waiting",
    "real_calibration_skipped",
  ].includes(item.type)) {
    return instrument && reason ? `${item.type}:${instrument}:${reason}` : null;
  }
  if (item.type !== "decision") return null;
  const action = payload.action || "";
  if (!instrument || !reason || !passiveFeedAction(action, reason)) return null;
  return `${item.type}:${instrument}:${action}:${reason}`;
}

const GENERIC_DECISION_DETAIL_RE = /Кандидат: инструмент достаточно волатилен|Наблюдаю: данных с текущего экрана пока мало|No validated side yet|No clean direction from current data|низкий приоритет для быстрого скальпа/i;

function stableIndex(value, length) {
  if (!length) return 0;
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % length;
}

function displayAssetClass(payload) {
  const explicit = payload.assetClass || "";
  if (explicit) return explicit;
  const name = String(payload.instrument || "");
  if (/BTC|Bitcoin|ETH|Ethereum|Coin|Crypto|USDT|XAUT|SPCX|Chainlink|Polygon|Litecoin|Dogecoin|Cardano|Solana|Ripple|Polkadot|BNB|XRP|LTC|DOGE|ADA|SOL|DOT|MATIC/i.test(name)) return "crypto";
  if (/Gold|Silver|XAU|XAG/i.test(name)) return "metals";
  if (/[A-Z]{2,}\/[A-Z]{2,}|EUR|USD|JPY|GBP|CHF|AUD|CAD|NZD/i.test(name)) return "fx_major";
  if (/Oil|Brent|WTI|Gas/i.test(name)) return "energy";
  if (/NDAQ|NASDAQ|SPX|Wall Street|Germany|France|Japan|UK 100|Cash/i.test(name)) return "index";
  return "single_name";
}

function candidateAngle(payload) {
  if (payload.candidateAngle) return payload.candidateAngle;
  const assetClass = displayAssetClass(payload);
  const instrument = payload.instrument || assetClass;
  const byClass = {
    crypto: [
      `${instrument}: проверяю быстрый crypto-пробой; без подтверждения лучше отложенная вилка, а не угадывание стороны`,
      `${instrument}: рынок живой 24/7, но главный риск - вход после уже выдохшегося импульса`,
      `${instrument}: подходит для cohort evidence, если cost/spread не съедает ожидаемый ход`,
      `${instrument}: ищу продолжение короткого импульса; market-вход только после свежей микросвечи в сторону сделки`,
      `${instrument}: лучше тестировать fork/pullback, если направление слабое, но волатильность достаточная`,
    ],
    fx_major: [
      "FX-кросс: тест полезен только при совпадении микродвижения и старшего направления, иначе это шум внутри спреда",
      "FX-кандидат: жду локальное подтверждение последней свечой; без него сделка будет просто случайной стороной",
      "Валютная пара в watchlist: проверяю, есть ли короткий импульс сильнее обычной болтанки и хватает ли дистанции до TP",
    ],
    metals: [
      "Металл: движение может быть резким, поэтому вход годится только с близким структурным SL и нормальным cost-to-target",
      "Gold/Silver-кандидат: не догонять свечу; нужен pullback или breakout-подтверждение перед размером выше базы",
      "Металл в фокусе: проверяю, не расширился ли спред и не прошёл ли основной ход до входа",
    ],
    energy: [
      "Energy-кандидат: ищу импульс на нефти/газе, но фильтрую входы рядом с закрытием рынка и широким спредом",
      "Сырьевой инструмент: тест имеет смысл, если движение свежее и не коррелирует с уже открытой перегрузкой",
      "Oil/Gas watch: вход только после cost-check, потому что издержки легко съедают короткий TP",
    ],
    index: [
      "Индекс: подходит для momentum-теста, если рынок открыт и нет гэпа/новостного шума прямо перед входом",
      "Index-кандидат: проверяю пробой уровня; без подтверждения лучше нейтральная отложенная вилка",
      "Индекс в фокусе: нужен быстрый импульс и понятный stop distance, иначе размер не повышать",
    ],
    single_name: [
      "Акция/одиночный инструмент: беру в тест только если движение свежее и не выглядит гэпом без ликвидности",
      "Single-name кандидат: сначала проверка торгового статуса и спреда, потом маленький демо-вход",
      "Инструмент в watchlist: данных хватает для наблюдения, но не для уверенного размера без подтверждения",
    ],
  };
  const options = byClass[assetClass] || byClass.single_name;
  return options[stableIndex(instrument, options.length)];
}

function decisionFactParts(payload) {
  const parts = [];
  if (payload.changeText) parts.push(`движение ${payload.changeText}`);
  if (payload.recommendedSide || payload.side) parts.push(`сторона ${payload.recommendedSide || payload.side}`);
  if (payload.microPattern) parts.push(`сетап ${payload.microPattern}`);
  if (payload.strategyLane) parts.push(`трек ${payload.strategyLane}`);
  if (Number.isFinite(Number(payload.score))) parts.push(`оценка ${Math.round(Number(payload.score))}`);
  return parts;
}

function shortCohortProgress(payload) {
  const stats = payload.tradePolicy?.stats;
  const pressure = payload.learningPressure;
  const n = firstDefined(stats?.effectiveN, stats?.n, pressure?.cohort?.count, pressure?.setup?.count);
  if (n === undefined || n === null || n === "") return "";
  const target = firstDefined(payload.matureTargetN, payload.tradePolicy?.matureTargetN, pressure?.cohort?.targetN, 20);
  return `когорта ${n}/${target}`;
}

function tradePolicyBrief(payload) {
  const policy = payload.tradePolicy || {};
  const amount = firstDefined(payload.amount, payload.tradeAmount, payload.sumInv, policy.amount);
  const multiplier = firstDefined(payload.multiplier, payload.tradeMultiplier, policy.multiplier);
  const tp = firstDefined(payload.tp, payload.takeProfit, policy.tp);
  const sl = firstDefined(payload.sl, payload.stopLoss, policy.sl);
  const rr = policy.rewardRisk ? `RR ${policy.rewardRisk}` : "";
  const cost = Number.isFinite(Number(policy.costR)) ? `стоимость ${Number(policy.costR).toFixed(3)}R` : "";
  return [amount ? `сумма ${money(amount)}` : "", multiplier ? `x${multiplier}` : "", tp ? `TP ${money(tp)}` : "", sl ? `SL ${money(sl)}` : "", rr, cost].filter(Boolean).join(", ");
}

function demoTradeEventDetail(item, base) {
  const payload = item.payload || {};
  const policy = payload.tradePolicy || {};
  const lane = payload.strategyLane || policy.mode || "demo";
  const setup = payload.bracketProfile || policy.bracketProfile || payload.microPattern || payload.hypothesis;
  const setupText = setupLabel(setup);
  const progress = shortCohortProgress(payload);
  const rr = policy.rewardRisk ? `RR ${policy.rewardRisk}` : "";
  const cost = Number.isFinite(Number(policy.costR)) ? `стоимость ${Number(policy.costR).toFixed(3)}R` : "";
  const brief = [rr, cost].filter(Boolean).join(" · ");
  const side = payload.side ? `${payload.side}` : "trade";
  const instrument = payload.instrument || "instrument";

  if (item.type === "real_earn_planned") {
    return [
      `Real-вход по ${instrument} поставлен в очередь`,
      setupText,
      progress,
      tradePolicyBrief(payload) || brief,
      "робот нашёл promoted-когорту и перед отправкой проверяет стоимость входа и форму сделки",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_earn_trade_opened") {
    return [
      `Real ${side} по ${instrument}: минимальная сделка по когорте, прошедшей earn-gate`,
      tradePolicyBrief(payload) || `сумма ${money(firstDefined(payload.amount, payload.sumInv, policy.amount) || 0)}`,
      "после закрытия результат попадёт в real-review; если это первый earn-вход, поток остановится на проверку исполнения",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_calibration_trade_opened") {
    return [
      `Real calibration ${side} по ${instrument}: проверяем отдельную real-сессию, фактический spread/slippage и close-channel`,
      `сумма ${money(firstDefined(payload.amount, payload.sumInv, policy.amount) || 0)}`,
      payload.multiplier ? `x${payload.multiplier}` : "",
      payload.takeProfit ? `TP ${money(payload.takeProfit)}` : "",
      payload.stopLoss ? `SL ${money(payload.stopLoss)}` : "",
      "это не прибыльный автопилот, а измерение исполнения перед Earn",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_micro_validation_trade_opened" || item.type === "real_micro_validation_planned") {
    return [
      `Micro-real ${side} по ${instrument}: маленькая карантинная проверка живого исполнения`,
      `сумма ${money(firstDefined(payload.amount, payload.sumInv, policy.amount) || 0)}`,
      payload.multiplier ? `x${payload.multiplier}` : "",
      payload.takeProfit ? `TP ${money(payload.takeProfit)}` : "",
      payload.stopLoss ? `SL ${money(payload.stopLoss)}` : "",
      "не считается strict promote evidence и не открывает normal real напрямую",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_long_horizon_probe_opened" || item.type === "real_long_probe_planned") {
    return [
      `A31_LONG ${side} по ${instrument}: длинная real-проба для проверки spread/slippage и живучести сигнала`,
      tradePolicyBrief(payload) || `сумма ${money(firstDefined(payload.amount, payload.sumInv, policy.amount) || 0)}`,
      payload.multiplier ? `x${payload.multiplier}` : "",
      "это измерение real-исполнения, а не разгон размера",
    ].filter(Boolean).join(" · ");
  }

  if (payload.hypothesis === "pending_coverage_bracket_probe" || payload.orderStyle === "pending_bracket" || item.type === "demo_pending_order_opened") {
    const leg = payload.side === "BUY"
      ? "верхняя ножка вилки: ловим пробой вверх, если цена реально ускорится"
      : payload.side === "SELL"
        ? "нижняя ножка вилки: ловим пробой вниз, если импульс продавит уровень"
        : "нейтральная отложенная вилка: ждём, куда рынок сам пробьёт";
    return [
      `Отложенная заявка ${side} по ${instrument}: ${leg}`,
      setupText,
      progress,
      brief,
    ].filter(Boolean).join(" · ");
  }

  if (lane === "maturity_fill" || /Maturity fill/i.test(String(base))) {
    return [
      `Market ${side} по ${instrument}: добираем зрелость гипотезы, не повышая доверие заранее`,
      setupText,
      progress,
      brief,
      "результат пойдёт в Wilson/cohort judgement",
    ].filter(Boolean).join(" · ");
  }

  return [
    `Demo ${side} по ${instrument}: ${candidateAngle(payload)}`,
    setupText,
    progress,
    brief,
  ].filter(Boolean).join(" · ");
}

function failureReasonLabel(reason) {
  const normalized = String(reason || "");
  if (/instrument_not_visible/i.test(normalized)) return "инструмент не найден в текущем execution-канале";
  if (/not_demo/i.test(normalized)) return "демо-счёт не подтверждён перед отправкой";
  if (/market_closed/i.test(normalized)) return "рынок/инструмент сейчас не принимает действие";
  if (/pending_eval_exception|Runtime\.evaluate/i.test(normalized)) return "ошибка формы отложенной заявки, нужен self-healing селекторов";
  if (/pending_bracket_failed/i.test(normalized)) return "отложенная вилка не выставилась, проверяю форму и маппинг инструмента";
  if (/prepare_failed/i.test(normalized)) return "форма сделки не подготовилась до submit";
  if (/submit|button/i.test(normalized)) return "submit/control в терминале не подтвердился";
  if (/selector|row_not_found|not_found/i.test(normalized)) return "селектор/строка терминала не совпали с текущим UI";
  if (/guard|blocked/i.test(normalized)) return "guard заблокировал сделку после последних результатов";
  if (/No validated side|no_validated_side/i.test(normalized)) return "нет подтвержденной стороны, лучше нейтральная отложенная вилка";
  if (/No clean direction/i.test(normalized)) return "нет чистого направления, market-вход не нужен";
  return normalized || "execution не прошёл";
}

function demoFailureEventDetail(item, base) {
  const payload = item.payload || {};
  const instrument = payload.instrument || "инструмент";
  const side = payload.side ? ` ${payload.side}` : "";
  const setup = payload.bracketProfile || payload.microPattern || payload.hypothesis || payload.tradePolicy?.bracketProfile;
  const setupText = setupLabel(setup);
  const progress = shortCohortProgress(payload);
  const compactPolicy = [
    payload.tradePolicy?.rewardRisk ? `RR ${payload.tradePolicy.rewardRisk}` : "",
    Number.isFinite(Number(payload.tradePolicy?.costR)) ? `стоимость ${Number(payload.tradePolicy.costR).toFixed(3)}R` : "",
  ].filter(Boolean).join(" · ");
  const rawReason = firstDefined(payload.result?.reason, payload.reason, base);
  const reason = failureReasonLabel(rawReason);
  const classHint = candidateAngle(payload);

  if (item.type === "real_calibration_trade_failed") {
    return [
      `Real calibration по ${instrument} не открыт: ${reason}`,
      "real lane остаётся fail-closed для автоторговли",
      "сначала чинится execution/изоляция/форма, demo investigation продолжает работать отдельно",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_earn_trade_failed") {
    return [
      `Real-сделка по ${instrument} не открыта: ${reason}`,
      setupText,
      progress,
      "это execution-блокер; робот ждёт retry-gate и не должен путать его с плохой рыночной гипотезой",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_micro_validation_trade_failed" || item.type === "real_micro_validation_failed") {
    return [
      `Micro-real по ${instrument} не открыт: ${reason}`,
      "карантинная real-валидация остаётся fail-closed",
      "strict earn-gate не ослабляется из-за этой ошибки",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_long_probe_failed" || item.type === "real_long_probe_auto_close_failed") {
    return [
      `A31_LONG real-проба по ${instrument} не прошла: ${reason}`,
      setupText,
      "это execution/закрытие надо чинить отдельно от качества рыночной гипотезы",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_earn_skipped") {
    return [
      payload.nextStep || `Real-вход пропущен: ${reason}`,
      "Если причина — нет promoted-когорты, это нормальный стоп качества; если execution/сессия — это технический блокер.",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "real_micro_validation_skipped") {
    return [
      payload.nextStep || `Micro-real пропущен: ${reason}`,
      "Это защитный стоп карантинной валидации; normal real не должен открываться в обход него.",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "demo_pending_order_failed") {
    return [
      `Отложенная заявка${side} по ${instrument} не выставлена: ${reason}`,
      setupText,
      progress,
      compactPolicy,
      "следующий шаг: не считать это рыночной гипотезой, чинить execution/маппинг отдельно",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "demo_trade_failed") {
    return [
      `Market${side} по ${instrument} не открыт: ${reason}`,
      setupText,
      progress,
      compactPolicy,
      "сделка не попадает в win/loss гипотезу, пока нет подтвержденного входа",
    ].filter(Boolean).join(" · ");
  }

  if (item.type === "demo_experiment_rejected" || item.type === "demo_experiment_skipped") {
    return [
      `Эксперимент по ${instrument} пропущен: ${reason}`,
      classHint,
      setupText,
      progress,
    ].filter(Boolean).join(" · ");
  }

  return [
    `Эксперимент по ${instrument} не прошёл: ${reason}`,
    classHint,
    setupText,
    progress,
    compactPolicy,
  ].filter(Boolean).join(" · ");
}

function decisionEventDetail(item, base) {
  const payload = item.payload || {};
  const action = payload.action || "WATCH";
  const specificBase = base && !GENERIC_DECISION_DETAIL_RE.test(String(base)) ? String(base) : "";
  if (specificBase) return specificBase;

  const facts = decisionFactParts(payload);
  if (action === "READY_TO_TEST") {
    const policy = payload.tradePolicy || {};
    const amount = firstDefined(payload.amount, payload.tradeAmount, policy.amount);
    const multiplier = firstDefined(payload.multiplier, payload.tradeMultiplier, policy.multiplier);
    const bracket = [amount ? `сумма ${money(amount)}` : "", multiplier ? `x${multiplier}` : "", policy.bracketProfile ? setupLabel(policy.bracketProfile) : ""].filter(Boolean).join(", ");
    return [`Готовлю тест: ${candidateAngle(payload)}`, bracket || "", ...facts, "перед отправкой проверяю spread/cost и форму TP/SL"].filter(Boolean).join(" · ");
  }
  if (action === "CANDIDATE") {
    return [`Кандидат: ${candidateAngle(payload)}`, ...facts, "пока без входа, если нет чистого подтверждения и приемлемого spread-to-target"].filter(Boolean).join(" · ");
  }
  if (action === "NO_ENTRY") {
    if (payload.reason === "no_validated_side") {
      return [`Вход заблокирован: нет подтверждённой стороны по ${payload.instrument || "инструменту"}`, ...facts, "нужен positive insight или свежий micro-signal"].filter(Boolean).join(" · ");
    }
    if (payload.reason === "demo_not_confirmed") return "Вход заблокирован: demo-счёт не подтверждён, не рискую отправлять заявку в неверный аккаунт.";
    if (payload.reason === "not_demo_armed") return `Вход заблокирован: сейчас не режим "${modeLabel("demo-armed")}", робот только наблюдает.`;
    return [`Вход пропущен: ${payload.reason || "guard"}`, ...facts].filter(Boolean).join(" · ");
  }
  if (action === "SKIP") {
    return [`Пропуск: ${candidateAngle(payload)}`, ...facts, "приоритет ниже текущих кандидатов, сделку не тратим"].filter(Boolean).join(" · ");
  }
  if (action === "BLOCKED" || action === "WATCH") {
    return [`Наблюдение: ${candidateAngle(payload)}`, ...facts, payload.reason ? `guard ${payload.reason}` : ""].filter(Boolean).join(" · ");
  }
  return [payload.reason || action, ...facts].filter(Boolean).join(" · ");
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function feedTradeMeta(item) {
  const payload = item.payload || {};
  if (item.type === "demo_open_trade_snapshot" || item.type === "real_open_trade_snapshot") {
    return {
      top: payload.profitText || money(payload.profitValue || 0),
      bottom: [
        payload.amount ? `занято ${money(payload.amount)}` : "",
        payload.multiplier ? `x${payload.multiplier}` : "",
        payload.ticketId || payload.id ? `id ${payload.ticketId || payload.id}` : "",
      ].filter(Boolean).join(" · "),
    };
  }
  if (item.type === "real_calibration_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return {
      top: trade?.profitText || "",
      bottom: [
        trade?.amount ? `сумма ${money(trade.amount)}` : "",
        trade?.multiplier ? `x${trade.multiplier}` : "",
        trade?.reason ? failureReasonLabel(trade.reason) : "",
      ].filter(Boolean).join(" · "),
    };
  }
  if (item.type === "real_earn_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return {
      top: trade?.profitText || "",
      bottom: [
        trade?.amount ? `сумма ${money(trade.amount)}` : "",
        trade?.multiplier ? `x${trade.multiplier}` : "",
        trade?.reason ? failureReasonLabel(trade.reason) : "",
      ].filter(Boolean).join(" · "),
    };
  }
  if (item.type === "real_micro_validation_auto_close" || item.type === "real_long_probe_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return {
      top: trade?.profitText || "",
      bottom: [
        trade?.amount ? `сумма ${money(trade.amount)}` : "",
        trade?.multiplier ? `x${trade.multiplier}` : "",
        trade?.reason ? failureReasonLabel(trade.reason) : "",
      ].filter(Boolean).join(" · "),
    };
  }
  const amount = firstDefined(payload.amount, payload.tradeAmount, payload.stakeUsd, payload.tradePolicy?.amount);
  const multiplier = firstDefined(payload.multiplier, payload.tradeMultiplier, payload.tradePolicy?.multiplier);
  const tp = firstDefined(payload.tp, payload.takeProfit, payload.tradePolicy?.tp);
  const sl = firstDefined(payload.sl, payload.stopLoss, payload.tradePolicy?.sl);
  const top = Number.isFinite(Number(amount)) ? money(amount) : amount ? `$${amount}` : payload.profitText || "";
  const bottom = [
    multiplier ? `x${multiplier}` : "",
    tp ? `TP ${money(tp)}` : "",
    sl ? `SL ${money(sl)}` : "",
  ].filter(Boolean).join(" · ");
  return { top, bottom };
}

function chartVisionText(payload = {}) {
  const vision = payload.chartVision || payload.tradePolicy?.chartVision || payload.tradePolicy?.realCohort?.chartVision || null;
  if (!vision) return "";
  const pattern = {
    human_chart_impulse_continuation: "импульс ещё живой",
    human_chart_exhaustion_reversal: "движение выдохлось, ждём разворот",
    human_chart_breakout: "пробой",
  }[vision.pattern] || vision.pattern;
  const side = vision.recommendedSide || vision.trendSide || vision.reversalSide;
  return [pattern, side ? `сторона ${side}` : "", vision.rationale].filter(Boolean).join(" · ");
}

function feedDetailRows(item) {
  const payload = item.payload || {};
  const ticket = payload.id || payload.ticketId || payload.tradeId;
  const rawAction = payload.action || payload.side;
  const rawLane = payload.lane || payload.tradePolicy?.mode || payload.mode || payload.strategyMode;
  const rows = [
    ["Событие", eventTitle(item)],
    ["Технический тип", item.type],
    ["Время", fmtTime(item.time)],
    ["Инструмент", eventInstrumentLabel(payload)],
    ["Сторона", payload.side],
    ["ID сделки", ticket],
    ["Технический код", rawAction],
    ["Трек", rawLane],
    ["Сумма", firstDefined(payload.amount, payload.tradeAmount, payload.stakeUsd, payload.tradePolicy?.amount)],
    ["Мультипликатор", firstDefined(payload.multiplier, payload.tradeMultiplier, payload.tradePolicy?.multiplier)],
    ["TP / SL", [firstDefined(payload.tp, payload.takeProfit, payload.tradePolicy?.tp), firstDefined(payload.sl, payload.stopLoss, payload.tradePolicy?.sl)].filter(Boolean).join(" / ")],
    ["Профиль входа", setupLabel(firstDefined(payload.orderStyle, payload.bracketProfile, payload.tradePolicy?.bracketProfile)) || firstDefined(payload.orderStyle, payload.bracketProfile, payload.tradePolicy?.bracketProfile)],
    ["Человеческая плоскость", chartVisionText(payload)],
    ["Доход / риск", payload.tradePolicy?.rewardRisk ? `${payload.tradePolicy.rewardRisk}R` : ""],
    ["EV_R_net", payload.tradePolicy?.expectedRNet],
    ["Стоимость входа", payload.tradePolicy?.costR],
    ["Безубыточный winrate", payload.tradePolicy?.breakevenWinRate ? `${Math.round(payload.tradePolicy.breakevenWinRate * 100)}%` : ""],
    ["Почему такой TP/SL", payload.tradePolicy?.tpSlReason],
    ["Когорта", payload.cohortId || payload.tradePolicy?.stats?.cohortId],
    ["Уверенность", payload.confidence],
    ["Политика", payload.tradePolicy?.mode],
    ["Размер позиции", payload.tradePolicy?.sizingReason || payload.sizingReason],
    ["Открытая позиция", item.type === "demo_open_trade_snapshot" || item.type === "real_open_trade_snapshot" ? `${payload.snapshotIndex || 1} из ${payload.snapshotTotal || 1}` : ""],
    ["Пояснение", eventDetail(item)],
    ["Обучение", payload.learningPressure?.state ? `${payload.learningPressure.state} · boost ${payload.learningPressure.boost || 0} · penalty ${payload.learningPressure.penalty || 0}` : ""],
    ["Рынок закрыт", payload.marketClosedBacklog?.count ? `${payload.marketClosedBacklog.count} blocked until ${fmtTime(payload.marketClosedBacklog.nextCloseAvailableAt)}` : ""],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  return rows;
}

function showFeedPopover(item) {
  showInfoPopover(eventTitle(item), feedDetailRows(item));
}

function showInfoPopover(title, rows) {
  const existing = $("feedPopover");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "feedPopover";
  modal.className = "feed-popover-backdrop";
  modal.innerHTML = `
    <section class="feed-popover" role="dialog" aria-modal="true" aria-label="Trade details">
      <button class="feed-popover-close" type="button" aria-label="Close">×</button>
      <h3>${escapeHtml(title)}</h3>
      <dl>
        ${rows.map(([label, value]) => `
          <div>
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(String(value))}</dd>
          </div>
        `).join("")}
      </dl>
    </section>
  `;
  const close = () => modal.remove();
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest(".feed-popover-close")) close();
  });
  document.addEventListener("keydown", function onKeydown(event) {
    if (event.key === "Escape") {
      close();
      document.removeEventListener("keydown", onKeydown);
    }
  });
  document.body.appendChild(modal);
}

function bindDetailsOnClick(el, title, getText) {
  if (!el || el.dataset.detailsBound === "1") return;
  el.dataset.detailsBound = "1";
  el.classList.add("has-details");
  if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
  const open = (event) => {
    if (event?.target?.closest?.("button,a,[role='button']")) return;
    const full = (getText ? getText() : el.dataset.fullText || el.textContent || "").trim();
    if (!full) return;
    showInfoPopover(title, [["Подробности", full]]);
  };
  el.addEventListener("click", open);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(event);
    }
  });
}

function renderFeed(items, options = {}) {
  const feed = $("decisionFeed");
  feed.innerHTML = "";
  const dashboardView = options.view || currentDashboardView();
  const sourceItems = items || [];
  const aggregatedSourceItems = aggregateRepeatedFeedItems(sourceItems);
  const tradeItems = aggregatedSourceItems.filter(isTradeFeedItem);
  const openItems = aggregatedSourceItems.filter(isOpenFeedItem);
  const systemItems = aggregatedSourceItems.filter(isSystemLogItem);
  const actualOpenCount = dashboardView === "real"
    ? Math.max(realLaneSummary(currentState).openTrades, openItems.length)
    : Math.max(currentDemoLaneOpenCount(currentState, currentDashboardLane(currentState)), openItems.length);
  const visibleItems =
    feedFilter === "all" ? aggregatedSourceItems : feedFilter === "logs" ? systemItems : feedFilter === "open" ? openItems : tradeItems;
  const countLabel = feedFilter === "all"
    ? `${aggregatedSourceItems.length}${aggregatedSourceItems.length !== sourceItems.length ? ` из ${sourceItems.length}` : ""} событий`
    : feedFilter === "logs"
      ? `${systemItems.length} логов`
      : feedFilter === "open"
        ? `${actualOpenCount} открыто`
        : `${tradeItems.length}${tradeItems.length !== sourceItems.filter(isTradeFeedItem).length ? ` из ${sourceItems.filter(isTradeFeedItem).length}` : ""} торговых событий`;
  setText("feedCount", countLabel);

  if (!visibleItems.length) {
    if (feedFilter === "open" && actualOpenCount > 0) {
      const lane = currentDashboardLane(currentState);
      const synthetic = dashboardView === "real"
        ? buildOpenTradeFeedItems(currentState?.realTerminal || {}, "real_open_trade_snapshot", "real", "earn", "Real-сделка")
        : buildOpenTradeFeedItems(currentState?.terminal || {}, "demo_open_trade_snapshot", "demo", lane, "Demo-сделка");
      if (synthetic.length) {
        renderFeed(synthetic, options);
        return;
      }
    }
    const emptyText = dashboardView === "real"
      ? (feedFilter === "open" ? "Открытых real-сделок сейчас нет" : feedFilter === "logs" ? "Логов real-дорожки пока нет" : feedFilter === "all" ? "Событий real-дорожки пока нет" : "Новых real-сделок пока нет")
      : (feedFilter === "open" ? "Открытых demo-сделок сейчас нет" : feedFilter === "logs" ? "Логов пока нет" : feedFilter === "all" ? "Событий пока нет" : "Сделок пока нет");
    const hint = dashboardView === "real"
      ? earnBlockerText(currentState)
      : (feedFilter === "open" ? "Если сделка открыта в терминале, она появится здесь отдельной строкой." : feedFilter === "trades" ? "Здесь появятся решения и исполнения сделок." : "Здесь появятся события сканера.");
    feed.innerHTML = `<li class="feed-empty feed-muted" tabindex="-1" role="note"><div class="feed-main"><strong>${emptyText}</strong><small title="${escapeHtml(hint)}">${escapeHtml(compactText(hint, 150))}</small></div></li>`;
    return;
  }

  const displayItems = visibleItems.slice(0, 60);
  for (const item of displayItems) {
    const detail = eventCompactDetail(item);
    const meta = feedTradeMeta(item);
    const badges = eventBadges(item);
    const li = document.createElement("li");
    li.className = feedClass(item);
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `${eventTitle(item)} details`);
    li.innerHTML = `
      <div class="feed-main">
        <div class="feed-title-row">
          <strong>${escapeHtml(eventTitle(item))}</strong>
          ${badges.length ? `
            <span class="feed-badges" aria-label="Статусы события">
              ${badges.map((badge) => `<span class="feed-badge feed-badge-${escapeHtml(badge.tone || "raw")}" title="${escapeHtml(badge.title || badge.label)}">${escapeHtml(badge.label)}</span>`).join("")}
            </span>
          ` : ""}
        </div>
        <small>${fmtTime(item.time)} ${detail ? `· ${escapeHtml(detail)}` : ""}</small>
      </div>
      ${meta.top || meta.bottom ? `
        <div class="feed-meta">
          <b>${escapeHtml(meta.top || "-")}</b>
          <span>${escapeHtml(meta.bottom || "")}</span>
        </div>
      ` : ""}
    `;
    li.addEventListener("click", () => showFeedPopover(item));
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showFeedPopover(item);
      }
    });
    feed.appendChild(li);
  }
}

function feedClass(item) {
  const payload = item.payload || {};
  if (item.type === "demo_open_trade_snapshot" || item.type === "real_open_trade_snapshot") return "feed-open";
  if (item.type === "real_calibration_trade_opened") return "feed-success";
  if (item.type === "real_calibration_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return Number(trade?.profitValue || 0) >= 0 ? "feed-success" : "feed-fail";
  }
  if (item.type === "real_calibration_trade_failed") return "feed-fail";
  if (item.type === "real_micro_validation_trade_opened") return "feed-success";
  if (item.type === "real_micro_validation_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return Number(trade?.profitValue || 0) >= 0 ? "feed-success" : "feed-fail";
  }
  if (item.type === "real_micro_validation_trade_failed" || item.type === "real_micro_validation_failed") return "feed-fail";
  if (item.type === "real_micro_validation_skipped" || item.type === "real_micro_validation_planned") return "feed-muted";
  if (item.type === "real_long_horizon_probe_opened") return "feed-success";
  if (item.type === "real_long_probe_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return Number(trade?.profitValue || 0) >= 0 ? "feed-success" : "feed-fail";
  }
  if (item.type === "real_long_probe_failed" || item.type === "real_long_probe_auto_close_failed") return "feed-fail";
  if (item.type === "real_long_probe_planned") return "feed-muted";
  if (item.type === "real_earn_trade_opened") return "feed-success";
  if (item.type === "real_earn_auto_close") {
    const trade = Array.isArray(payload.closed) ? payload.closed[0] : null;
    return Number(trade?.profitValue || 0) >= 0 ? "feed-success" : "feed-fail";
  }
  if (item.type === "real_earn_trade_failed") return "feed-fail";
  if (item.type === "real_earn_skipped" || item.type === "real_earn_planned") return "feed-muted";
  if (item.type === "demo_trade_opened") return "feed-success";
  if (item.type === "demo_pending_order_opened") return "feed-success";
  if (item.type === "demo_experiment_planned") return "feed-muted";
  if (item.type === "demo_experiment_failed") return "feed-fail";
  if (item.type === "demo_experiment_skipped") return "feed-surface";
  if (item.type === "open_trade_review") {
    if (["TAKE_PROFIT_READY", "TAKE_PROFIT_WATCH"].includes(payload.action) || payload.lane === "NEAR_EXIT") return "feed-success";
    if (["CLOSE_RISK_READY", "CLOSE_WATCH", "CLOSE_STALE_READY"].includes(payload.action) || payload.lane === "INSTANT_DUMP") return "feed-fail";
    return "feed-surface";
  }
  if (item.type === "robot_health_changed") return payload.state === "HEALTHY" ? "feed-success" : "feed-fail";
  if (isSystemLogItem(item)) return "feed-muted";
  if (payload.action === "SKIP" || payload.action === "WATCH") return "feed-surface";
  return "feed-neutral";
}

function reviewProfitValue(item) {
  if (item?.profitValue !== null && item?.profitValue !== undefined && Number.isFinite(Number(item.profitValue))) {
    return Number(item.profitValue);
  }
  const match = String(item?.profitText || "").match(/([+-])?\$([0-9][0-9.,]*)/);
  if (!match) return 0;
  const value = Number(match[2].replace(",", ""));
  return match[1] === "-" ? -value : value;
}

function reviewSide(item) {
  return item?.side === "BUY" || item?.side === "SELL" ? item.side : "UNKNOWN";
}

function reviewSideLabel(item) {
  const side = reviewSide(item);
  if (side === "BUY") return "покупка";
  if (side === "SELL") return "продажа";
  return "сторона не определена";
}

function reviewSetupName(item) {
  return [item?.hypothesis, item?.microPattern, item?.bracketProfile]
    .filter(Boolean)
    .join(" / ") || "unknown setup";
}

function reviewSetupLabel(item) {
  const setup = reviewSetupName(item);
  const labels = setup
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => setupLabel(part) || humanizeRawCode(part));
  const unique = [...new Set(labels)].filter(Boolean);
  return unique.length ? unique.join(" · ") : "Профиль не размечен";
}

function dominantReviewCluster(items) {
  const clusters = new Map();
  for (const item of items || []) {
    const key = `${item.instrument || "Unknown"}|${reviewSide(item)}`;
    const previous = clusters.get(key) || {
      instrument: item.instrument || "Unknown",
      side: reviewSide(item),
      count: 0,
      wins: 0,
      losses: 0,
      net: 0,
      latest: item,
    };
    const profit = reviewProfitValue(item);
    previous.count += 1;
    previous.net = Number((previous.net + profit).toFixed(2));
    if (profit >= 0) previous.wins += 1;
    else previous.losses += 1;
    clusters.set(key, previous);
  }
  return [...clusters.values()].sort((a, b) => (
    b.count - a.count ||
    Math.abs(b.net) - Math.abs(a.net) ||
    Date.parse(b.latest?.time || 0) - Date.parse(a.latest?.time || 0)
  ))[0] || null;
}

function normalizeAdvisorReasonForDemo(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  return raw
    .replace(
      /Текущие лимиты на используемые средства и количество открытых сделок слишком высоки\./gi,
      "Для demo это не денежный риск: лимиты означают только чистоту эксперимента, чтобы не смешивать слишком много коррелированных сделок и понимать, какая гипотеза работает.",
    )
    .replace(/снизить общие лимиты риска/gi, "снизить темп и концентрацию demo-эксперимента")
    .replace(/лимиты риска/gi, "demo-лимиты качества эксперимента")
    .replace(/значительная открытая просадка и отрицательный профит сессии/gi, "открытая demo-просадка и отрицательный результат сессии");
}

function compactAdvisorReason(text) {
  const normalized = normalizeAdvisorReasonForDemo(text);
  if (!normalized) return "";
  const first = normalized
    .split(/(?<=[.!?。])\s+/)
    .find((part) => part.trim().length > 20) || normalized;
  return first.length > 180 ? `${first.slice(0, 177).trim()}...` : first;
}

function shortenReviewText(text, limit = 160) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit - 3).trim()}...` : value;
}

function shortReviewHeadline(text, limit = 82) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return compactText(clean.replace(/^(Факт|Вывод|Ошибка):\s*/i, ""), limit);
}

function reviewUsesUnknownSetup(item) {
  return /unknown_setup|unknown setup|unclassified/i.test(reviewSetupName(item));
}

function reviewDirectionMismatch(item) {
  const text = `${item?.mistake || ""} ${item?.adjustment || ""}`.toLowerCase();
  return (
    text.includes("цена пошла против стороны сделки") ||
    text.includes("ожидали рост, фактически был падение") ||
    text.includes("ожидали падение, фактически был рост")
  );
}

function reviewNeedsCostCheck(item) {
  const text = `${item?.mistake || ""} ${item?.lesson || ""} ${item?.adjustment || ""}`.toLowerCase();
  return text.includes("спред") || text.includes("комис") || text.includes("cost check");
}

function classifyReviewIssue(item) {
  const profit = reviewProfitValue(item);
  const setup = reviewSetupName(item);
  const fallbackFact = profit >= 0
    ? "Рынок дал движение по стороне сделки, но пока это ещё не серия."
    : "Сделка закрылась в минус: нужен повторяемый фильтр, а не новый разовый вход.";

  if (reviewDirectionMismatch(item)) {
    return {
      key: "direction",
      label: "ошибка стороны входа",
      fact: reviewSide(item) === "BUY"
        ? "Факт: после входа рынок пошёл вниз, хотя ставка была на рост."
        : reviewSide(item) === "SELL"
          ? "Факт: после входа рынок пошёл вверх, хотя ставка была на падение."
          : "Факт: рынок пошёл против стороны сделки.",
    };
  }

  if (reviewUsesUnknownSetup(item)) {
    return {
      key: "labeling",
      label: "сделка без нормальной разметки",
      fact: `Факт: профиль остался неразмеченным (${setup}), значит переносить урок в правило пока рано.`,
    };
  }

  if (reviewNeedsCostCheck(item)) {
    return {
      key: "cost",
      label: "нужен контроль издержек",
      fact: "Факт: без проверки спреда и стоимости входа этот тип сделки легко съедает TP.",
    };
  }

  if (profit >= 0) {
    return {
      key: "follow_through",
      label: "направление подтвердилось",
      fact: "Факт: рынок дал продолжение по стороне сделки, но это ещё не mature-серия.",
    };
  }

  return {
    key: "mixed",
    label: "нужен следующий фильтр",
    fact: shortenReviewText(item?.mistake || item?.summary || fallbackFact, 150),
  };
}

function dominantReviewIssue(items) {
  const counters = new Map([
    ["direction", { key: "direction", label: "ошибка стороны входа", count: 0 }],
    ["labeling", { key: "labeling", label: "сделки без нормальной разметки", count: 0 }],
    ["cost", { key: "cost", label: "слабый контроль спреда/стоимости", count: 0 }],
    ["follow_through", { key: "follow_through", label: "есть подтверждённое продолжение", count: 0 }],
    ["mixed", { key: "mixed", label: "шум без одного доминирующего сбоя", count: 0 }],
  ]);
  for (const item of items || []) {
    const issue = classifyReviewIssue(item);
    const slot = counters.get(issue.key) || counters.get("mixed");
    slot.count += 1;
  }
  return [...counters.values()].sort((a, b) => b.count - a.count)[0] || counters.get("mixed");
}

function buildModelReviewCopy(items) {
  const recent = (items || []).slice(0, 8);
  if (!recent.length) {
    if (currentDashboardView() === "real") {
      const realReviewState = realClosedReviewState(currentState);
      if (realReviewState.hasSummaryOnly) {
        return {
          tone: "mixed",
          title: `${realReviewState.closedAll} real-закрытия без детального разбора`,
          summary: `<b>Статус:</b> real summary уже видит ${realReviewState.closedAll} закрытия, realized ${money(realReviewState.realized)}, но detailed review rows ещё не сформированы.`,
          action: `<b>Дальше:</b> это авария learning pipeline: следующие real-close обязаны писать native detailed review сразу; старые закрытия поднимаем fallback-карточками, но не считаем доказанным edge.`,
          evidence: [],
        };
      }
      return {
        tone: "neutral",
        title: "Реальных закрытий пока нет",
        summary: `<b>Статус:</b> у real ещё нет собственной серии закрытых рабочих сделок для разбора.`,
        action: `<b>Дальше:</b> ${compactText(realLaneHumanReason(currentState), 130)}`,
        evidence: [],
      };
    }
    return {
      tone: "neutral",
      title: "Закрытых сделок пока нет",
      summary: "<b>Статус:</b> закрытых сделок пока нет.",
      action: "<b>Дальше:</b> ждём первую серию закрытий, потом покажем повторяемый сбой или плюс.",
      evidence: [],
    };
  }

  const profits = recent.map(reviewProfitValue);
  const net = Number(profits.reduce((sum, value) => sum + value, 0).toFixed(2));
  const wins = profits.filter((value) => value >= 0).length;
  const losses = profits.length - wins;
  const latest = recent[0];
  const cluster = dominantReviewCluster(recent);
  const advisor = currentState?.advisor;
  const lastAdvisorReason = advisor?.lastDecision?.reasoning && advisor.status !== "disabled"
    ? compactAdvisorReason(advisor.lastDecision.reasoning)
    : null;
  const dominantIssue = dominantReviewIssue(recent);
  const unknownSetups = recent.filter(reviewUsesUnknownSetup).length;
  const directionMisses = recent.filter(reviewDirectionMismatch).length;
  const costFlags = recent.filter(reviewNeedsCostCheck).length;
  const nextRule = shortenReviewText(
    cluster?.latest?.adjustment ||
    latest.adjustment ||
    cluster?.latest?.lesson ||
    latest.lesson ||
    "",
    210,
  );
  const netText = money(net);
  const clusterText = cluster
    ? `${cluster.instrument} ${cluster.side}: ${cluster.count}x, ${cluster.wins}W/${cluster.losses}L, ${money(cluster.net)}`
    : "нет устойчивого кластера";
  const lossBias = losses > wins || net < 0;
  const profitBias = wins > losses && net > 0;

  let title;
  let summary;
  let action;
  let tone = "neutral";

  if (lossBias) {
    tone = "loss";
    title = `Главный сбой: ${dominantIssue.label}`;
    summary = `<b>Серия:</b> ${clusterText}. ${wins} плюс / ${losses} минус, итог ${netText}.`;
    action = `<b>Дальше:</b> ${compactText(nextRule || "не усиливаем этот кластер; нужен локальный фильтр и проверка стоимости входа.", 150)}`;
  } else if (profitBias) {
    tone = "profit";
    title = `Главный плюс: ${dominantIssue.label}`;
    summary = `<b>Серия:</b> ${clusterText}. ${wins} плюс / ${losses} минус, итог ${netText}.`;
    action = `<b>Дальше:</b> ${compactText(nextRule || "добираем независимые закрытия до зрелости; размер не повышаем по одной удачной серии.", 150)}`;
  } else {
    tone = "mixed";
    title = `Сейчас неясно: ${dominantIssue.label}`;
    summary = `<b>Серия:</b> ${clusterText}. ${wins} плюс / ${losses} минус, итог ${netText}.`;
    action = `<b>Дальше:</b> ${compactText(nextRule || "добираем чистые закрытия; правило по одной точке не строим.", 150)}`;
  }

  if (lastAdvisorReason) {
    action += ` <b>Советник:</b> ${compactText(lastAdvisorReason, 95)}`;
  }
  if (currentDashboardView() === "real") {
    const realReviewState = realClosedReviewState(currentState);
    if (realReviewState.hasBacklog) {
      tone = tone === "profit" ? "mixed" : tone;
      action += ` <b>Backlog:</b> ${realReviewState.backlog} real-закрытий есть только в summary; они не считаются доказанным обучением, пока не восстановлены detailed rows.`;
    }
  }

  return {
    tone,
    title,
    summary,
    action,
    evidence: [
      `${recent.length} закрытий`,
      `${wins} прибыльных / ${losses} убыточных`,
      `net ${netText}`,
      directionMisses ? `${directionMisses} ошибок направления` : null,
      unknownSetups ? `${unknownSetups} неизвестных профилей` : null,
      costFlags ? `${costFlags} замечаний по стоимости` : null,
      cluster ? `кластер ${cluster.instrument} ${cluster.side}` : null,
      currentDashboardView() === "real" && realClosedReviewState(currentState).hasBacklog
        ? `${realClosedReviewState(currentState).backlog} real summary-only`
        : null,
    ].filter(Boolean),
  };
}

function renderModelTradeReview(items) {
  const box = $("tradeReviewModel");
  if (!box) return;
  if (apiLocked) {
    box.className = "model-review model-loss";
    box.innerHTML = `
      <div class="model-review-copy">
        <strong>Нет доступа к данным</strong>
        <p>Страница открыта, но живое состояние ещё не авторизовано. Один раз открой с кодом, дальше браузер запомнит доверенный вход.</p>
        <p>Если после перезагрузки лента выглядит замёрзшей, открой /?code=2501 на этом устройстве.</p>
      </div>
      <div class="model-review-evidence">
        <span>состояние недоступно</span>
        <span>разборы скрыты</span>
      </div>
    `;
    return;
  }
  const model = buildModelReviewCopy(items);
  box.className = `model-review model-${model.tone}`;
  const fullSummary = `${model.title}\n\n${model.summary.replace(/<[^>]+>/g, "")}\n${model.action.replace(/<[^>]+>/g, "")}`;
  box.dataset.fullText = fullSummary;
  bindDetailsOnClick(box, "Подробный разбор серии", () => box.dataset.fullText || fullSummary);
  box.innerHTML = `
    <div class="model-review-copy">
      <strong>${model.title}</strong>
      <p>${model.summary}</p>
      <p>${model.action}</p>
    </div>
    <div class="model-review-evidence">
      ${model.evidence.map((item) => `<span>${item}</span>`).join("")}
    </div>
  `;
}

function reviewDetailRows(item) {
  const profit = reviewProfitValue(item);
  const excursion = item.excursion || {};
  const marketState = item.marketState || {};
  const learningVerdict = item.learningVerdict || {};
  const excursionText = [
    excursion.maxFavorableUsd !== undefined ? `MFE ${money(Number(excursion.maxFavorableUsd))}` : null,
    excursion.maxAdverseUsd !== undefined ? `MAE ${money(Number(excursion.maxAdverseUsd))}` : null,
    excursion.gaveBackUsd !== undefined ? `giveback ${money(Number(excursion.gaveBackUsd))}` : null,
    excursion.capturedMfeShare !== null && excursion.capturedMfeShare !== undefined ? `captured ${Math.round(Number(excursion.capturedMfeShare) * 100)}%` : null,
  ].filter(Boolean).join(" · ");
  const marketText = [
    marketState.sessionMode,
    marketState.openSessionBucket,
    marketState.assetClass,
    marketState.signalSide ? `MSE ${marketState.signalSide}` : null,
    marketState.signalAligned !== null && marketState.signalAligned !== undefined ? `aligned ${marketState.signalAligned ? "yes" : "no"}` : null,
    marketState.signalStrength !== null && marketState.signalStrength !== undefined ? `strength ${Number(marketState.signalStrength).toFixed(2)}` : null,
    marketState.costR !== null && marketState.costR !== undefined ? `costR ${Number(marketState.costR).toFixed(2)}` : null,
  ].filter(Boolean).join(" · ");
  return [
    ["Инструмент", item.instrument],
    ["Сторона", reviewSideLabel(item)],
    ["Результат", item.profitText || money(profit)],
    ["Закрыта", item.closeTime],
    ["Разобрана", fmtTime(item.time)],
    ["Тикет", item.tradeId],
    ["Execution", reviewProviderLabel(item)],
    ["Профиль", setupLabel(reviewSetupName(item)) || reviewSetupName(item)],
    ["MFE / MAE", excursionText],
    ["Market state", marketText],
    ["Learning verdict", learningVerdict.nextAction || learningVerdict.summary],
    ["Вывод модели", item.mistake || item.summary],
    ["Следующее правило", item.adjustment || item.lesson],
    ["Изменение стратегии", `${item.strategyChange?.applied ? "применено" : "не применено"}: ${item.strategyChange?.description || ""}`],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
}

function showClosedReviewPopover(item) {
  const existing = $("feedPopover");
  if (existing) existing.remove();
  const rows = reviewDetailRows(item);
  const modal = document.createElement("div");
  modal.id = "feedPopover";
  modal.className = "feed-popover-backdrop";
  modal.innerHTML = `
    <section class="feed-popover" role="dialog" aria-modal="true" aria-label="Closed trade review details">
      <button class="feed-popover-close" type="button" aria-label="Close">×</button>
      <h3>${escapeHtml(`${item.instrument || "Closed trade"} · ${item.profitText || money(reviewProfitValue(item))}`)}</h3>
      <dl>
        ${rows.map(([label, value]) => `
          <div>
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(String(value))}</dd>
          </div>
        `).join("")}
      </dl>
    </section>
  `;
  const close = () => modal.remove();
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest(".feed-popover-close")) close();
  });
  document.addEventListener("keydown", function onKeydown(event) {
    if (event.key === "Escape") {
      close();
      document.removeEventListener("keydown", onKeydown);
    }
  });
  document.body.appendChild(modal);
}

function renderClosedReviews(items) {
  const list = $("closedTradeReviews");
  list.innerHTML = "";
  document.querySelector(".review-dots")?.remove();
  renderModelTradeReview(items || []);
  $("reviewPrev").disabled = !items?.length;
  $("reviewNext").disabled = !items?.length;

  if (!items?.length) {
    const earnView = currentDashboardView() === "real";
    if (earnView) {
      const realReviewState = realClosedReviewState(currentState);
      list.innerHTML = realReviewState.hasSummaryOnly
        ? `<li class="review-empty"><strong>${realReviewState.closedAll} real-закрытия без learning-карточек</strong><small>Summary уже видит realized ${escapeHtml(money(realReviewState.realized))}. Это не норма: следующие real-close должны сразу писать detailed review, старые поднимаются fallback-ом только как аварийное восстановление.</small></li>`
        : `<li class="review-empty"><strong>Реальных закрытий пока нет</strong><small>Как только закроется первая real-сделка на earn-линии, здесь появится отдельный разбор только по real.</small></li>`;
    } else {
      list.innerHTML = `<li class="review-empty"><strong>Закрытых разборов пока нет</strong><small>Карточки появятся после закрытия первых сделок.</small></li>`;
    }
    return;
  }

  const shown = items.slice(0, 4);
  for (const [index, item] of shown.entries()) {
    const li = document.createElement("li");
    li.id = `closed-review-${index}`;
    const profit = reviewProfitValue(item);
    li.className = profit >= 0 ? "review-profit" : "review-loss";
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `Open details for ${item.instrument || "closed trade"}`);
    const setup = reviewSetupLabel(item);
    const issue = classifyReviewIssue(item);
    li.innerHTML = `
      <div class="review-card-top">
        <strong>${escapeHtml(item.instrument || "Unknown")}</strong>
        <span>${escapeHtml(item.profitText || money(profit))}</span>
      </div>
      <small>${escapeHtml(`${reviewProviderLabel(item)} · ${reviewSideLabel(item)} · ${item.closeTime || fmtTime(item.time)}${item.tradeId ? ` · ${item.tradeId}` : ""}`)}</small>
      <p>${escapeHtml(`${setup} · ${issue.label}`)}</p>
      <em>${escapeHtml(shortReviewHeadline(issue.fact, 96))}</em>
    `;
    li.addEventListener("click", () => showClosedReviewPopover(item));
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showClosedReviewPopover(item);
      }
    });
    list.appendChild(li);
  }

  const dots = document.createElement("div");
  dots.className = "review-dots";
  shown.forEach((_, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.ariaLabel = `Show closed review ${index + 1}`;
    button.className = index === 0 ? "active" : "";
    button.addEventListener("click", () => {
      $(`closed-review-${index}`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
      dots.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    });
    dots.appendChild(button);
  });
  document.querySelector(".review-slider")?.after(dots);
}

function armSound() {
  soundArmed = true;
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  audioContext.resume?.();
}

function playTradeSound(outcome) {
  if (!soundArmed) return;
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  const now = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  osc.type = outcome === "profit" ? "sine" : "triangle";
  osc.frequency.setValueAtTime(outcome === "profit" ? 880 : 170, now);
  if (outcome === "profit") osc.frequency.exponentialRampToValueAtTime(1174, now + 0.11);
  filter.type = "lowpass";
  filter.frequency.value = outcome === "profit" ? 1800 : 420;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(outcome === "profit" ? 0.035 : 0.025, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + (outcome === "profit" ? 0.18 : 0.28));
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + (outcome === "profit" ? 0.2 : 0.3));
}

function notifyNewClosedReviews(items) {
  const ids = new Set((items || []).map((item) => item.id || `${item.instrument}:${item.time}:${item.profitText}`));
  if (seenClosedReviewIds === null) {
    seenClosedReviewIds = ids;
    return;
  }
  for (const item of items || []) {
    const id = item.id || `${item.instrument}:${item.time}:${item.profitText}`;
    if (!seenClosedReviewIds.has(id)) {
      playTradeSound(item.outcome === "profit" ? "profit" : "loss");
    }
  }
  seenClosedReviewIds = ids;
}

function scrollReviewSlider(direction) {
  const list = $("closedTradeReviews");
  const amount = Math.max(260, list.clientWidth);
  list.scrollBy({ left: direction * amount, behavior: "smooth" });
}

function setupReviewSliderDrag() {
  const list = $("closedTradeReviews");
  let dragging = false;
  let startX = 0;
  let startScrollLeft = 0;

  list.addEventListener("pointerdown", (event) => {
    dragging = true;
    startX = event.clientX;
    startScrollLeft = list.scrollLeft;
    list.setPointerCapture(event.pointerId);
    list.classList.add("dragging");
  });

  list.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    list.scrollLeft = startScrollLeft - (event.clientX - startX);
  });

  list.addEventListener("pointerup", (event) => {
    dragging = false;
    list.releasePointerCapture(event.pointerId);
    list.classList.remove("dragging");
  });

  list.addEventListener("pointercancel", () => {
    dragging = false;
    list.classList.remove("dragging");
  });

  list.addEventListener(
    "wheel",
    (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    },
    { passive: false },
  );
}

function renderInsights(items) {
  const list = $("insightList");
  list.innerHTML = "";
  const allItems = items || [];
  const newest = [...allItems].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0] || null;
  const positiveItems = allItems.filter((item) => item.sentiment === "positive");
  const negativeItems = allItems.filter((item) => item.sentiment === "negative");
  const liveRiskItems = allItems.filter((item) => item.status === "live_risk");
  const filtered = allItems
    .filter((item) => {
      if (insightFilter === "positive") return item.sentiment === "positive";
      if (insightFilter === "negative") return item.sentiment === "negative";
      return true;
    })
    .sort((a, b) => {
      if (insightFilter === "recent") return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
      return 0;
    });
  setText("insightCount", insightFilter === "all" ? `${allItems.length} инсайтов` : `${filtered.length}/${allItems.length} инсайтов`);
  const scan = currentState?.learning?.lastClosedReviewScan;
  const latestClosed = scan?.latestInstrument
    ? `Последняя проверка закрытых сделок ${fmtTime(scan.time)}: строк ${scan.reviewed || 0}, новых ${scan.newReviews || 0}, последняя ${scan.latestInstrument} ${scan.latestProfitText || ""}.`
    : "Проверка закрытых сделок ещё не дала данных.";
  let explanation = newest
    ? `Последний инсайт ${fmtTime(newest.createdAt)}: ${newest.title}.`
    : "Инсайтов пока нет.";
  if (insightFilter === "positive") {
    explanation = `Positive shows only profitable closed-trade hypotheses: ${positiveItems.length} positive, ${negativeItems.length} negative, ${liveRiskItems.length} live-risk alerts hidden here. ${latestClosed}`;
  } else if (insightFilter === "negative") {
    explanation = `Negative includes closed losses and live open-risk alerts. ${latestClosed}`;
  } else if (insightFilter === "recent") {
    explanation = `${explanation} ${latestClosed}`;
  } else {
    explanation = `${allItems.length} total: ${positiveItems.length} positive, ${negativeItems.length} negative, ${liveRiskItems.length} live-risk. ${latestClosed}`;
  }
  setText("insightExplain", explanation);

  if (!filtered.length) {
    list.innerHTML = `<li><strong>В этом фильтре инсайтов нет</strong><small>${escapeHtml(explanation)}</small></li>`;
    return;
  }

  for (const item of filtered.slice(0, 8)) {
    const li = document.createElement("li");
    li.className = item.status === "rule_applied" ? "insight-applied" : item.status === "candidate_rule" ? "insight-candidate" : "insight-watch";
    li.innerHTML = `
      <div class="insight-top">
        <strong>${item.title}</strong>
        <span>${item.score}/10</span>
      </div>
      <small>${item.status} · ${item.evidence || ""}</small>
      <p>${item.summary || ""}</p>
      <p class="insight-change">${item.appliedChange || ""}</p>
    `;
    list.appendChild(li);
  }
}

function renderStrategyBalance(reviews) {
  const canvas = $("strategyBalanceChart");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);

  const now = Date.now();
  const items = [...(reviews || [])]
    .filter((item) => reviewMatchesProviderFilter(item))
    .filter((item) => Number(item.profitValue) !== 0)
    .filter((item) => {
      if (!strategyRangeMs) return true;
      const tradeTime = reviewTimestamp(item);
      return Number.isFinite(tradeTime) && now - tradeTime <= strategyRangeMs;
    })
    .sort((a, b) => {
      const timeA = reviewTimestamp(a);
      const timeB = reviewTimestamp(b);
      return timeA - timeB;
    });
  const positive = items.filter((item) => Number(item.profitValue) > 0);
  const negative = items.filter((item) => Number(item.profitValue) < 0);
  const closedNet = items.reduce((sum, item) => sum + (Number(item.profitValue) || 0), 0);
  const openProfit = Number(currentState?.terminal?.profitValue ?? currentState?.performance?.openProfit ?? 0) || 0;
  const reviewedPlusOpen = closedNet + openProfit;

  let positiveValue = 0;
  let negativeValue = 0;
  const points = items.map((item, index) => {
    const profit = Number(item.profitValue) || 0;
    if (strategyMetric === "sum") {
      if (profit > 0) positiveValue += profit;
      if (profit < 0) negativeValue += Math.abs(profit);
    } else {
      if (profit > 0) positiveValue += 1;
      if (profit < 0) negativeValue += 1;
    }
    const total = positiveValue + negativeValue;
    return {
      x: items.length <= 1 ? width : (index / (items.length - 1)) * width,
      ratio: total > 0 ? positiveValue / total : 0.5,
      mode: item.strategyMode || currentState?.strategyMode || "investigate",
    };
  });
  const total = positiveValue + negativeValue;
  const positivePct = total > 0 ? Math.round((positiveValue / total) * 100) : 0;
  const negativePct = total > 0 ? 100 - positivePct : 0;
  const providerLabel = strategyProviderFilter === "mt5" ? "MT5" : strategyProviderFilter === "cdp" ? "CDP" : "Combined";
  setText("strategyBalanceMeta", `${items.length} closed · ${providerLabel} · ${strategyMetric} · ${strategyRangeLabel()}`);
  setText("strategyPositiveText", strategyMetric === "sum" ? `${positivePct}% · ${compactMoney(positiveValue)}` : `${positivePct}% · ${positive.length} wins`);
  setText("strategyNegativeText", strategyMetric === "sum" ? `${negativePct}% · ${compactMoney(-negativeValue)}` : `${negativePct}% · ${negative.length} losses`);
  setText("strategyClosedNetText", compactMoney(closedNet));
  setText("strategyOpenNetText", compactMoney(openProfit));
  setText("strategyReviewedNetText", compactMoney(reviewedPlusOpen));
  const evidence = currentState?.learning?.executionProviderEvidence?.providers || {};
  const providerEvidence = strategyProviderFilter === "mt5"
    ? {
        n: Number(evidence.MT5_DEMO?.n || 0) + Number(evidence.MT5_REAL?.n || 0),
        reviewedNet: Number(evidence.MT5_DEMO?.reviewedNet || 0) + Number(evidence.MT5_REAL?.reviewedNet || 0),
      }
    : strategyProviderFilter === "cdp"
      ? evidence.CDP_LEGACY
      : evidence.COMBINED;
  const providerEvidenceText = providerEvidence
    ? ` Provider evidence: n=${providerEvidence.n ?? 0}, net ${money(providerEvidence.reviewedNet || 0)}, cost-covered ${Math.round(Number(providerEvidence.costCoveredShare || 0) * 100)}%.`
    : "";
  setText("strategyBalanceNote", `График показывает ${providerLabel} reviewed closes за ${strategyRangeLabel()}, а не депозит/equity.${providerEvidenceText} CDP и MT5 не смешиваются без Combined.`);
  $("strategyClosedNetText").classList.toggle("positive", closedNet > 0);
  $("strategyClosedNetText").classList.toggle("negative", closedNet < 0);
  $("strategyOpenNetText").classList.toggle("positive", openProfit > 0);
  $("strategyOpenNetText").classList.toggle("negative", openProfit < 0);
  $("strategyReviewedNetText").classList.toggle("positive", reviewedPlusOpen > 0);
  $("strategyReviewedNetText").classList.toggle("negative", reviewedPlusOpen < 0);

  ctx.fillStyle = "#11161b";
  ctx.fillRect(0, 0, width, height);
  if (!items.length) {
    const latestTime = Math.max(
      ...((reviews || [])
        .map(reviewTimestamp)
        .filter((value) => Number.isFinite(value)))
    );
    const latestText = Number.isFinite(latestTime) ? ` Latest closed review: ${fmtTime(new Date(latestTime).toISOString())}.` : "";
    ctx.fillStyle = "rgba(167, 176, 187, 0.82)";
    ctx.font = "14px system-ui";
    ctx.fillText(`No closed reviews in ${strategyRangeLabel()}`, 18, 34);
    ctx.fillStyle = "rgba(167, 176, 187, 0.58)";
    ctx.font = "12px system-ui";
    ctx.fillText("Switch to Day/Week or wait for trades to close.", 18, 56);
    setText("strategyBalanceNote", `No ${providerLabel} reviewed closed trades for ${strategyRangeLabel()}.${latestText} Switch provider to Combined if you want all execution evidence.`);
    return;
  }
  ctx.fillStyle = "rgba(240, 96, 95, 0.18)";
  ctx.fillRect(0, 0, width, height / 2);
  ctx.fillStyle = "rgba(95, 196, 106, 0.16)";
  ctx.fillRect(0, height / 2, width, height / 2);
  ctx.strokeStyle = "rgba(215, 221, 227, 0.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  for (const [index, point] of points.entries()) {
    if (point.mode !== "investigate") continue;
    const prevX = index === 0 ? 0 : points[index - 1].x;
    const nextX = index === points.length - 1 ? width : points[index + 1].x;
    const x0 = index === 0 ? 0 : (prevX + point.x) / 2;
    const x1 = index === points.length - 1 ? width : (point.x + nextX) / 2;
    ctx.fillStyle = "rgba(135, 145, 155, 0.16)";
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
  }

  const yFor = (ratio) => height - ratio * height;
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (const point of points) ctx.lineTo(point.x, yFor(point.ratio));
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fillStyle = "rgba(95, 196, 106, 0.42)";
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (const point of points) ctx.lineTo(point.x, yFor(point.ratio));
  ctx.lineTo(width, 0);
  ctx.closePath();
  ctx.fillStyle = "rgba(240, 96, 95, 0.38)";
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const y = yFor(point.ratio);
    if (index === 0) ctx.moveTo(point.x, y);
    else ctx.lineTo(point.x, y);
  });
  ctx.strokeStyle = positivePct >= 50 ? "#67c96f" : "#f0605f";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function wilsonLowerBound(wins, total, z = 1.96) {
  if (!total) return 0;
  const phat = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = phat + z2 / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  return (center - margin) / denominator;
}

function hypothesisStatusBucket(item) {
  const status = item?.status || "unknown";
  const positive = item?.sentiment === "positive";
  const score = Number(item?.score || 0);
  if (status === "rule_applied") return positive ? "applied" : "rejected";
  if (positive && (status === "candidate_rule" || status === "live_candidate") && score >= 7) return "confirmed";
  if (status === "live_risk" || (!positive && score >= 7)) return "rejected";
  if (status === "needs_more_data" || status === "candidate_rule" || status === "live_candidate") return "testing";
  return "new";
}

function instrumentClass(name = "") {
  const text = String(name);
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(text)) return "FX";
  if (/Bitcoin|Ethereum|Binance|BTC|ETH|BNB|Crypto|Coin|USDT|Solana|Ripple|Litecoin|Dogecoin/i.test(text)) return "Crypto";
  if (/Gold|Silver|XAU|XAG/i.test(text)) return "Metals";
  if (/Oil|Brent|WTI|Gas/i.test(text)) return "Energy";
  if (/NDAQ|NASDAQ|SPX|S&P|Dow|DAX|FTSE|Cash|Germany|UK 100|Wall Street/i.test(text)) return "Index";
  return "Stock";
}

function fmtEtaMoment(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "-";
  const date = new Date(Number(timestamp));
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour12: false,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function reviewRatePerHour(timestamps, effectiveRatio, windowMs, now = Date.now()) {
  const recent = timestamps.filter((time) => Number.isFinite(time) && time >= now - windowMs);
  if (!recent.length) return 0;
  const oldest = recent[0];
  const hours = Math.max((now - oldest) / 3600000, 1 / 6);
  return (recent.length * effectiveRatio) / hours;
}

function buildEtaTarget(needed, ratePerHour, now = Date.now()) {
  if (needed <= 0) {
    return {
      needed: 0,
      ratePerHour,
      hours: 0,
      ready: true,
      stalled: false,
      etaAt: now,
    };
  }
  if (!(ratePerHour > 0)) {
    return {
      needed,
      ratePerHour,
      hours: Infinity,
      ready: false,
      stalled: true,
      etaAt: null,
    };
  }
  const hours = needed / ratePerHour;
  return {
    needed,
    ratePerHour,
    hours,
    ready: false,
    stalled: false,
    etaAt: now + hours * 3600000,
  };
}

function buildParallelEta(targets, now = Date.now()) {
  if (!targets?.length) return null;
  if (targets.every((target) => target.ready)) {
    return {
      needed: 0,
      ratePerHour: 0,
      hours: 0,
      ready: true,
      stalled: false,
      etaAt: now,
    };
  }
  if (targets.some((target) => target.stalled)) {
    return {
      needed: targets.reduce((sum, target) => sum + (target.needed || 0), 0),
      ratePerHour: 0,
      hours: Infinity,
      ready: false,
      stalled: true,
      etaAt: null,
    };
  }
  const hours = Math.max(...targets.map((target) => target.hours || 0));
  return {
    needed: targets.reduce((sum, target) => sum + (target.needed || 0), 0),
    ratePerHour: 0,
    hours,
    ready: false,
    stalled: false,
    etaAt: now + hours * 3600000,
  };
}

function etaHeadline(target) {
  if (!target) return "-";
  if (target.ready) return "ready now";
  if (target.stalled) return "stalled";
  return `${shortDuration(target.hours * 3600000)} · ${fmtEtaMoment(target.etaAt)}`;
}

function etaNote(target, noun) {
  if (!target) return `need ${noun}`;
  if (target.ready) return `${noun} already collected`;
  if (target.stalled) return `need ${target.needed} more ${noun}; current review pace is too low`;
  return `need ${target.needed} more ${noun} at current pace`;
}

function etaLooksTooFar(target, thresholdHours) {
  return Boolean(target && !target.ready && (target.stalled || target.hours > thresholdHours));
}

function etaCompactText(target) {
  if (!target) return "ETA не посчитан";
  if (target.ready) return "готово сейчас";
  if (target.stalled) return "темп плавает";
  return `примерно через ${shortDuration(target.hours * 3600000)}`;
}

function buildHypothesisHealth(state) {
  const insights = state.learning?.insights || [];
  const reviews = [
    ...(state.learning?.closedTradeReviews || []),
    ...(state.learning?.realClosedTradeReviews || []).map((item) => ({
      ...item,
      lane: item.lane || "real",
      realMoney: true,
    })),
  ];
  const decisions = state.scanner?.decisions || [];
  const correlation = state.learning?.correlation || {};
  const now = Date.now();
  const buckets = { new: 0, testing: 0, confirmed: 0, applied: 0, rejected: 0 };
  for (const item of insights) buckets[hypothesisStatusBucket(item)] += 1;

  const reviewCount = reviews.length;
  const effectiveReviewCount = Number.isFinite(Number(correlation.effectiveReviews))
    ? Number(correlation.effectiveReviews)
    : reviewCount;
  const clusterShare = Number.isFinite(Number(correlation.clusterShare)) ? Number(correlation.clusterShare) : 0;
  const wins = reviews.filter((item) => reviewProfitValue(item) > 0 || item.outcome === "profit").length;
  const losses = reviews.filter((item) => reviewProfitValue(item) < 0 || item.outcome === "loss").length;
  const grossWin = reviews.reduce((sum, item) => sum + Math.max(0, reviewProfitValue(item)), 0);
  const grossLoss = reviews.reduce((sum, item) => sum + Math.abs(Math.min(0, reviewProfitValue(item))), 0);
  const net = grossWin - grossLoss;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const expectedValue = reviewCount ? net / reviewCount : 0;
  const wilson = wilsonLowerBound(wins, reviewCount);
  const classifiedReviews = reviews.filter((item) => !/unknown|unclassified/i.test(reviewSetupName(item))).length;
  const classifiedRatio = reviewCount ? classifiedReviews / reviewCount : 0;
  const effectiveRatio = reviewCount > 0 ? effectiveReviewCount / reviewCount : 1;
  const cohorts = new Map();
  for (const review of reviews) {
    const setup = reviewSetupName(review).replace(/\s+/g, " ").trim();
    const assetClass = review.assetClass || instrumentClass(review.instrument);
    const key = review.cohortId || review.setupId || `${assetClass}|${reviewSide(review)}|${setup}`;
    const previous = cohorts.get(key) || { count: 0, wins: 0, net: 0, times: [] };
    previous.count += 1;
    const profit = reviewProfitValue(review);
    previous.net += profit;
    if (profit > 0 || review.outcome === "profit") previous.wins += 1;
    const timestamp = reviewTimestamp(review);
    if (Number.isFinite(timestamp)) previous.times.push(timestamp);
    cohorts.set(key, previous);
  }
  const cohortCounts = [...cohorts.values()].map((item) => item.count * effectiveRatio).sort((a, b) => a - b);
  const cohortStats = [...cohorts.values()].map((item) => ({
    ...item,
    effectiveCount: item.count * effectiveRatio,
    rate24h: reviewRatePerHour(item.times || [], effectiveRatio, 24 * 60 * 60 * 1000, now),
    rate48h: reviewRatePerHour(item.times || [], effectiveRatio, 48 * 60 * 60 * 1000, now),
    wilson: wilsonLowerBound(item.wins, item.count),
    ev: item.count ? item.net / item.count : 0,
  })).map((item) => ({
    ...item,
    pace: item.rate24h > 0 && item.rate48h > 0 ? Math.min(item.rate24h, item.rate48h) : item.rate24h || item.rate48h || 0,
  }));
  const medianCohortN = cohortCounts.length ? cohortCounts[Math.floor(cohortCounts.length / 2)] : 0;
  const mature = cohortStats.filter((item) => item.effectiveCount >= 20);
  const matureCohorts = mature.length;
  const significantCohorts = mature.filter((item) => item.wilson >= 0.5).length;
  const weakestMatureWilson = mature.length ? Math.min(...mature.map((item) => item.wilson)) : null;
  const new24h = insights.filter((item) => {
    const time = Date.parse(item.createdAt || item.time || item.latestAt || 0);
    return Number.isFinite(time) && now - time <= 24 * 60 * 60 * 1000;
  }).length;
  const planned24h = decisions.filter((item) => {
    const time = Date.parse(item.time || 0);
    return item.type === "demo_experiment_planned" && Number.isFinite(time) && now - time <= 24 * 60 * 60 * 1000;
  }).length;
  const openProfit = Number(state.terminal?.profitValue ?? state.performance?.openProfit ?? 0) || 0;
  const total = insights.length;
  const confirmedRatio = total ? (buckets.confirmed + buckets.applied) / total : 0;
  const rejectedRatio = total ? buckets.rejected / total : 0;
  const independentEvidenceRatio = clamp(effectiveReviewCount / 60, 0, 1);
  const maturityScore = clamp(matureCohorts / 3, 0, 1);
  const medianScore = clamp(medianCohortN / 20, 0, 1);
  const pfScore = profitFactor === Infinity ? 1 : clamp((profitFactor - 0.8) / 1.0, 0, 1);
  const evScore = clamp((expectedValue + 0.15) / 0.45, 0, 1);
  const healthScore = clamp(Math.round(
    6 +
    maturityScore * 30 +
    medianScore * 18 +
    confirmedRatio * 14 +
    classifiedRatio * 14 +
    independentEvidenceRatio * 10 +
    pfScore * 6 +
    evScore * 6 -
    rejectedRatio * 8 -
    clamp(clusterShare / 0.6, 0, 1) * 14
  ), 0, 100);

  const sortedReviews = [...reviews].sort((a, b) => {
    const timeA = reviewTimestamp(a);
    const timeB = reviewTimestamp(b);
    return timeA - timeB;
  });
  const reviewTimes = sortedReviews.map(reviewTimestamp).filter((time) => Number.isFinite(time));
  let runningWins = 0;
  let runningNet = 0;
  const trend = sortedReviews.map((item, index) => {
    const profit = reviewProfitValue(item);
    if (profit > 0 || item.outcome === "profit") runningWins += 1;
    runningNet += profit;
    const count = index + 1;
    const runningWilson = wilsonLowerBound(runningWins, count);
    const ev = runningNet / count;
    return {
      x: count,
      value: clamp(35 + runningWilson * 40 + clamp((ev + 0.1) / 0.35, 0, 1) * 25, 0, 100),
    };
  });

  const rate6h = reviewRatePerHour(reviewTimes, effectiveRatio, 6 * 60 * 60 * 1000, now);
  const rate24h = reviewRatePerHour(reviewTimes, effectiveRatio, 24 * 60 * 60 * 1000, now);
  const rateOverall = reviewTimes.length
    ? (effectiveReviewCount / Math.max((now - reviewTimes[0]) / 3600000, 1 / 6))
    : 0;
  const sustainableRate = rate6h > 0 && rate24h > 0
    ? Math.min(rate6h, rate24h)
    : rate6h || rate24h || rateOverall;
  const cohortNeeds = cohortStats
    .map((item) => Math.max(0, 20 - item.effectiveCount))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const cohortsTracked = cohortStats.length;
  const closestCohorts = cohortStats
    .filter((item) => item.effectiveCount < 20)
    .sort((a, b) => b.effectiveCount - a.effectiveCount);
  const leader = closestCohorts[0] || null;
  const missingForOne = matureCohorts >= 1 ? 0 : (leader ? Math.max(0, 20 - leader.effectiveCount) : (cohortsTracked ? 20 : null));
  const missingForThree = cohortsTracked === 0
    ? null
    : matureCohorts >= 3
      ? 0
      : cohortNeeds.slice(0, Math.max(0, 3 - matureCohorts)).reduce((sum, value) => sum + value, 0);
  const missingForAll = cohortsTracked ? cohortNeeds.reduce((sum, value) => sum + value, 0) : null;
  const etaOne = missingForOne === null
    ? null
    : matureCohorts >= 1
      ? buildEtaTarget(0, sustainableRate, now)
      : buildEtaTarget(missingForOne, leader?.pace || sustainableRate, now);
  const etaThree = missingForThree === null
    ? null
    : matureCohorts >= 3
      ? buildEtaTarget(0, sustainableRate, now)
      : buildParallelEta(
          closestCohorts
            .slice(0, Math.max(0, 3 - matureCohorts))
            .map((item) => buildEtaTarget(Math.max(0, 20 - item.effectiveCount), item.pace || sustainableRate, now)),
          now
        );
  const etaAll = missingForAll === null ? null : buildEtaTarget(missingForAll, sustainableRate, now);
  const etaConcern = etaLooksTooFar(etaOne, 72) || etaLooksTooFar(etaThree, 7 * 24) || etaLooksTooFar(etaAll, 14 * 24) || effectiveRatio < 0.4 || sustainableRate < 0.05;

  return {
    total,
    new24h,
    planned24h,
    buckets,
    reviewCount,
    effectiveReviewCount,
    effectiveRatio,
    clusterShare,
    correlation,
    wins,
    losses,
    net,
    profitFactor,
    expectedValue,
    wilson,
    classifiedRatio,
    medianCohortN,
    matureCohorts,
    significantCohorts,
    weakestMatureWilson,
    openProfit,
    healthScore,
    trend,
    cohortsTracked,
    sustainableRate,
    rate6h,
    rate24h,
    etaOne,
    etaThree,
    etaAll,
    etaConcern,
  };
}

function drawHypothesisHealthChart(trend) {
  const canvas = $("hypothesisHealthChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#11161b";
  ctx.fillRect(0, 0, width, height);

  const pad = { top: 16, right: 12, bottom: 24, left: 62 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const yFor = (value) => pad.top + (1 - clamp(value, 0, 100) / 100) * plotH;
  const xFor = (index) => pad.left + (trend.length <= 1 ? 0 : (index / (trend.length - 1)) * plotW);

  ctx.fillStyle = "rgba(95, 196, 106, 0.14)";
  ctx.fillRect(pad.left, yFor(100), plotW, yFor(70) - yFor(100));
  ctx.fillStyle = "rgba(214, 174, 88, 0.11)";
  ctx.fillRect(pad.left, yFor(70), plotW, yFor(45) - yFor(70));
  ctx.fillStyle = "rgba(240, 96, 95, 0.16)";
  ctx.fillRect(pad.left, yFor(45), plotW, yFor(0) - yFor(45));

  ctx.strokeStyle = "rgba(215, 221, 227, 0.18)";
  ctx.lineWidth = 1;
  ctx.font = "11px system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const tick of [
    [100, "100 ready"],
    [70, "70 earn gate"],
    [45, "45 mixed"],
    [0, "0 noise"],
  ]) {
    const y = yFor(tick[0]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(167, 176, 187, 0.86)";
    ctx.fillText(tick[1], pad.left - 8, y);
  }

  ctx.strokeStyle = "rgba(215, 221, 227, 0.22)";
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(167, 176, 187, 0.78)";
  ctx.fillText("closed reviews ->", pad.left, height - 6);

  if (!trend?.length) {
    ctx.fillStyle = "rgba(167, 176, 187, 0.8)";
    ctx.font = "12px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("Need closed reviews before trend exists", pad.left + 12, height / 2);
    return;
  }

  ctx.beginPath();
  trend.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const last = trend.at(-1)?.value || 0;
  ctx.strokeStyle = last >= 60 ? "#67c96f" : last >= 42 ? "#d6ae58" : "#f0605f";
  ctx.lineWidth = 3;
  ctx.stroke();

  const lastX = xFor(trend.length - 1);
  const lastY = yFor(last);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "12px system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(238, 241, 244, 0.92)";
  ctx.fillText(`${Math.round(last)}% now`, width - pad.right, Math.max(4, lastY + 6));
}

function renderHypothesisHealth(state) {
  const health = buildHypothesisHealth(state);
  const improvement = state.learning?.improvement || {};
  const totals = improvement.totals || {};
  const fillTargets = improvement.maturityTargets || [];
  const promotions = improvement.promotions || [];
  const rejections = improvement.rejections || [];
  const nextExperiments = improvement.nextExperiments || [];
  const engineScore = Number.isFinite(Number(improvement.learningQuality))
    ? Number(improvement.learningQuality)
    : health.healthScore;
  const label = health.healthScore >= 70
    ? "ready to promote selected cohorts"
    : health.healthScore >= 45
      ? "mixed evidence"
      : "too noisy for earn";
  const pf = health.profitFactor === Infinity ? "∞" : health.profitFactor.toFixed(2);
  const medianCohortText = Number.isFinite(Number(health.medianCohortN))
    ? Number(health.medianCohortN).toFixed(health.medianCohortN >= 10 ? 0 : 1).replace(/\.0$/, "")
    : "0";
  const maturityMeta = health.matureCohorts
    ? `${health.matureCohorts} ready-to-judge cohorts`
    : "0 ready-to-judge cohorts (need sample target)";
  setText("hypothesisHealthMeta", `${totals.rawReviews ?? health.reviewCount} raw / ${totals.effectiveReviews ?? health.effectiveReviewCount} independent reviews · ${fillTargets.length || health.buckets.testing} fill targets · ${maturityMeta}`);
  setText("hypothesisHealthScore", `${engineScore}%`);
  const nextEtaHint = promotions.length
    ? "promote gate is open"
    : etaCompactText(health.etaOne);
  setText("hypothesisHealthLabel", `${label} · median cohort ${medianCohortText} closes · PF ${pf} · ${nextEtaHint}`);
  setText("hypothesisTotal", totals.cohorts ?? health.total);
  setText("hypothesisNew", totals.newIdeas24h ?? health.new24h);
  setText("hypothesisTesting", fillTargets.length || health.buckets.testing);
  setText("hypothesisMature", totals.mature ?? health.matureCohorts);
  setText("hypothesisConfirmed", promotions.length || health.buckets.confirmed);
  setText("hypothesisAppliedRejected", `${promotions.length || health.buckets.applied} / ${rejections.length || health.buckets.rejected}`);
  setText("mobileHypothesisMeta", `${engineScore}% · ${label}`);
  const etaMeta = health.sustainableRate > 0
    ? `pace ${health.sustainableRate.toFixed(1)} independent reviews/h · compression ${(health.effectiveRatio || 0).toFixed(2)}`
    : "no stable closed-review pace yet";
  setText("hypothesisEtaMeta", etaMeta);
  setText("hypothesisEtaOne", etaHeadline(health.etaOne));
  setText("hypothesisEtaThree", etaHeadline(health.etaThree));
  setText("hypothesisEtaAll", etaHeadline(health.etaAll));
  setText("hypothesisEtaOneNote", etaNote(health.etaOne, "independent closes"));
  setText("hypothesisEtaThreeNote", etaNote(health.etaThree, "independent closes"));
  setText("hypothesisEtaAllNote", health.etaAll
    ? etaNote(health.etaAll, "independent closes")
    : "no tracked review cohorts yet");
  $("hypothesisEtaOne")?.classList.toggle("negative", etaLooksTooFar(health.etaOne, 72));
  $("hypothesisEtaThree")?.classList.toggle("negative", etaLooksTooFar(health.etaThree, 7 * 24));
  $("hypothesisEtaAll")?.classList.toggle("negative", etaLooksTooFar(health.etaAll, 14 * 24));
  $("hypothesisEtaOne")?.classList.toggle("positive", Boolean(health.etaOne?.ready));
  $("hypothesisEtaThree")?.classList.toggle("positive", Boolean(health.etaThree?.ready));
  $("hypothesisEtaAll")?.classList.toggle("positive", Boolean(health.etaAll?.ready));

  const scoreEl = $("hypothesisHealthScore");
  scoreEl.classList.toggle("positive", engineScore >= 70);
  scoreEl.classList.toggle("negative", engineScore < 45);

  const funnel = $("hypothesisFunnel");
  const rows = [
    ["Когорты", totals.cohorts ?? health.total, "Отдельные гипотезы по инструменту, стороне и профилю входа"],
    ["Сырые сигналы 24ч", totals.newIdeas24h ?? health.new24h, "MSE/chart/advisor наблюдения; это не готовые сделки"],
    ["Открыто/запланировано 24ч", totals.planned24h ?? health.planned24h, "Демо-пробы, которые дошли до исполнения или плана"],
    ["Независимые разборы", totals.effectiveReviews ?? health.effectiveReviewCount, "Закрытые сделки после поправки на корреляцию"],
    ["Нужно добрать", fillTargets.length || health.buckets.testing, "Когорты, которые робот повторяет до своей цели по выборке"],
    ["Достаточная выборка", totals.mature ?? health.matureCohorts, "Когорты, которые набрали нужное число независимых закрытий"],
    ["Кандидаты в реал", promotions.length || health.significantCohorts, "Зрелые прибыльные когорты для проверки исполнения"],
    ["Следующие тесты", nextExperiments.length, "Конкретные когорты, которым нужно добрать закрытые сделки"],
    ["Отсеяно / пауза", rejections.length || health.buckets.rejected, "Шумные, вредные или временно заблокированные когорты"],
  ];
  const max = Math.max(1, ...rows.map(([, value]) => value));
  funnel.innerHTML = rows.map(([name, value, help]) => `
    <div class="hypothesis-funnel-row">
      <span>${name}</span>
      <div><i style="width:${Math.max(4, (value / max) * 100)}%"></i></div>
      <strong>${value}</strong>
      <small>${help}</small>
    </div>
  `).join("");

  const promoteReady = (promotions.length || health.significantCohorts) > 0;
  const rejectReady = health.weakestMatureWilson !== null && health.weakestMatureWilson < 0.4;
  const noisy = health.classifiedRatio < 0.65;
  setText("hypothesisPromoteGate", promoteReady
    ? `Есть ${promotions.length || health.significantCohorts} когорт, которые уже можно нести в проверку исполнения. Это уже ближе к Earn, чем просто достаточная выборка.`
    : `Пока 0 кандидатов в реал: достаточная выборка сама по себе мало. Для Earn нужна не просто зрелая, а ещё и прибыльная когорта с нормальным PF и Wilson выше порога безубыточности.`);
  setText("hypothesisRejectGate", rejectReady
    ? `Отсекаем зрелые убыточные когорты: худший Wilson ${Math.round(health.weakestMatureWilson * 100)}% ниже 40%.`
    : `Отсекаем только после целевой выборки и Wilson ниже 40%; серии убытков до этого остаются наблюдениями.`);
  setText("hypothesisNoiseGate", noisy
    ? `Слишком много неизвестных профилей: классифицировано только ${Math.round(health.classifiedRatio * 100)}%. Нужно логировать профиль, триггер, spread, ATR и TTL.`
    : `Покрытие профилей ${Math.round(health.classifiedRatio * 100)}%: когорты пригодны для проверки на переход в реал.`);
  setText("hypothesisHealthSummary",
    `${improvement.summary || "Движок улучшений собирает факты по когортам."} ` +
    `Нули в “достаточной выборке” и “кандидатах в реал” означают не “нечего тестировать”, а “ещё нет когорты, которую можно честно пускать дальше”. ` +
    `${health.etaConcern ? "ETA слишком дальний или корреляционная поправка слишком сильная: это знак, что текущий темп закрытых разборов или фокус по когортам неэффективен. " : ""}` +
    `Следующий фокус: ${nextExperiments[0]?.reason || fillTargets[0]?.reason || "набрать закрытые ревью по уже начатым когортам, а не плодить шумные новые гипотезы"}. ` +
    `Внешние market priors можно использовать только как каркас для приоритета и очереди тестов, но не как доказательство зрелости когорты. ` +
    `Корреляционная поправка: ${health.reviewCount} сырых разборов считаются как ${health.effectiveReviewCount} независимых. ` +
    `Закрытые разборы: ${health.wins} прибыльных / ${health.losses} убыточных, итог ${money(health.net)}, открытый P/L ${money(health.openProfit)}. ` +
    `ETA в зрелости — это только время до набора данных. Реальный вход начнётся позже и только если когорта после этого останется прибыльной и пройдёт пороги качества.`);
  drawHypothesisHealthChart(health.trend);
  return health;
}

function renderLearningMeter(state) {
  const improvement = state.learning.improvement || {};
  const health = buildHypothesisHealth(state);
  const realSummary = realLaneSummary(state);
  const realStatus = realLaneStatus(state);
  const promotions = improvement.promotions || [];
  const topFocus = (improvement.nextExperiments || [])[0] || (improvement.maturityTargets || [])[0] || null;
  const focusDone = topFocus ? Math.max(0, Number(topFocus.effectiveN ?? 0)) : 0;
  const focusNeed = topFocus ? Math.max(0, Number(topFocus.needed ?? topFocus.sampleGap ?? 0)) : 0;
  const focusTargetN = Math.max(1, Number(topFocus?.matureTargetN || 20));
  const focusProgress = topFocus ? clamp(focusDone / focusTargetN, 0, 1) : 0;
  const focusQualityRequired = Math.max(1, Number(topFocus?.setupQualityRequired || 30));
  const focusQuality = topFocus ? clamp(Number(topFocus.setupQualityMedian || 0) / focusQualityRequired, 0, 1) : 0;
  const focusPfRequired = Math.max(0.1, Number(topFocus?.promoteProfitFactorRequired || 1.15));
  const rawFocusPf = topFocus && (topFocus.profitFactor === "Infinity" || topFocus.profitFactor === Infinity)
    ? Infinity
    : Number(topFocus?.profitFactor || 0);
  const focusPf = topFocus
    ? rawFocusPf === Infinity
      ? 1
      : clamp(Math.tanh(Math.max(0, rawFocusPf) / focusPfRequired), 0, 1)
    : 0;
  const focusWilsonTarget = Math.max(0.01, Number(topFocus?.promoteWilsonTarget || 0.41));
  const focusWilson = clamp(Number(topFocus?.wilsonLower || 0) / focusWilsonTarget, 0, 1);
  const focusNetOk = Number(topFocus?.net || 0) > 0 ? 1 : 0;
  const passLikelihood = clamp(focusQuality * focusPf * focusWilson * focusNetOk, 0, 1);
  const effectiveReviews = Number(improvement.totals?.effectiveReviews ?? health.effectiveReviewCount ?? 0) || 0;
  const readinessBlockers = [];
  if (!topFocus) readinessBlockers.push("нет live-когорты");
  if (effectiveReviews < 3) readinessBlockers.push(`мало разборов ${effectiveReviews}/3`);
  if (topFocus && focusDone < Math.min(3, focusTargetN)) readinessBlockers.push(`sample ${Math.round(focusDone)}/${focusTargetN}`);
  if (topFocus && Number(topFocus.net || 0) <= 0) readinessBlockers.push("net≤0");
  if (topFocus && focusQuality < 0.5) readinessBlockers.push("quality<50%");
  if (topFocus && focusPf < 0.5) readinessBlockers.push("PF слабый");
  if (topFocus && focusWilson < 0.5) readinessBlockers.push("Wilson слабый");
  if (promotions.length === 0) readinessBlockers.push("promote=0");
  const calibrationDone = Math.max(
    Number(state?.risk?.realLane?.completedProbeCount || 0),
    Number(state?.risk?.realLane?.calibrationOpenedCount || 0),
  );
  const calibrationTarget = Math.max(1, Number(state?.risk?.realLane?.targetProbeCount || 0) || 1);
  const calibrationProgress = clamp(calibrationDone / calibrationTarget, 0, 1);
  const realReadyInfrastructure = realLaneIsActive(state);
  const realFunded = realLaneHasFundedActivity(state);
  const realPhase = String(state?.risk?.realLane?.phase || "");
  const realProbeActive = realSummary.openTrades > 0 && /probe|validation|calibration/i.test(realPhase);
  const realReadinessScore = Number(improvement.realReadiness?.score);
  let earnReadiness = Math.round(focusProgress * passLikelihood * 65);
  if (Number.isFinite(realReadinessScore)) {
    earnReadiness = Math.max(earnReadiness, Math.round(realReadinessScore));
  }
  if (promotions.length > 0) {
    earnReadiness = Math.max(earnReadiness, 72 + Math.min(13, promotions.length * 4 + Math.round(focusQuality * 5)));
  }
  if (realSummary.openTrades > 0) {
    earnReadiness = Math.max(earnReadiness, realProbeActive ? 5 : 20);
  } else if (realStatus === "LIVE" && realSummary.closedTradesAll > 0 && promotions.length > 0) {
    earnReadiness = Math.max(earnReadiness, 78);
  }
  if (!realReadyInfrastructure) {
    earnReadiness = Math.min(earnReadiness, 15);
  } else if (!realFunded) {
    earnReadiness = Math.min(earnReadiness, 22);
  } else if (calibrationProgress < 1) {
    earnReadiness = Math.min(earnReadiness, 35);
  }
  earnReadiness = clamp(earnReadiness, 0, 100);
  const position = clamp(100 - earnReadiness, 0, 100);
  const fill = $("learningMeterFill");
  const thumb = $("learningMeterThumb");
  fill.style.width = "0";
  thumb.style.left = `${position}%`;

  const focusText = topFocus
    ? `${topFocus.instrument} ${topFocus.side} ${Math.min(focusTargetN, Math.round(focusDone))}/${focusTargetN}`
    : "нет фокуса";
  const reviewText = `${effectiveReviews} независимых ревью`;
  const blockerText = readinessBlockers.slice(0, 4).join(", ");
  const focusEta = topFocus ? nextTargetEta(state, topFocus) : null;
  const etaHint = promotions.length
    ? "готово к real-аудиту"
    : focusNeed > 0
      ? etaCompactText(focusEta?.target || health.etaOne)
      : "закрытия добраны";
  const passText = passLikelihood < 0.25
    ? "допуск в real маловероятен по текущим метрикам"
    : passLikelihood < 0.55
      ? "качество спорное, нужен добор"
      : "качество похоже на проходное";
  const gateText = topFocus ? cohortGateUiText(topFocus) : "";
  const realPrereqText = !realReadyInfrastructure
    ? "real-канал не включён"
    : !realFunded
      ? "real не пополнен"
      : calibrationProgress < 1
        ? `real-калибровка ${calibrationDone}/${calibrationTarget}`
        : "real-канал проверен";
  const probeText = realProbeActive
    ? `real-проба активна: ${realSummary.openTrades} открыто, P/L ${money(realSummary.openProfitUsd)}`
    : `real-сделка в рынке: ${realSummary.openTrades} открыто, P/L ${money(realSummary.openProfitUsd)}`;
  const lastFailure = state?.risk?.realLane?.lastFailureDetail || {};
  const retryAt = Date.parse(state?.risk?.realLane?.lastLongProbeFailureAt || 0);
  const retryMinutes = retryAt ? Math.ceil(Math.max(0, retryAt + 5 * 60 * 1000 - Date.now()) / 60000) : 0;
  const realLaneNextStep = String(state?.risk?.realLane?.nextStep || "");
  const longProbeRecentNetStop = /real_long_probe_recent_net_stop/i.test(realLaneNextStep);
  const longProbeLossStreakStop = /real_long_probe_loss_streak_stop/i.test(realLaneNextStep);
  const microRealText = realPhase === "long_horizon_real_probe"
    ? realSummary.openTrades > 0
      ? probeText
      : longProbeRecentNetStop
        ? "micro-real stop: свежий probe-loss"
        : longProbeLossStreakStop
          ? "micro-real stop: серия probe-loss"
          : retryMinutes > 0
        ? `micro-real slot free; retry через ~${retryMinutes}м после ${lastFailure.instrument || "последней"} ошибки`
        : `micro-real slot free; ищу следующий инструмент после ${lastFailure.instrument || "последней"} ошибки`
    : "";
  const label = realSummary.openTrades > 0
    ? `${probeText}; это измерение, не доказанный режим заработка`
    : microRealText
      ? `${microRealText}; edge ещё не доказан`
    : promotions.length > 0
      ? `${promotions.length} кандидат(ов) на реал, нужен финальный аудит`
      : topFocus
        ? `до реала: ${edgeProgressLabel(passLikelihood, promotions)}; ${focusText}; ещё ${focusNeed} закрытий; ${etaHint} до оценки, не до сделки; ${passText}; ${gateText}; стопоры: ${blockerText || "не выявлены"}`
        : `до реала: нет живой когорты в фокусе; стопоры: ${blockerText || "нет входных данных"}`;
  thumb.classList.toggle("ready", earnReadiness >= 70);
  thumb.classList.toggle("mixed", earnReadiness >= 35 && earnReadiness < 70);
  thumb.classList.toggle("testing", earnReadiness < 35);
  const leftLabel = earnReadiness >= 70
    ? "готов к real-аудиту"
    : earnReadiness >= 35
      ? "edge проверяется"
      : realSummary.openTrades > 0
        ? "real-проба"
        : "edge не доказан";
  const rightLabel = longProbeRecentNetStop || longProbeLossStreakStop
    ? "стоп после убытка"
    : promotions.length > 0
      ? "нужен аудит"
      : earnReadiness >= 35
        ? "нужны закрытия"
        : "нужны разборы";
  setText("learningMeterLeftLabel", leftLabel);
  setText("learningMeterRightLabel", rightLabel);
  const text = `${earnReadiness}% до реального заработка · ${label} · ${realPrereqText} · ${reviewText}`;
  const shortLabel = realSummary.openTrades > 0
    ? `${earnReadiness}% · ${realProbeActive ? "real-проба" : "real"}: ${realSummary.openTrades}, P/L ${money(realSummary.openProfitUsd)}`
    : microRealText
      ? `${earnReadiness}% edge · ${microRealText}${blockerText ? ` · ${blockerText}` : ""}`
    : promotions.length > 0
      ? `${earnReadiness}% · ${promotions.length} кандидат(ов) на real-аудит`
      : topFocus
        ? `${earnReadiness}% · ${focusText}; ${blockerText || `${focusNeed} до оценки`}`
        : `${earnReadiness}% · ${blockerText || "нет live-когорты"}`;
  setCompactText("learningMeterText", shortLabel, 90);
  const strategyCard = document.querySelector(".strategy-mode-card");
  if (strategyCard) {
    strategyCard.dataset.fullText = text;
    strategyCard.title = "Нажми, чтобы открыть подробности готовности";
  }

  document.querySelectorAll("[data-strategy-mode]").forEach((button) => {
    const active = button.dataset.strategyMode === currentDashboardLane(state);
    button.classList.toggle("active", active);
    button.disabled = false;
    button.title = button.dataset.strategyMode === "real"
      ? "Показать только real-дорожку и её разборы."
      : button.dataset.strategyMode === "demo_earn"
        ? "Показать только demo-попытки заработать: открытые сделки, P/L и разборы earn-контура."
        : "Показать demo-лабораторию: быстрые MSE/human-chart проверки и исследовательские сделки.";
  });
}

function marketStateSummary(state) {
  const priceSignals = state?.scanner?.priceSignals || {};
  const signals = Array.isArray(priceSignals.signals) ? priceSignals.signals : [];
  if (!signals.length) {
    return priceSignals.error
      ? `MSE: ошибка ${priceSignals.error}`
      : "MSE: ждёт 1m price signals";
  }
  const actionable = signals
    .map((signal) => ({
      instrument: signal.instrument,
      side: signal.recommendedSide || signal.micro?.recommendedSide || null,
      confidence: Number(signal.micro?.confidence ?? signal.confidence ?? 0) || 0,
      pattern: signal.micro?.pattern || "market_state",
      volRegime: signal.micro?.volRegime || signal.volRegime || "",
      strength: Number(signal.micro?.signalStrength ?? signal.signalStrength ?? 0) || 0,
      chartVision: signal.chartVision || signal.micro?.chartVision || null,
    }))
    .filter((signal) => signal.side)
    .sort((a, b) => b.confidence - a.confidence);
  const top = actionable[0];
  const coverage = `${priceSignals.coverage ?? actionable.length}/${priceSignals.total ?? signals.length}`;
  if (!top) return `MSE: ${coverage} режимов, пока без стороны`;
  const vision = top.chartVision?.reversalCandidate
    ? " · chart: разворот"
    : top.chartVision?.reversalWatch
      ? " · chart: pending разворот"
      : top.chartVision?.continuationLatePenalty
        ? " · chart: поздний импульс"
        : "";
  return `MSE: ${coverage} · ${top.instrument} ${top.side} ${Math.round(top.confidence)}% · ${top.volRegime || top.pattern}${vision} · сила ${top.strength.toFixed(2)}`;
}

function renderEarnRibbon(state) {
  const ribbon = $("earnRibbon");
  if (!ribbon) return;
  const dashboardView = currentDashboardView(state);
  const status = realLaneStatus(state);
  const summary = realLaneSummary(state);
  const show = dashboardView === "demo" && realLaneIsActive(state);
  ribbon.hidden = !show;
  if (!show) return;

  const title = status === "DRAINING"
    ? "Earning is stopping"
    : status === "LIVE"
      ? "Earning is running"
      : "Earning is armed";
  const summaryText = `${summary.closedTradesAll} closed all · ${summary.closedTrades24h} closed 24h · ${money(summary.netProfitUsd)} total` +
    `${summary.openTrades ? ` · ${summary.openTrades} open` : ""}`;

  ribbon.classList.toggle("negative", summary.netProfitUsd < 0);
  setText("earnRibbonTitle", title);
  setText("earnRibbonSummary", summaryText);
}

function setDashboardSectionVisibility(view) {
  const earnView = view === "real";
  for (const id of EARN_HIDDEN_SECTION_IDS) {
    const section = $(id);
    if (section) section.hidden = earnView;
  }
  document.querySelector(".secondary-controls")?.toggleAttribute("hidden", earnView);
  document.querySelector(".learning-panel")?.toggleAttribute("hidden", earnView);
  document.querySelector(".demo-panel")?.toggleAttribute("hidden", earnView);
  document.querySelectorAll(".mobile-section-list [data-mobile-target]").forEach((button) => {
    const target = button.getAttribute("data-mobile-target");
    button.hidden = earnView && EARN_HIDDEN_SECTION_IDS.includes(target);
  });
}

function renderModeButtons(mode) {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function periodLabel(ms) {
  return {
    600000: "10м",
    3600000: "1ч",
    14400000: "4ч",
    28800000: "8ч",
    86400000: "день",
    604800000: "неделя",
    2592000000: "месяц",
  }[ms] || "период";
}

function shortDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (ms > 0 && minutes === 0) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function humanSilentDuration(minutes) {
  const safeMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
  if (safeMinutes < 60) {
    return `${safeMinutes} ${safeMinutes === 1 ? "минута" : safeMinutes < 5 ? "минуты" : "минут"}`;
  }
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}ч ${mins}м` : `${hours}ч`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}д ${restHours}ч` : `${days}д`;
}

function periodProfit(history, rangeMs, fallback, metric = "openProfit") {
  const points = (history || []).filter((point) => {
    if (!Number.isFinite(Number(point[metric]))) return false;
    if (metric !== "openProfit") return true;
    return point.profitKnown || Number(point.openProfit) !== 0 || Number(point.used) === 0;
  });
  if (points.length < 2) {
    return {
      value: fallback ?? 0,
      coverageMs: 0,
      fullCoverage: false,
      points: points.length,
    };
  }
  const cutoff = Date.now() - rangeMs;
  const current = points.at(-1);
  const exactStart = [...points].reverse().find((point) => Date.parse(point.time) <= cutoff);
  const start = exactStart || points[0];
  const coverageMs = Math.max(0, Date.parse(current.time) - Date.parse(start.time));
  if (!exactStart) {
    const currentValue = Number(current[metric]);
    const startValue = Number(start[metric]);
    return {
      value: Number.isFinite(currentValue) && Number.isFinite(startValue)
        ? Number((currentValue - startValue).toFixed(2))
        : Number.isFinite(Number(fallback)) ? Number(fallback) : 0,
      coverageMs,
      fullCoverage: false,
      points: points.length,
      startTime: start.time,
    };
  }
  return {
    value: Number((Number(current[metric]) - Number(start[metric])).toFixed(2)),
    coverageMs,
    fullCoverage: true,
    points: points.length,
    startTime: start.time,
  };
}

function periodProfitStrictWindow(history, rangeMs, fallback, metric = "openProfit") {
  const cutoff = Date.now() - rangeMs;
  const points = (history || [])
    .filter((point) => Number.isFinite(Number(point[metric])) && Date.parse(point.time) >= cutoff)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const currentValue = Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
  if (points.length < 2) {
    return {
      value: 0,
      balanceDelta: 0,
      openDelta: 0,
      currentOpen: currentValue,
      flatOpen: Math.abs(currentValue) >= 0.005,
      coverageMs: 0,
      fullCoverage: false,
      points: points.length,
      startTime: points[0]?.time || null,
    };
  }
  const start = points[0];
  const current = points.at(-1);
  const value = Number((Number(current[metric]) - Number(start[metric])).toFixed(2));
  return {
    value,
    balanceDelta: 0,
    openDelta: value,
    currentOpen: currentValue,
    flatOpen: Math.abs(value) < 0.005 && Math.abs(currentValue) >= 0.005,
    coverageMs: Math.max(0, Date.parse(current.time) - Date.parse(start.time)),
    fullCoverage: Date.parse(start.time) <= cutoff + 60 * 1000,
    points: points.length,
    startTime: start.time,
  };
}

function periodNetProfit(history, rangeMs, state) {
  const balanceFallback = state?.performance?.baselineBalance !== null && state?.performance?.baselineBalance !== undefined &&
    state?.performance?.currentBalance !== null && state?.performance?.currentBalance !== undefined
    ? Number(state.performance.currentBalance) - Number(state.performance.baselineBalance)
    : 0;
  const balance = periodProfit(history, rangeMs, balanceFallback, "balance");
  const open = periodProfit(history, rangeMs, state?.performance?.openProfit ?? 0, "openProfit");
  const value = Number(((Number(balance.value) || 0) + (Number(open.value) || 0)).toFixed(2));
  const currentOpen = Number(state?.performance?.openProfit ?? state?.terminal?.profitValue ?? 0) || 0;
  const flatOpen = Math.abs(Number(open.value) || 0) < 0.005 && Math.abs(currentOpen) >= 0.005;
  return {
    value,
    balanceDelta: Number(balance.value) || 0,
    openDelta: Number(open.value) || 0,
    currentOpen,
    flatOpen,
    coverageMs: Math.min(balance.coverageMs || 0, open.coverageMs || 0) || Math.max(balance.coverageMs || 0, open.coverageMs || 0),
    fullCoverage: Boolean(balance.fullCoverage && open.fullCoverage),
    points: Math.min(balance.points || 0, open.points || 0),
    startTime: open.startTime || balance.startTime,
  };
}

function setDelta(id, result) {
  const el = $(id);
  const value = Number(result.value);
  el.textContent = compactMoney(value);
  el.classList.toggle("positive", Number(result.value) > 0);
  el.classList.toggle("negative", Number(result.value) < 0);
  el.title = result.fullCoverage ? `Полный период: ${periodLabel(result.rangeMs)}` : `Покрыто только ${shortDuration(result.coverageMs)} из ${periodLabel(result.rangeMs)}`;
}

function renderBalanceDeltas(history) {
  const fallbackBalanceDelta = currentState?.performance?.baselineBalance !== null && currentState?.performance?.baselineBalance !== undefined &&
    currentState?.performance?.currentBalance !== null && currentState?.performance?.currentBalance !== undefined
    ? Number(currentState.performance.currentBalance) - Number(currentState.performance.baselineBalance)
    : 0;
  const day = { ...periodProfit(history, 86400000, fallbackBalanceDelta, "balance"), rangeMs: 86400000 };
  const week = { ...periodProfit(history, 604800000, fallbackBalanceDelta, "balance"), rangeMs: 604800000 };
  const month = { ...periodProfit(history, 2592000000, fallbackBalanceDelta, "balance"), rangeMs: 2592000000 };
  setDelta("balanceDay", day);
  setDelta("balanceWeek", week);
  setDelta("balanceMonth", month);
}

function hasReliableProfitPoint(point) {
  return Number.isFinite(Number(point.openProfit)) && (point.profitKnown || Number(point.openProfit) !== 0 || Number(point.used) === 0);
}

function hasNumericField(point, field) {
  return Number.isFinite(Number(point?.[field]));
}

function demoLayerPoint(point, lane) {
  if (!point) return null;
  const profitField = lane === "earn" ? "demoEarnOpenProfit" : "demoExploreOpenProfit";
  const usedField = lane === "earn" ? "demoEarnUsed" : "demoExploreUsed";
  if (hasNumericField(point, profitField)) {
    return {
      ...point,
      lane: lane === "earn" ? "demo_earn" : "demo_explore",
      strategyMode: lane === "earn" ? "earn" : "investigate",
      openProfit: Number(point[profitField]),
      used: hasNumericField(point, usedField) ? Number(point[usedField]) : 0,
      profitKnown: true,
    };
  }
  const mode = String(point?.strategyMode || point?.mode || point?.tradePolicy?.mode || "").toLowerCase();
  const pointLane = String(point?.lane || "").toLowerCase();
  const oldEarn = pointLane !== "real" && ["earn", "demo_earn", "validation", "validated_only"].includes(mode);
  if (lane === "earn" && oldEarn) return point;
  if (lane === "explore" && pointLane !== "real" && !oldEarn && !hasNumericField(point, "demoEarnOpenProfit")) return point;
  return null;
}

function isDemoEarnHistoryPoint(point) {
  if (hasNumericField(point, "demoEarnOpenProfit")) return true;
  const mode = String(point?.strategyMode || point?.mode || point?.tradePolicy?.mode || "").toLowerCase();
  const lane = String(point?.lane || "").toLowerCase();
  return lane !== "real" && ["earn", "demo_earn", "validation", "validated_only"].includes(mode);
}

function isDemoExploreHistoryPoint(point) {
  if (hasNumericField(point, "demoExploreOpenProfit")) return true;
  const lane = String(point?.lane || "").toLowerCase();
  return lane !== "real" && !isDemoEarnHistoryPoint(point);
}

function demoEarnHistoryStats(history = []) {
  const points = (history || []).filter((point) => isDemoEarnHistoryPoint(point) && hasReliableProfitPoint(point));
  const first = points[0];
  const last = points.at(-1);
  const firstValue = Number(first?.openProfit);
  const lastValue = Number(last?.openProfit);
  return {
    points,
    visible: points.length >= 2,
    current: Number.isFinite(lastValue) ? lastValue : 0,
    delta: Number.isFinite(firstValue) && Number.isFinite(lastValue) ? Number((lastValue - firstValue).toFixed(2)) : 0,
  };
}

function filterDemoHistoryByLane(history = [], lane = chartLaneFilter) {
  if (lane === "earn") return (history || []).map((point) => demoLayerPoint(point, "earn")).filter(Boolean);
  if (lane === "explore") return (history || []).map((point) => demoLayerPoint(point, "explore")).filter(Boolean);
  return history || [];
}

function historyNetChange(history = [], fallbackOpen = 0) {
  const points = (history || []).filter((point) => (
    Number.isFinite(Number(point.balance)) ||
    Number.isFinite(Number(point.openProfit))
  ));
  if (!points.length) {
    return {
      value: 0,
      balanceDelta: 0,
      openDelta: 0,
      currentOpen: Number(fallbackOpen) || 0,
      points: 0,
      coverageMs: 0,
    };
  }
  const first = points[0];
  const last = points.at(-1);
  const firstBalance = Number(first.balance);
  const lastBalance = Number(last.balance);
  const firstOpen = Number(first.openProfit);
  const lastOpen = Number(last.openProfit);
  const balanceDelta = Number.isFinite(firstBalance) && Number.isFinite(lastBalance)
    ? Number((lastBalance - firstBalance).toFixed(2))
    : 0;
  const openDelta = Number.isFinite(firstOpen) && Number.isFinite(lastOpen)
    ? Number((lastOpen - firstOpen).toFixed(2))
    : Number(lastOpen || fallbackOpen || 0);
  return {
    value: Number((balanceDelta + openDelta).toFixed(2)),
    balanceDelta,
    openDelta,
    currentOpen: Number.isFinite(lastOpen) ? lastOpen : Number(fallbackOpen) || 0,
    points: points.length,
    coverageMs: Math.max(0, Date.parse(last.time || 0) - Date.parse(first.time || 0)),
  };
}

function periodNetProfitFromHistory(history = [], rangeMs, fallbackOpen = 0) {
  const balance = periodProfit(history, rangeMs, 0, "balance");
  const open = periodProfit(history, rangeMs, fallbackOpen, "openProfit");
  const value = Number(((Number(balance.value) || 0) + (Number(open.value) || 0)).toFixed(2));
  const currentOpen = Number.isFinite(Number(fallbackOpen)) ? Number(fallbackOpen) : 0;
  const flatOpen = Math.abs(Number(open.value) || 0) < 0.005 && Math.abs(currentOpen) >= 0.005;
  return {
    value,
    balanceDelta: Number(balance.value) || 0,
    openDelta: Number(open.value) || 0,
    currentOpen,
    flatOpen,
    coverageMs: Math.min(balance.coverageMs || 0, open.coverageMs || 0) || Math.max(balance.coverageMs || 0, open.coverageMs || 0),
    fullCoverage: Boolean(balance.fullCoverage && open.fullCoverage),
    points: Math.min(balance.points || 0, open.points || 0),
    startTime: open.startTime || balance.startTime,
  };
}

function demoEarnFinancialStats(history = [], rangeMs = periodRangeMs) {
  const earnHistory = filterDemoHistoryByLane(history, "earn");
  const net = historyNetChange(earnHistory, 0);
  const period = periodNetProfitFromHistory(earnHistory, rangeMs, net.currentOpen);
  return {
    history: earnHistory,
    net,
    period,
    currentOpen: net.currentOpen,
  };
}

function sampleChartPoints(points, limit = 1600) {
  if (!Array.isArray(points) || points.length <= limit) return points || [];
  const selected = new Map();
  const add = (index) => {
    if (index >= 0 && index < points.length) selected.set(index, points[index]);
  };
  add(0);
  add(points.length - 1);

  const bucketCount = Math.max(1, Math.floor((limit - 2) / 4));
  const bucketSize = (points.length - 2) / bucketCount;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.max(1, Math.floor(1 + bucket * bucketSize));
    const end = Math.min(points.length - 2, Math.floor(1 + (bucket + 1) * bucketSize));
    let minProfit = { index: start, value: Infinity };
    let maxProfit = { index: start, value: -Infinity };
    let minUsed = { index: start, value: Infinity };
    let maxUsed = { index: start, value: -Infinity };
    for (let index = start; index <= end; index += 1) {
      const point = points[index];
      const profit = Number(point.openProfit);
      const used = Number(point.used);
      if (Number.isFinite(profit)) {
        if (profit < minProfit.value) minProfit = { index, value: profit };
        if (profit > maxProfit.value) maxProfit = { index, value: profit };
      }
      if (Number.isFinite(used)) {
        if (used < minUsed.value) minUsed = { index, value: used };
        if (used > maxUsed.value) maxUsed = { index, value: used };
      }
    }
    [minProfit, maxProfit, minUsed, maxUsed]
      .filter((item) => Number.isFinite(item.value))
      .forEach((item) => add(item.index));
  }
  return [...selected.entries()]
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}

function drawExposureChart(history, currentProfit, options = {}) {
  const canvas = $("exposureChart");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(150, Math.floor(rect.height));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";

  const pad = { top: 16, right: 16, bottom: 24, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const rawPoints = (history || [])
    .filter((point) => Number.isFinite(Number(point.used)) || Number.isFinite(Number(point.openProfit)));
  const allPoints = options.usesReal ? rawPoints : filterDemoHistoryByLane(rawPoints, chartLaneFilter);
  const cutoff = chartRangeMs ? Date.now() - chartRangeMs : -Infinity;
  const rangePoints = allPoints.filter((point) => Date.parse(point.time) >= cutoff);
  const beforeCutoff = chartRangeMs && !options.strictRange
    ? [...allPoints].reverse().find((point) => Date.parse(point.time) < cutoff)
    : null;
  let visiblePoints = rangePoints.length < 2 && beforeCutoff ? [beforeCutoff, ...rangePoints] : rangePoints;
  if (visiblePoints.length === 1) {
    const only = visiblePoints[0];
    const parsedTime = Date.parse(only.time);
    const anchorTime = Number.isFinite(parsedTime) ? parsedTime : Date.now();
    const spanMs = chartRangeMs || 2 * 60 * 1000;
    const endTime = Math.max(Date.now(), anchorTime + 60 * 1000);
    const startTime = Math.min(anchorTime - 60 * 1000, endTime - spanMs);
    visiblePoints = [
      { ...only, time: new Date(startTime).toISOString(), synthetic: true },
      { ...only, time: new Date(endTime).toISOString(), synthetic: true },
    ];
  }
  const displayPointCount = rangePoints.length || visiblePoints.length;
  const points = sampleChartPoints(visiblePoints);
  const profitPoints = points.filter(hasReliableProfitPoint);
  const demoEarnPoints = points
    .map((point, sourceIndex) => ({ point: demoLayerPoint(point, "earn"), sourceIndex }))
    .filter((item) => item.point && hasReliableProfitPoint(item.point));
  const totalCoverage = historyCoverage(allPoints);
  const visibleCoverage = historyCoverage(rangePoints.length ? rangePoints : visiblePoints);
  updateChartRangeButtons(allPoints, options);

  ctx.strokeStyle = "#2b3036";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad.top + (plotH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  if (visiblePoints.length < 2) {
    ctx.fillStyle = "#9aa3ad";
    ctx.font = "13px system-ui";
    const emptyText = chartRangeMs && options.strictRange
      ? `Нет линии за ${periodLabel(chartRangeMs)}: нужно минимум 2 real-точки`
      : (options.emptyText || "Собираю данные графика");
    ctx.fillText(emptyText, pad.left, pad.top + 24);
    const collectingText = totalCoverage.coverageMs > 0
      ? `${displayPointCount} точек · ${chartLaneFilterLabel()} · ${chartFilterLabel()} · ${chartRangeLabel()} · записано только ${shortDuration(totalCoverage.coverageMs)}`
      : `${displayPointCount} точек · ${chartLaneFilterLabel()} · ${chartFilterLabel()} · ${chartRangeLabel()} · ${options.emptyMeta || "собираю"}`;
    setText("exposureMeta", collectingText);
    return;
  }

  const usedMax = Math.max(1, ...points.map((point) => Math.abs(Number(point.used) || 0)));
  const drawUsed = chartFilter === "all" || chartFilter === "invested";
  const drawProfitRequested = chartFilter === "all" || chartFilter === "profit";
  const profitValues = profitPoints
    .map((point) => Number(point.openProfit))
    .filter((value) => Number.isFinite(value));
  const demoEarnProfitValues = demoEarnPoints
    .map((item) => Number(item.point.openProfit))
    .filter((value) => Number.isFinite(value));
  const drawProfit = drawProfitRequested && profitValues.length > 0;
  const fallbackProfit = Number.isFinite(Number(currentProfit)) ? Number(currentProfit) : 0;
  const shouldDrawDemoEarnLine = !options.usesReal && ["all", "earn"].includes(chartLaneFilter) && demoEarnPoints.length > 1;
  const scaleProfitValues = [
    ...(profitValues.length > 0 ? profitValues : [fallbackProfit]),
    ...(shouldDrawDemoEarnLine ? demoEarnProfitValues : []),
  ];
  const profitMin = Math.min(...scaleProfitValues);
  const profitMax = Math.max(...scaleProfitValues);
  const profitRange = Math.max(0, profitMax - profitMin);
  const microProfitFloor = options.microProfitScale ? 0.02 : 1;
  const profitAbs = Math.max(microProfitFloor, ...scaleProfitValues.map((value) => Math.abs(value)));
  const useLocalProfitScale = drawProfit && profitPoints.length > 1 && chartFilter !== "invested" && profitRange > 0 && profitRange < profitAbs * 0.35;
  const xFor = (index) => pad.left + (plotW * index) / Math.max(1, points.length - 1);
  const yUsed = (value) => pad.top + plotH - (Math.max(0, Number(value) || 0) / usedMax) * plotH;
  const zeroProfitY = pad.top + plotH / 2;
  const profitCenterY = chartFilter === "profit" ? pad.top + plotH / 2 : zeroProfitY;
  const profitScale = chartFilter === "profit" ? plotH / 2 - 12 : plotH / 2 - 8;
  const yProfit = (value) => {
    const number = Number(value) || 0;
    if (!useLocalProfitScale) return profitCenterY - (number / profitAbs) * profitScale;
    const mid = (profitMin + profitMax) / 2;
    const localScale = Math.max(0.01, profitRange / 2);
    return profitCenterY - ((number - mid) / localScale) * profitScale;
  };

  if (drawUsed) {
    const usedGradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    usedGradient.addColorStop(0, "rgba(214, 219, 224, 0.35)");
    usedGradient.addColorStop(1, "rgba(214, 219, 224, 0.03)");
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xFor(index);
      const y = yUsed(point.used);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(points.length - 1), pad.top + plotH);
    ctx.lineTo(xFor(0), pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = usedGradient;
    ctx.fill();

    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xFor(index);
      const y = yUsed(point.used);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "rgba(214, 219, 224, 0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (drawProfit) {
    ctx.beginPath();
    ctx.moveTo(pad.left, profitCenterY);
    ctx.lineTo(width - pad.right, profitCenterY);
    ctx.strokeStyle = "#3a4149";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (options.microProfitScale && profitAbs <= 0.05) {
      ctx.fillStyle = "rgba(167, 176, 187, 0.82)";
      ctx.font = "12px system-ui";
      ctx.fillText(`micro P/L scale: ${money(-profitAbs)} ... ${money(profitAbs)}`, pad.left + 4, pad.top + 14);
    } else if (useLocalProfitScale) {
      ctx.fillStyle = "rgba(167, 176, 187, 0.74)";
      ctx.font = "12px system-ui";
      ctx.fillText(`P/L увеличен: ${money(profitMin)} - ${money(profitMax)}`, pad.left + 4, pad.top + 14);
    } else if (profitPoints.length > 1 && profitRange < 0.01) {
      ctx.fillStyle = "rgba(167, 176, 187, 0.74)";
      ctx.font = "12px system-ui";
      ctx.fillText(`P/L почти ровный: ${money(profitValues.at(-1) || currentProfit || 0)}`, pad.left + 4, pad.top + 14);
    }
  } else if (drawProfitRequested) {
    ctx.fillStyle = "rgba(167, 176, 187, 0.74)";
    ctx.font = "12px system-ui";
    ctx.fillText(options.emptyText || "История P/L синхронизируется", pad.left + 4, pad.top + 24);
  }

  function drawProfitPart(color, predicate) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    for (let index = 1; index < profitPoints.length; index += 1) {
      const prev = profitPoints[index - 1];
      const next = profitPoints[index];
      const p0 = Number(prev.openProfit) || 0;
      const p1 = Number(next.openProfit) || 0;
      const x0 = pad.left + (plotW * Math.max(0, points.indexOf(prev))) / Math.max(1, points.length - 1);
      const x1 = pad.left + (plotW * Math.max(0, points.indexOf(next))) / Math.max(1, points.length - 1);
      const y0 = yProfit(p0);
      const y1 = yProfit(p1);

      if (predicate(p0) && predicate(p1)) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      } else if (predicate(p0) !== predicate(p1)) {
        const ratio = Math.abs(p0) / (Math.abs(p0) + Math.abs(p1));
        const zx = x0 + (x1 - x0) * ratio;
        ctx.beginPath();
        ctx.moveTo(predicate(p0) ? x0 : zx, predicate(p0) ? y0 : profitCenterY);
        ctx.lineTo(predicate(p1) ? x1 : zx, predicate(p1) ? y1 : profitCenterY);
        ctx.stroke();
      }
    }
  }

  function drawDemoEarnLine() {
    if (!shouldDrawDemoEarnLine) return;
    ctx.save();
    ctx.strokeStyle = "#65a7e8";
    ctx.lineWidth = chartLaneFilter === "earn" ? 3.5 : 2.75;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (chartLaneFilter === "all") ctx.setLineDash([7, 5]);
    ctx.beginPath();
    demoEarnPoints.forEach((item, index) => {
      const x = xFor(item.sourceIndex);
      const y = yProfit(Number(item.point.openProfit) || 0);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const lastEarn = demoEarnPoints.at(-1);
    if (lastEarn) {
      const profit = Number(lastEarn.point.openProfit) || 0;
      const x = xFor(lastEarn.sourceIndex);
      const y = yProfit(profit);
      ctx.fillStyle = "#9ed0ff";
      ctx.font = "12px system-ui";
      ctx.fillText(`Demo Earn ${money(profit)}`, Math.min(width - pad.right - 130, x + 8), y + 16);
    }
    ctx.restore();
  }

  if (drawProfit) {
    drawProfitPart("#5fc46a", (value) => value >= 0);
    drawProfitPart("#f0605f", (value) => value < 0);
    drawDemoEarnLine();
    const lastProfitPoint = profitPoints.at(-1);
    if (lastProfitPoint) {
      const index = Math.max(0, points.indexOf(lastProfitPoint));
      const profit = Number(lastProfitPoint.openProfit) || 0;
      const x = xFor(index);
      const y = yProfit(profit);
      ctx.fillStyle = profit >= 0 ? "#9be79f" : "#ff9b9b";
      ctx.font = "12px system-ui";
      ctx.fillText(`${options.profitNowLabel || "сейчас"} ${money(profit)}`, Math.min(width - pad.right - 110, x + 8), y - 8);
    }
  }

  ctx.fillStyle = "#9aa3ad";
  ctx.font = "12px system-ui";
  if (drawUsed) {
    ctx.fillText(`$${usedMax.toFixed(0)}`, 6, pad.top + 4);
    ctx.fillText("$0", 16, pad.top + plotH + 4);
  }
  if (drawProfit) {
    ctx.fillText(`+/-$${profitAbs.toFixed(2)}`, 6, profitCenterY - 6);
    if (visiblePoints.length < 4) {
      ctx.fillStyle = "rgba(167, 176, 187, 0.82)";
      ctx.font = "12px system-ui";
      ctx.fillText("real-проба видна; история ещё короткая", pad.left + 4, pad.top + 30);
    }
  }
  const requestedRangeMs = chartRangeMs || totalCoverage.coverageMs;
  const coverageSuffix = chartRangeMs && requestedRangeMs > 0 && visibleCoverage.coverageMs + 60 * 1000 < requestedRangeMs
    ? ` · записано только ${shortDuration(visibleCoverage.coverageMs)} из ${periodLabel(requestedRangeMs)}`
    : totalCoverage.coverageMs > 0
      ? ` · видно ${shortDuration(visibleCoverage.coverageMs)}`
      : "";
  const sampleSuffix = points.length !== visiblePoints.length ? ` · рисую ${points.length}` : "";
  setText("exposureMeta", `${displayPointCount} точек${sampleSuffix} · ${chartLaneFilterLabel()} · ${chartFilterLabel()} · ${chartRangeLabel()}${coverageSuffix}`);
}

function latestDecision(state, predicate) {
  return [...(state.scanner.decisions || [])]
    .sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0))
    .find(predicate);
}

function countFreshDecisions(state, action) {
  const cutoff = Date.now() - 2 * 60 * 1000;
  return (state.scanner.decisions || []).filter((item) => item.type === "decision" && item.payload?.action === action && Date.parse(item.time) >= cutoff).length;
}

function relativeAge(value) {
  const parsed = Date.parse(value || 0);
  if (!Number.isFinite(parsed)) return "время неизвестно";
  const delta = Math.max(0, Date.now() - parsed);
  if (delta < 60 * 1000) return `${fmtTime(value)} только что`;
  return `${fmtTime(value)} (${shortDuration(delta)} назад)`;
}

function latestRobotEvent(state) {
  return latestDecision(state, (item) => (
    item.type === "demo_trade_opened" ||
    item.type === "demo_pending_order_opened" ||
    item.type === "demo_trade_failed" ||
    item.type === "demo_pending_order_failed" ||
    item.type === "closed_trade_review" ||
    item.type === "open_trade_review" ||
    item.type === "robot_health_recovery" ||
    item.type === "robot_health_changed" ||
    item.type === "advisor_unavailable" ||
    item.type === "advisor_decision_failed" ||
    item.type === "decision"
  ));
}

function robotEventSentence(event) {
  if (!event) return "Свежего события в ленте пока нет.";
  const payload = event.payload || {};
  const when = relativeAge(event.time);
  const instrument = payload.instrument || payload.selectedInstrument || "terminal";
  if (event.type === "demo_trade_opened") {
    return `${when}: открыт market ${payload.side || ""} ${instrument} на $${payload.amount || payload.sumInv || "?"} x${payload.multiplier || "?"}; причина: ${payload.reason || "demo probe"}.`;
  }
  if (event.type === "real_calibration_trade_opened") {
    return `${when}: открыт real calibration ${payload.side || ""} ${instrument} на $${payload.amount || payload.sumInv || "?"} x${payload.multiplier || "?"}; теперь главное - проверить close-channel и фактические издержки.`;
  }
  if (event.type === "demo_pending_order_opened") {
    return `${when}: выставлена отложенная заявка ${payload.side || ""} ${instrument} на $${payload.amount || "?"} x${payload.multiplier || "?"}; цель - собрать статистику пробоя без угадывания стороны.`;
  }
  if (event.type === "demo_trade_failed" || event.type === "demo_pending_order_failed") {
    return `${when}: попытка по ${instrument} не прошла (${payload.message || payload.reason || "execution failed"}); следующий вход требует повторной проверки формы и выбранного инструмента.`;
  }
  if (event.type === "closed_trade_review") {
    return `${when}: разобрана закрытая сделка ${instrument} ${payload.profitText || ""}; урок: ${payload.nextRule || payload.summary || payload.reason || "обновляю когорту"}.`;
  }
  if (event.type === "open_trade_review") {
    const action = actionInfo(payload.action);
    return `${when}: проверена открытая сделка ${instrument} ${payload.profitText || ""}; действие: ${action?.label || payload.reason || "наблюдение"}.`;
  }
  if (event.type === "robot_health_recovery") {
    return `${when}: шаг восстановления ${payload.step || "recovery"} после состояния ${healthInfo(payload.healthState)?.label || payload.healthState || "сбой"}; цель - вернуть цикл открытия, закрытия и разбора сделок.`;
  }
  if (event.type === "robot_health_changed") {
    return `${when}: состояние ${healthInfo(payload.state)?.label || "изменилось"} из-за ${payload.reason || "причина не указана"}; событий за 5м ${payload.eventsLast5m ?? "?"}.`;
  }
  if (event.type === "decision") {
    const action = actionInfo(payload.action);
    return `${when}: решение ${action?.label || "сканирование"} по ${instrument}; ${decisionEventDetail(event, payload.reason || payload.message || "") || payload.reason || "сканирую"}.`;
  }
  return `${when}: ${eventTitle(event)} - ${eventDetail(event) || "обновление состояния"}.`;
}

function robotLoadLine(state) {
  const exposureOpenCount = Number(state.terminal.usedValue || 0) > 0.01 || Math.abs(Number(state.terminal.profitValue || 0)) > 0.01
    ? 1
    : 0;
  const openCount = Math.max(
    Number(state.terminal.activeTradesCount || 0) || 0,
    Array.isArray(state.terminal.activeTrades) ? state.terminal.activeTrades.length : 0,
    exposureOpenCount,
  );
  const pendingCount = state.terminal.pendingTradesCount ?? "?";
  const closedCount = state.terminal.closedTrades24hCount ?? 0;
  const closeCandidates = (state.terminal.openTradeReviews || []).filter((item) => {
    const action = String(item.action || item.payload?.action || "");
    return /close|cut|ttl|take_profit|stop|stale|risk/i.test(action);
  }).length;
  const events = state.health?.eventsLast5m ?? 0;
  const open = state.terminal.profit || money(state.performance.openProfit || 0);
  const used = state.terminal.used || money(state.performance.usedFunds || 0);
  return `Сейчас: открыто ${openCount}, отложенных заявок ${pendingCount}, кандидатов на закрытие ${closeCandidates}, закрыто за 24ч ${closedCount}, P/L ${open}, занято ${used}, исполнений за 5м ${events}.`;
}

function silentStatusLine(state) {
  const silentMinutes = Number(state.health?.silentMinutes || 0);
  const source = String(state.health?.silentSinceSource || "");
  if (silentMinutes <= 0) return "без заметной паузы";
  const base = humanSilentDuration(silentMinutes);
  if (source === "process_start" || source === "process_restart") {
    return `${base} с текущего перезапуска`;
  }
  return `${base} с последнего подтверждённого открытия или закрытия`;
}

function buildRobotSummary(state) {
  if (currentDashboardView(state) === "real") {
    const summary = realLaneSummary(state);
    const status = realLaneStatus(state).toLowerCase();
    const balance = configuredRealBalanceText(state);
    const realTerminal = state.realTerminal || {};
    const explanation = realLaneWhyNow(state);
    const statusText = modeLabel(status);
    if (!summary.totalTrades) {
      return `Earn: ${statusText}, real-счёт ${modeLabel(realTerminal.accountGuard) || "не подтверждён"}, баланс ${balance}. ${explanation}`;
    }
    return `Earn: ${statusText}; real-сделок ${summary.totalTrades}, открыто ${summary.openTrades}, закрыто ${summary.closedTrades}, итог ${money(summary.netProfitUsd)}, открытый P/L ${money(summary.openProfitUsd)}. ${explanation}`;
  }
  if (state.killSwitch || !state.scannerRunning) {
    return "Остановлен: новые сделки не открываю. Можно безопасно смотреть открытые позиции и историю, пока Start снова не включит сканер.";
  }
  const loadLine = robotLoadLine(state);
  const latestLine = robotEventSentence(latestRobotEvent(state));
  const candidates = countFreshDecisions(state, "CANDIDATE");
  const skipped = countFreshDecisions(state, "SKIP");
  const freshLine = `Свежие scan-сигналы за 2m: candidates ${candidates}, skips ${skipped}.`;
  if (state.health?.state === "STALLED") {
    const silent = silentStatusLine(state);
    const latestSkip = latestDecision(state, (item) => item.type === "demo_experiment_skipped" || item.type === "demo_experiment_rejected");
    const diagnostics = state.scanner?.selectionDiagnostics || {};
    const selected = diagnostics.selected || diagnostics.topRanked?.[0]?.name || state.terminal?.selectedInstrument || "";
    const blocker = latestSkip?.payload?.reason || latestSkip?.payload?.cooldownReason || state.health?.reason || "нет подтверждённого исполнения";
    const nextAt = latestSkip?.payload?.cooldownSummary?.nextAvailableAt || diagnostics.visibility?.cooldownSummary?.nextAvailableAt || "";
    const nextText = nextAt ? ` Ближайшая следующая попытка после ${fmtTime(nextAt)}.` : "";
    const selectedText = selected ? ` Следующий фокус: ${selected}.` : "";
    return `Застрял: ${silent} при живом сканере. Блокер: ${blocker}.${selectedText}${nextText} ${loadLine} ${latestLine} Нужно не ждать молча: либо открыть следующий demo-earn сетап, либо закрыть/разобрать текущую сделку.`;
  }
  if (state.health?.state === "CLOSE_JAM") {
    return `Закрытия застряли: контур закрытия не разгружает кандидатов достаточно быстро. ${loadLine} ${latestLine} Приоритет - закрыть или сверить активные сделки; новые входы только если не ухудшают очередь.`;
  }
  if (state.health?.state === "LOGIN_REQUIRED") {
    return `Нужен логин в Libertex: ${state.health?.reason || "сессия разлогинена"}. Для ручного входа через noVNC сначала поставь scanner на паузу, иначе капча и форма могут сбрасываться. Real-сессия проверяется отдельно и не должна смешиваться с demo.`;
  }
  if (state.health?.state === "DEGRADED_DATA") {
    return `Данные неполные: терминал даёт неполную картину (${state.health?.reason || "причина не указана"}). ${loadLine} ${latestLine} Новые входы придерживаются до нормального обзора инструментов и позиций.`;
  }
  if (state.health?.state === "THROTTLED") {
    return `Темп снижен: нагрузка или риск выше нормы (${state.health?.reason || "причина не указана"}), но робот должен продолжать измеримо работать. ${loadLine} ${latestLine} ${freshLine}`;
  }
  if (!state.cdp.connected) {
    return `Не вижу терминал Libertex: ${state.cdp.error || "жду подключение Chrome"}. Сделки не открываются, пока нет живых данных.`;
  }
  if (state.terminal.accountType === "demo") {
    const open = state.terminal.profit || "$0.00";
    const used = state.terminal.used || "$0.00";
    const selected = state.terminal.selectedInstrument || "текущий инструмент";
    const openCount = state.terminal.activeTradesCount ?? "?";
    const pendingCount = state.terminal.pendingTradesCount ?? "?";
    const closedCount = state.terminal.closedTrades24hCount ?? 0;
    const latestExecution = latestDecision(state, (item) => (
      item.type === "demo_trade_opened" ||
      item.type === "demo_pending_order_opened" ||
      (item.type && item.type.includes("failed"))
    ));
    const adjustment = (state.learning.strategyAdjustments || [])[0];
    const activeNews = (state.news?.active || [])[0] || null;
    const nextNewsRaw = (state.news?.upcoming || [])[0] || null;
    const nextNews = nextNewsRaw && Date.parse(nextNewsRaw.time || 0) - Date.now() <= 60 * 60 * 1000 ? nextNewsRaw : null;

    if (activeNews) {
      return `Идёт новостное окно: ${activeNews.impact || "medium"} ${activeNews.currency || activeNews.country || ""} ${activeNews.title}. Обычное угадывание направления ниже приоритетом; если инструмент затронут событием, робот предпочитает отложенную BUY/SELL-вилку с отдельным TP/SL профилем. Открыто: ${openCount}, отложенных заявок: ${pendingCount}, P/L ${open}.`;
    }
    if (nextNews) {
      return `Ближайшее событие: ${fmtTime(nextNews.time)} ${nextNews.currency || nextNews.country || ""} ${nextNews.title}. До окна новости торгую обычные сетапы, а затронутые инструменты будут помечены как новостной риск. Открыто: ${openCount}, отложенных заявок: ${pendingCount}, P/L ${open}.`;
    }

    if (latestExecution?.type?.includes("failed")) {
      return `Последнее действие не прошло: ${latestExecution.payload?.message || latestExecution.payload?.reason || "ошибка исполнения"}. Продолжаю читать демо-счет, но перед новым входом перепроверяю форму, TP/SL и выбранный инструмент.`;
    }
    if (latestExecution?.type === "demo_trade_opened") {
      return `Недавно открыл ${latestExecution.payload?.side || "сделку"} по ${latestExecution.payload?.instrument || selected}: $${latestExecution.payload?.sumInv || latestExecution.payload?.amount || "20"} x${latestExecution.payload?.multiplier || latestExecution.payload?.result?.values?.multiplier || "5"} с TP/SL. Открыто: ${openCount}, отложенных заявок: ${pendingCount}, закрыто за 24ч: ${closedCount}. Сейчас P/L ${open}, использовано ${used}.`;
    }
    if (latestExecution?.type === "demo_pending_order_opened") {
      return `Недавно выставил отложенную заявку ${latestExecution.payload?.side || ""} по ${latestExecution.payload?.instrument || selected}: $${latestExecution.payload?.amount || "20"} x${latestExecution.payload?.multiplier || "5"} с TP/SL. Это отдельная схема на пробой, не замена обычным рыночным входам. Открыто: ${openCount}, отложенных заявок: ${pendingCount}, P/L ${open}.`;
    }
    if (adjustment) {
      return `Сканирую демо и применяю урок: ${adjustment.description} Сейчас смотрю ${selected}; свежих кандидатов ${candidates}, низкоприоритетных пропусков ${skipped}, открытый P/L ${open}.`;
    }
    if (candidates > 0) {
      return `Сканирую демо: за последние минуты есть ${candidates} кандидатов. Проверяю, не опоздал ли вход, есть ли место для TP/SL и не слишком ли широкий спред; открытый P/L ${open}, использовано ${used}.`;
    }
    return `Сканирую демо без нового входа: сейчас фокус на ${selected}, свежих сильных кандидатов нет. Открытый P/L ${open}, использовано ${used}; продолжаю копить точки для правил.`;
  }
  if (state.terminal.accountType === "real") {
    return "Виден real account. Читаю экран, но новые сделки не исполняю: для тестов нужен demo-confirmed.";
  }
  return "Жду терминал Libertex и подтверждение счета.";
}

function renderAdvisor(state) {
  const advisor = state.advisor || {};
  const policy = advisor.policy || {};
  const status = advisor.status || (advisor.enabled ? "waiting" : "disabled");
  const pill = $("advisorPill");
  if (!pill) return;
  const advisorDisplayStatus = status === "offline_fail_open" ? "cached policy" : status;
  pill.textContent = advisorDisplayStatus;
  pill.classList.toggle("online", ["applied", "noop", "waiting"].includes(status) && advisor.enabled);
  pill.classList.toggle("locked", !advisor.enabled || status === "disabled");
  pill.classList.toggle("danger", (/error|failed|rejected|alert|rate_limited|hold/i.test(status)) && !/offline_fail_open/i.test(status));
  setText("advisorStatus", `${advisorDisplayStatus}${advisor.lastRunAt ? ` · last ${fmtTime(advisor.lastRunAt)}` : ""}${advisor.nextRunAt ? ` · next ${fmtTime(advisor.nextRunAt)}` : ""}`);
  const modelText = advisor.cheapModel || advisor.strongModel
    ? `cheap ${advisor.cheapModel || "provider-default"} / strong ${advisor.strongModel || "provider-default"}`
    : advisor.model || "env-default";
  setText("advisorProvider", `${advisor.provider || "disabled"} · ${modelText} · ${Math.round((advisor.cadenceMs || 0) / 60000) || "-"}m`);
  setText("advisorPatches", `${advisor.appliedPatches || 0} applied · ${advisor.rejectedPatches || 0} rejected`);
  const knobs = [
    policy.global?.min_experiment_interval_ms ? `cadence ${Math.round(policy.global.min_experiment_interval_ms / 1000)}s` : null,
    policy.global?.stagnation_ttl_min ? `TTL ${policy.global.stagnation_ttl_min}m` : null,
    policy.global?.max_open_demo_trades ? `max ${policy.global.max_open_demo_trades}` : null,
    policy.global?.investigate_used_funds_cap_usd ? `investigate cap ${money(policy.global.investigate_used_funds_cap_usd)}` : null,
    policy.experiments?.auto_open === false ? "auto open off" : "auto open on",
    policy.experiments?.pending_brackets === false ? "pending off" : "pending on",
  ].filter(Boolean).join(" · ");
  setText("advisorKnobs", knobs || "default policy");
  const decision = advisor.lastDecision;
  const trigger = advisor.lastTriggerReason && advisor.lastTriggerReason !== "periodic"
    ? ` Last emergency trigger: ${advisor.lastTriggerReason}${advisor.lastEmergencyRunAt ? ` at ${fmtTime(advisor.lastEmergencyRunAt)}` : ""}.`
    : "";
  const summary = advisor.lastError
    ? `LLM-советник временно недоступен (${advisor.lastError}). Робот не остановлен: работает по последней сохранённой политике.${trigger}`
    : decision?.reasoning
      ? `${decision.reasoning} Accepted ${decision.accepted || 0}, rejected ${decision.rejected || 0}.${trigger}`
      : advisor.enabled
        ? `Advisor is enabled and waits for the next compact digest.${trigger}`
        : "Advisor is disabled. Robot continues on deterministic policy. Enable with LLM_ADVISOR_ENABLED=true plus provider API key or webhook.";
  setText("advisorSummary", summary);
  setText("mobileAdvisorMeta", `${status} · ${advisor.appliedPatches || 0}/${advisor.rejectedPatches || 0}`);
}

function portalTone(value) {
  const text = String(value || "").toUpperCase();
  if (/HEALTHY|LIVE|RUNNING|COMPLETED|GREEN|ONLINE/.test(text)) return "green";
  if (/WAITING|READY|YELLOW|ADMITTED|QUEUED|PLANNED/.test(text)) return "yellow";
  if (/BLOCKED|ORANGE|STALE|ATTENTION/.test(text)) return "orange";
  if (/INCIDENT|RED|ERROR|UNAVAILABLE|OFFLINE|JAM/.test(text)) return "red";
  return "neutral";
}

function portalEta(hours) {
  if (hours === null || hours === undefined || Number.isNaN(Number(hours))) return "unknown";
  if (Number(hours) === 0) return "now";
  return Number(hours) < 24 ? `${Number(hours).toFixed(1)}h` : `${(Number(hours) / 24).toFixed(1)}d`;
}

function portalDate(value) {
  if (!value) return "unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(parsed);
}

function setPortalCardTone(id, tone) {
  const element = $(id);
  if (!element) return;
  element.classList.remove("tone-green", "tone-yellow", "tone-orange", "tone-red", "tone-neutral");
  element.classList.add(`tone-${portalTone(tone)}`);
}

function renderPortalNavigation() {
  const navigation = $("portalNavigation");
  if (!navigation) return;
  const pages = PORTAL_PAGES.filter((page) => page.visible).sort((a, b) => a.order - b.order);
  navigation.innerHTML = pages.map((page) => `<button type="button" data-portal-nav="${escapeHtml(page.id)}"><span aria-hidden="true">${escapeHtml(page.icon)}</span><strong>${escapeHtml(page.label)}</strong></button>`).join("");
  navigation.querySelectorAll("[data-portal-nav]").forEach((button) => button.addEventListener("click", () => setPortalPage(button.dataset.portalNav)));
}

function setPortalPage(pageId, { updateHash = true } = {}) {
  const previousPage = activePortalPage;
  const page = PORTAL_PAGES.find((row) => row.id === pageId && row.visible) || PORTAL_PAGES[0];
  activePortalPage = page.id;
  document.querySelectorAll("[data-portal-view]").forEach((view) => {
    const active = view.dataset.portalView === page.id;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-portal-nav]").forEach((button) => button.classList.toggle("active", button.dataset.portalNav === page.id));
  document.title = `${page.label} · Institute Portal`;
  if (updateHash && window.location.hash !== `#${page.id}`) history.replaceState(null, "", `#${page.id}`);
  closePortalDrawer();
  window.scrollTo({ left: 0, top: 0, behavior: "auto" });
  if (page.id === "dashboard" && previousPage !== "dashboard" && currentState) {
    render(currentState);
  }
}

function openPortalDrawer() {
  document.body.classList.add("portal-drawer-open");
  $("portalDrawerBackdrop")?.removeAttribute("hidden");
  $("portalMenuToggle")?.setAttribute("aria-expanded", "true");
}

function closePortalDrawer() {
  document.body.classList.remove("portal-drawer-open");
  $("portalDrawerBackdrop")?.setAttribute("hidden", "");
  $("portalMenuToggle")?.setAttribute("aria-expanded", "false");
}

function initializePortalShell() {
  renderPortalNavigation();
  const requested = window.location.hash.replace(/^#/, "");
  setPortalPage(PORTAL_PAGES.some((page) => page.id === requested && page.visible) ? requested : "dashboard", { updateHash: false });
  $("portalMenuToggle")?.addEventListener("click", () => document.body.classList.contains("portal-drawer-open") ? closePortalDrawer() : openPortalDrawer());
  $("portalDrawerBackdrop")?.addEventListener("click", closePortalDrawer);
  document.querySelectorAll("[data-portal-target]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    setPortalPage(link.dataset.portalTarget);
  }));
  window.addEventListener("hashchange", () => setPortalPage(window.location.hash.replace(/^#/, ""), { updateHash: false }));
  const filters = ["ACTIVE", "BLOCKED", "COMPLETED"];
  if ($("contourFilters")) {
    $("contourFilters").innerHTML = filters.map((filter) => `<button type="button" data-contour-filter="${filter}" class="${filter === researchContourFilter ? "active" : ""}">${filter}</button>`).join("");
    $("contourFilters").querySelectorAll("[data-contour-filter]").forEach((button) => button.addEventListener("click", () => {
      researchContourFilter = button.dataset.contourFilter;
      $("contourFilters").querySelectorAll("[data-contour-filter]").forEach((row) => row.classList.toggle("active", row === button));
      renderResearchContours(currentState?.instituteOperations);
    }));
  }
}

function renderInstitutePortal(state) {
  const operations = state?.instituteOperations || { status: "UNAVAILABLE" };
  const live = operations.status === "LIVE";
  setText("portalStateLabel", operations.status || "UNAVAILABLE");
  setText("portalStateMeta", operations.state_revision ? `revision ${operations.state_revision} · ${portalDate(operations.generated_at)}` : "canonical state unavailable");
  $("portalLiveDot")?.classList.toggle("offline", !live);
  renderPortalOverview(state, operations);
  renderResearchPortal(operations);
  renderHandoffPortal(operations);
  renderCouncilPortal(state?.instituteCouncil, operations);
}

function renderIncomingState(state) {
  if (activePortalPage === "dashboard") {
    render(state);
    return;
  }
  currentState = state;
  lastRenderAt = Date.now();
  renderInstitutePortal(state);
}

function renderPortalOverview(state, operations) {
  const health = operations.pipeline_health || {};
  const capacity = operations.preparation_capacity || { limit: 0, slots: [] };
  const occupied = (capacity.slots || []).filter((slot) => slot.contour_id).length;
  const capital = operations.capital_pipeline || {};
  const incidents = operations.open_incidents || [];
  const owner = operations.owner_attention || [];
  const execution = executionState(state);
  const tradingHealth = execution.online ? "ONLINE" : state?.health?.state || "OFFLINE";
  const cards = [
    { label: "System Health", value: operations.status || "UNAVAILABLE", detail: operations.error || `state revision ${operations.state_revision || "—"}` },
    { label: "Research Health", value: health.level || "UNKNOWN", detail: health.pressure || "No pipeline forecast" },
    { label: "Trading Health", value: tradingHealth, detail: execution.current || "No execution provider" },
    { label: "Capital Health", value: capital.idle === false ? "CONNECTED" : capital.blocking_gate ? "WAITING" : "UNKNOWN", detail: capital.blocking_gate || "No capital candidate" },
    { label: "Owner Attention", value: owner.length ? `${owner.length} REQUIRED` : "CLEAR", detail: owner[0]?.what || "No genuine owner decision required" },
  ];
  if ($("portalHealthGrid")) $("portalHealthGrid").innerHTML = cards.map((card) => `<article class="portal-health-card tone-${portalTone(card.value)}"><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(card.value)}</strong><small>${escapeHtml(compactText(card.detail, 100))}</small></article>`).join("");
  setText("portalOverviewFreshness", operations.status === "LIVE" ? `live · revision ${operations.state_revision}` : operations.status || "unavailable");
  setText("portalCapacityValue", `${occupied}/${capacity.limit || (capacity.slots || []).length}`);
  setText("portalCapacityMeta", occupied ? "preparation slots occupied" : (capacity.slots?.[0]?.idle_reason || "no active preparation"));
  setPortalCardTone("portalCapacityCard", occupied ? "RUNNING" : health.level);
  setText("portalPressureValue", health.level || "UNKNOWN");
  setText("portalPressureMeta", `starvation ${portalEta(health.starvation_eta_hours)}`);
  setPortalCardTone("portalPressureCard", health.level);
  setText("portalCapitalValue", capital.nearest_candidate || "No candidate");
  setText("portalCapitalMeta", capital.blocking_gate || "No blocking gate");
  setPortalCardTone("portalCapitalCard", capital.blocking_gate ? "WAITING" : "GREEN");
  setText("portalOwnerValue", owner.length ? owner.length : "Clear");
  setText("portalOwnerMeta", owner[0]?.why || "No protected decision pending");
  setPortalCardTone("portalOwnerCard", owner.length ? "ATTENTION" : "GREEN");
  setText("portalIncidentCount", incidents.length);
  if ($("portalTopIncidents")) $("portalTopIncidents").innerHTML = incidents.slice(0, 4).map((row) => `<li><strong>${escapeHtml(row.code)}</strong><span>${escapeHtml(row.contour_id)} · ${escapeHtml(compactText(row.detail, 110))}</span></li>`).join("") || `<li class="portal-empty">No open incidents.</li>`;
  const actions = operations.automatic_next_actions || [];
  setText("portalActionCount", actions.length);
  if ($("portalTopActions")) $("portalTopActions").innerHTML = actions.slice(0, 4).map((row) => `<li><strong>${escapeHtml(row.action)}</strong><span>${escapeHtml(row.target_contour_id)} · ETA ${escapeHtml(portalEta(row.eta_hours))}</span></li>`).join("") || `<li class="portal-empty">No autonomous action is currently admissible.</li>`;
}

function renderResearchPortal(operations) {
  setText("researchFreshness", operations.status === "LIVE" ? `live · revision ${operations.state_revision}` : operations.status || "unavailable");
  renderOperationalResearch(operations);
  const stages = operations.institute_progress || [];
  setText("instituteProgressMeta", `${stages.length} canonical stages`);
  if ($("instituteProgress")) $("instituteProgress").innerHTML = stages.map((stage) => `<article class="institute-stage tone-${portalTone(stage.status)}"><div><span>${escapeHtml(stage.name)}</span><strong>${escapeHtml(stage.status)}</strong></div><div class="institute-stage-bar"><i style="width:${Math.max(0, Math.min(100, Number(stage.progress || 0)))}%"></i></div><dl><div><dt>Progress</dt><dd>${escapeHtml(stage.progress)}%</dd></div><div><dt>ETA</dt><dd>${escapeHtml(stage.eta || "—")}</dd></div></dl><p>${escapeHtml(stage.next_milestone || "—")}</p></article>`).join("") || `<div class="portal-empty">Institute progress unavailable.</div>`;
  const pipeline = operations.pipeline_health || {};
  setText("researchPipelinePressure", `${pipeline.level || "UNKNOWN"} · starvation ${portalEta(pipeline.starvation_eta_hours)}`);
  const names = ["Planned", "Ready", "Queued", "Admitted", "Running", "Blocked", "Completed"];
  if ($("researchPipelineCounts")) $("researchPipelineCounts").innerHTML = names.map((name) => renderPipelineAggregate(name, operations)).join("");
  const capacity = operations.preparation_capacity || { limit: 0, slots: [] };
  const occupied = (capacity.slots || []).filter((slot) => slot.contour_id).length;
  setText("researchCapacityMeta", `${occupied}/${capacity.limit || capacity.slots?.length || 0} occupied`);
  if ($("researchCapacitySlots")) $("researchCapacitySlots").innerHTML = (capacity.slots || []).map((slot) => `<div class="${slot.contour_id ? "used" : "free"}" title="${escapeHtml(slot.contour_id || slot.idle_reason || "free")}"><span>${escapeHtml(slot.slot_id)}</span><small>${escapeHtml(slot.contour_id || slot.idle_reason || "free")}</small></div>`).join("");
  const idleReasons = (capacity.slots || []).filter((slot) => !slot.contour_id).map((slot) => `${slot.slot_id}: ${slot.idle_reason || "UNEXPLAINED"}`);
  setText("researchCapacityReason", idleReasons.length ? idleReasons.join(" · ") : "All preparation slots are occupied by admitted work.");
  const capital = operations.capital_pipeline || {};
  const capitalItem = capital.items?.[0] || {};
  setText("researchCapitalCandidate", capital.nearest_candidate || "No candidate");
  setText("researchCapitalGate", capital.blocking_gate || "NO_BLOCKING_GATE");
  if ($("researchCapitalFacts")) $("researchCapitalFacts").innerHTML = [
    ["N", `${capitalItem.current_n ?? "?"} / ${capitalItem.required_n ?? "?"}`],
    ["Next artifact", capitalItem.next_required_artifact || "unknown"],
    ["ETA verdict", capital.eta_to_verdict_days == null ? "unknown" : `${capital.eta_to_verdict_days}d`],
    ["ETA capital", capital.eta_to_capital_connection_days == null ? "unknown" : `${capital.eta_to_capital_connection_days}d`],
  ].map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  renderCriticalPath(operations.money_verdict_critical_path || {}, operations.source_recovery || {});
  renderParallelResearchInventory(operations.parallel_research_inventory || {});
  renderResidentOperator(operations.resident_operator || {});
  renderReasoningGovernor(operations.reasoning_governor || {});
  renderFireMonitor(operations.fire_monitor || {});
  renderBlockedGraph(operations.contours || []);
  renderAutonomousActions(operations.autonomous_actions || []);
  renderOwnerAttention(operations.owner_attention || []);
  renderResearchContours(operations);
}

function renderOperationalResearch(operations) {
  const view = operations.operational_processes || {};
  const summary = view.summary || {};
  setText("researchSummaryNow", summary.now || "Operational state unavailable");
  setText("researchSummaryResident", summary.resident || "Resident unavailable");
  setText("researchSummaryBlocker", summary.blocker || "No critical path");
  setText("researchSummaryNext", summary.next_result || "No result scheduled");

  const active = [...(view.now || []), ...(view.starting || [])];
  setText("researchNowCount", active.length ? "RUNNING" : "NO ACTIVE PROCESS");
  if ($("researchNowList")) $("researchNowList").innerHTML = renderPrimaryProcessList(
    active,
    "running objects",
    `<div class="research-honest-empty"><strong>No research process is executing</strong><span>${escapeHtml(operations.pipeline_health?.pressure || "No admitted work.")}</span></div>`,
  );

  const blocker = view.critical_blocker || {};
  setText("researchBlockerStatus", blocker.status || "UNKNOWN");
  setText("researchBlockerTitle", blocker.candidate || "No Money Verdict candidate");
  setText("researchBlockerReason", blocker.reason || "No formal blocking reason");
  setText("researchBlockerWaitingFor", blocker.waiting_for ? `Waiting for: ${blocker.waiting_for}` : "No unblock trigger registered");
  setText("researchBlockerDetail", blocker.detail || `Source recovery: ${blocker.source_status || "unknown"}`);
  const waiting = view.waiting || [];
  setText("researchWaitingSummary", waiting.length > 1 ? `${waiting[0]?.name || "Primary blocker"} (+${waiting.length - 1})` : waiting[0]?.name || "No waiting objects");
  if ($("researchWaitingList")) $("researchWaitingList").innerHTML = waiting.map((row) => `<article><div><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.status)}</span></div><p>${escapeHtml(row.reason)}</p><small>Waiting for: ${escapeHtml(compactText(row.waiting_for, 180))}</small></article>`).join("") || `<div class="portal-empty positive">No waiting contours.</div>`;

  const next = view.next || [];
  setText("researchNextCount", next.length ? "ADMITTED" : "NO ADMITTED PROCESS");
  if ($("researchNextList")) $("researchNextList").innerHTML = renderPrimaryProcessList(
    next,
    "admitted objects",
    `<div class="research-honest-empty"><strong>No next action is admitted</strong><span>${escapeHtml(blocker.waiting_for || "The Control Plane will refill a slot when a formally admissible action appears.")}</span></div>`,
  );

  if ($("researchOperationalFlow")) $("researchOperationalFlow").innerHTML = (view.pipeline_flow || []).map((row, index, rows) => {
    const items = operationalFlowItems(row.id, operations, view);
    const primary = items[0]?.name || operationalFlowEmptyLabel(row.id);
    const remainder = Math.max(0, items.length - 1);
    const disclosure = items.length
      ? `<details class="research-flow-step tone-${escapeHtml(row.tone || "neutral")}"><summary><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(primary)}</strong>${remainder ? `<em>(+${remainder})</em>` : ""}</summary><div class="research-flow-items">${items.map((item) => `<article><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.status || item.reason || "")}</small></article>`).join("")}</div></details>`
      : `<div class="research-flow-step tone-${escapeHtml(row.tone || "neutral")} empty"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(primary)}</strong></div>`;
    return `${disclosure}${index < rows.length - 1 ? `<span class="research-flow-arrow" aria-hidden="true">→</span>` : ""}`;
  }).join("");
  const capacity = operations.preparation_capacity || { limit: 0, slots: [] };
  const occupied = (capacity.slots || []).filter((slot) => slot.contour_id).length;
  setText("researchFlowNote", `${operations.pipeline_health?.pressure || "No pressure forecast."} Preparation capacity ${occupied}/${capacity.limit || capacity.slots?.length || 0}.`);

  const background = operations.background_processes || [];
  setText("researchBackgroundMeta", background.length ? "ALL LIVE SERVICES VISIBLE" : "No service telemetry");
  if ($("researchBackgroundProcesses")) $("researchBackgroundProcesses").innerHTML = background.map((row) => `<article class="${row.status === "ONLINE" ? "online" : "offline"}"><span class="background-light" aria-hidden="true"></span><div><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.cadence)}</small></div><p>${escapeHtml(row.updated_at ? `updated ${portalRelativeTime(row.updated_at)}` : row.detail)}</p><details><summary>Details</summary><span>${escapeHtml(row.detail)} · ${escapeHtml(row.active_state || "unknown")}/${escapeHtml(row.sub_state || "unknown")}</span></details></article>`).join("") || `<div class="research-honest-empty"><strong>Background telemetry unavailable</strong><span>System service probes have not completed.</span></div>`;

  renderResearchPrograms(operations.research_programs || []);
  renderResearchDimensionalityIntegrity(operations.attack_on_assumptions || {});

  const foundation = view.foundation || [];
  setText("researchFoundationCount", foundation[0]?.name ? `${foundation[0].name}${foundation.length > 1 ? ` (+${foundation.length - 1})` : ""}` : "No completed work");
  if ($("researchFoundation")) $("researchFoundation").innerHTML = foundation.map((row) => `<article><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(portalDate(row.completed_at))}</span><small>${escapeHtml(row.artifact || row.id)}</small></article>`).join("") || `<div class="portal-empty">No completed contours registered.</div>`;
}

function renderResearchPrograms(programs) {
  const program = programs.find((row) => row.program_id === "INTENT_COMMITMENT_FLOW_V1") || programs[0];
  setText("researchProgramStatus", program?.status || "NOT REGISTERED");
  setText("researchProgramPrinciple", program
    ? "Discovery is continuous and outside Evidence WIP. Modeling turns mechanisms into contracts. Validation alone consumes protected evidence budget."
    : "The long-lived research program is not present in canonical state.");
  if (!$("researchPrograms")) return;
  if (!program) {
    $("researchPrograms").innerHTML = `<div class="research-honest-empty"><strong>Program state unavailable</strong><span>Waiting for the next Control Plane reconciliation.</span></div>`;
    return;
  }
  const subsystems = program.subsystems || [];
  $("researchPrograms").innerHTML = subsystems.map((row, index) => {
    const activeLabel = row.subsystem_id === "DISCOVERY"
      ? "CONTINUOUS"
      : row.subsystem_id === "MECHANISM_MODELING"
        ? "ON DEMAND"
        : "GATED";
    const budget = row.uses_evidence_wip ? "uses Evidence WIP" : "outside Evidence WIP";
    const latest = row.latest_artifact_id || "No immutable output yet";
    const counts = `${row.completed_contour_count || 0}/${row.bound_contour_count || 0} bound contours completed`;
    return `<article class="research-program-stage tone-${portalTone(row.status)}"><div><span>${escapeHtml(activeLabel)}</span><strong>${escapeHtml(row.title)}</strong></div><p>${escapeHtml(budget)} · output: ${escapeHtml(row.output_artifact)}</p><small>${escapeHtml(counts)}</small><details><summary>Details</summary><dl><div><dt>Lifecycle</dt><dd>${escapeHtml(row.lifecycle)}</dd></div><div><dt>Admission</dt><dd>${escapeHtml(row.admission_rule)}</dd></div><div><dt>Waits for</dt><dd>${escapeHtml((row.waits_for || []).join(", ") || "nothing")}</dd></div><div><dt>Latest artifact</dt><dd>${escapeHtml(latest)}</dd></div></dl></details></article>${index < subsystems.length - 1 ? `<span class="research-program-arrow" aria-hidden="true">→</span>` : ""}`;
  }).join("");
}

function renderResearchDimensionalityIntegrity(system) {
  const rdi = (system.extensions || []).find((row) => row.heuristic_id === "E8");
  setText("researchRdiStatus", rdi?.status || "PLANNED");
  if (!rdi) {
    setText("researchRdiReason", "Waiting for canonical Control Plane policy");
    setText("researchRdiActivation", "threshold unavailable");
    setText("researchRdiHeartbeat", "not registered");
    setText("researchRdiAblation", "DISABLED");
    return;
  }
  const progress = rdi.progress || {};
  const remaining = Number(progress.remaining_research_cycles || 0);
  const reason = rdi.reason === "INSUFFICIENT_COMPLETED_RESEARCH_CYCLES"
    ? "Недостаточно накопленных исследований"
    : rdi.reason === "RFC_REVIEW_REQUIRED_BEFORE_ACTIVATION"
      ? "Threshold reached; RFC Review required"
      : "Activation threshold and RFC Review satisfied";
  const dayEstimate = progress.estimated_days_at_observed_rate == null
    ? ""
    : ` · ≈${progress.estimated_days_at_observed_rate}d`;
  setText("researchRdiReason", reason);
  setText("researchRdiActivation", `${progress.completed_research_cycles || 0}/${progress.required_research_cycles || "?"} cycles · ${remaining} remaining${dayEstimate}`);
  setText("researchRdiHeartbeat", rdi.heartbeat_at ? portalRelativeTime(rdi.heartbeat_at) : "unknown");
  setText("researchRdiAblation", rdi.runtime?.behavioral_ablation_enabled ? "ACTIVE" : "DISABLED UNTIL ACTIVATION");
  setText("researchRdiDetail", `${(rdi.degeneration_catalog || []).join(" · ") || "Degeneration catalog unavailable"}. Activation review: ${rdi.activation_review?.status || "NOT_DUE"}; no research contour or separate service is created.`);
}

function renderPrimaryProcessList(items, label, emptyMarkup) {
  if (!items.length) return emptyMarkup;
  const [primary, ...rest] = items;
  return `${renderOperationalProcessCard(primary)}${rest.length ? `<details class="research-aggregate-more"><summary>${escapeHtml(primary.name)} <em>(+${rest.length})</em><span>Show all ${escapeHtml(label)}</span></summary><div class="research-process-list">${rest.map(renderOperationalProcessCard).join("")}</div></details>` : ""}`;
}

function operationalFlowItems(id, operations, view) {
  if (id === "running") return [...(view.now || []), ...(view.starting || [])];
  if (id === "waiting") return view.waiting || [];
  if (id === "ready") return (operations.contours || [])
    .filter((row) => ["READY", "READY_TO_TEST", "QUEUED", "ADMITTED"].includes(row.status))
    .map(contourAsAggregateItem);
  if (id === "money") {
    const verdicts = (operations.contours || []).filter((row) => ["POSITIVE", "MONEY_VERDICT_POSITIVE", "SIGNED_VERDICT"].includes(row.status));
    return verdicts.map(contourAsAggregateItem);
  }
  if (id === "capital" && operations.capital_pipeline?.idle === false) {
    return [{ name: operations.capital_pipeline.nearest_candidate || "Capital connected", status: "CONNECTED" }];
  }
  return [];
}

function operationalFlowEmptyLabel(id) {
  return ({
    ready: "No ready process",
    running: "No running process",
    waiting: "No waiting process",
    money: "No signed verdict",
    capital: "Not connected",
  })[id] || "None";
}

function contourAsAggregateItem(row) {
  return {
    name: row.title || row.contour_id || "Unnamed contour",
    id: row.contour_id,
    status: row.status,
    reason: row.blocking_reasons?.[0] || row.next_milestone || "",
  };
}

function pipelineAggregateItems(name, operations) {
  const statuses = {
    Planned: ["PLANNED"],
    Ready: ["READY", "READY_TO_TEST"],
    Queued: ["QUEUED"],
    Admitted: ["ADMITTED"],
    Running: ["RUNNING"],
    Blocked: ["BLOCKED", "WAITING_OWNER"],
    Completed: ["COMPLETED"],
  }[name] || [];
  return (operations.contours || []).filter((row) => statuses.includes(row.status)).map(contourAsAggregateItem);
}

function renderPipelineAggregate(name, operations) {
  const items = pipelineAggregateItems(name, operations);
  const primary = items[0];
  if (!primary) return `<div class="pipeline-aggregate-empty"><span>${escapeHtml(name)}</span><strong>No objects</strong></div>`;
  const remainder = Math.max(0, items.length - 1);
  return `<details class="pipeline-aggregate-card" data-pipeline-stage="${escapeHtml(name.toLowerCase())}"><summary><span>${escapeHtml(name)}</span><strong>${escapeHtml(primary.name)}</strong>${remainder ? `<em>(+${remainder})</em>` : ""}</summary><div>${items.map((item) => `<article><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id || item.status)}</small></article>`).join("")}</div></details>`;
}

function renderOperationalProcessCard(row) {
  const eta = row.eta_hours == null ? "ETA unknown" : `ETA ${portalEta(row.eta_hours)}`;
  const progress = Math.max(0, Math.min(100, Number(row.progress || 0)));
  return `<article class="research-process-card tone-${portalTone(row.status)}"><div><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.status)}</span></div><p>${escapeHtml(row.owner || row.reason || "Control Plane")} · ${escapeHtml(eta)}</p><div class="research-process-progress"><i style="width:${progress}%"></i></div><small>Output: ${escapeHtml(compactText(row.output || "Immutable artifact", 150))}</small><details><summary>Details</summary><dl><div><dt>Process</dt><dd>${escapeHtml(row.id || "—")}</dd></div><div><dt>Started</dt><dd>${escapeHtml(portalDate(row.started_at))}</dd></div><div><dt>Progress</dt><dd>${escapeHtml(progress)}%</dd></div><div><dt>Target</dt><dd>${escapeHtml(row.target || "—")}</dd></div></dl></details></article>`;
}

function portalRelativeTime(value) {
  const timestamp = Date.parse(value || 0);
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function renderCriticalPath(criticalPath, recovery) {
  setText("criticalPathStatus", criticalPath.contour_status || "UNKNOWN");
  setText("criticalPathCandidate", criticalPath.candidate || "No candidate");
  const reasons = (criticalPath.blocking_reasons || []).map((row) => row.code || row).join(", ") || "No active block";
  if ($("criticalPathFacts")) $("criticalPathFacts").innerHTML = [
    ["Blocking reason", reasons],
    ["Source status", criticalPath.source_recovery_status || recovery.status || "SEARCHING"],
    ["Next step", criticalPath.next_step || recovery.next_step || "—"],
  ].map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  setText("sourceRecoveryStatus", recovery.status || "SEARCHING");
  setText("sourceRecoveryHash", recovery.source?.sha256 ? `sha256:${recovery.source.sha256.slice(0, 20)}…` : "No exact source registered");
  const checked = recovery.provenance_search?.checked_stores?.length || 0;
  if ($("sourceRecoveryFacts")) $("sourceRecoveryFacts").innerHTML = [
    ["Checked stores", checked],
    ["Exact matches", recovery.exact_card?.match_count ?? recovery.provenance_search?.exact_matches?.length ?? 0],
    ["Last storage", recovery.last_checked_storage || "—"],
    ["Next step", recovery.next_step || "—"],
  ].map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}

function renderParallelResearchInventory(inventory) {
  const candidates = inventory.candidates || [];
  const admissible = candidates.filter((row) => String(row.decision || "").startsWith("ADMISSIBLE"));
  setText("parallelInventoryMeta", `${admissible.length} admissible · ${candidates.length} checked`);
  if ($("parallelResearchInventory")) $("parallelResearchInventory").innerHTML = candidates.map((row) => `<article class="tone-${portalTone(String(row.decision || "").startsWith("ADMISSIBLE") ? "RUNNING" : "BLOCKED")}"><div><strong>${escapeHtml(row.candidate || row.contour_id)}</strong><span>${escapeHtml(row.decision || "UNKNOWN")}</span></div><p>${escapeHtml(row.exact_reason || "—")}</p><dl><div><dt>Dependency</dt><dd>${escapeHtml(row.dependency || "none")}</dd></div><div><dt>Resident</dt><dd>${row.resident_operator_can_resolve ? "AUTONOMOUS" : "NO"}</dd></div><div><dt>ETA start</dt><dd>${escapeHtml(portalEta(row.eta_to_start_hours))}</dd></div></dl></article>`).join("") || `<div class="portal-empty">Parallel inventory proof is still running.</div>`;
}

function renderResidentOperator(operator) {
  setText("residentOperatorStatus", operator.status === "WAITING_DEPENDENCY" ? "WAITING" : operator.status || "UNKNOWN");
  setText("residentMission", operator.current_mission || "—");
  setText("residentTask", ["MONITORING", "WAITING_DEPENDENCY"].includes(operator.status) && operator.next_action
    ? operator.next_action.action
    : operator.current_task || "—");
  setText("residentEngine", portalEngineName(operator.current_engine));
  setText("residentEngineReason", operator.engine_selection_reason || "canonical deterministic state");
  setText("residentSource", operator.reasoning_source || "UNAVAILABLE");
  setText("residentStarted", portalDate(operator.started_at));
  setText("residentEta", portalEta(operator.eta_hours));
  setText("residentReasoning", operator.current_reasoning || "—");
  setText("residentLastAction", operator.last_action
    ? `${operator.last_action.action} · ${portalRelativeTime(operator.last_action.completed_at)}`
    : "No completed autonomous action recorded");
  setText("residentNextAction", operator.next_action
    ? `${operator.next_action.action} · ${operator.next_action.automatic ? "automatic" : "waiting dependency"}`
    : operator.idle_reason || "Monitoring; no autonomous action is admissible");
  const actions = operator.automatic_actions || [];
  setText("residentActionCount", actions.length);
  if ($("residentActions")) $("residentActions").innerHTML = actions.map((row) => `<li><strong>${escapeHtml(row.action)}</strong><span>${escapeHtml(row.target_contour_id)} · ETA ${escapeHtml(portalEta(row.eta_hours))}</span></li>`).join("") || `<li class="portal-empty">Monitoring only; no autonomous action is currently admissible.</li>`;
}

function portalEngineName(value) {
  return ({
    RULE_ENGINE: "Rule Engine",
    LOCAL_LLM: "Local LLM",
    GEMINI: "Gemini",
  })[value] || value || "Rule Engine";
}

function renderReasoningGovernor(governor) {
  const engines = governor.engines || {};
  const budget = governor.budget || {};
  const currency = budget.currency || "EUR";
  setText("reasoningBudgetMode", budget.mode || "UNAVAILABLE");
  setText("reasoningCurrentEngine", governor.current_engine || "—");
  setText("reasoningSelectionReason", governor.selection_reason || "No governed decision yet.");
  setText("reasoningBudgetSpent", `${portalMoney(budget.spent)} ${currency}`);
  setText("reasoningBudgetRemaining", `${portalMoney(budget.remaining)} ${currency}`);
  setText("reasoningBudgetForecast", `${portalMoney(budget.forecast)} ${currency}`);
  setText("reasoningPreventedCalls", governor.savings?.prevented_gemini_calls || 0);
  setText("reasoningSavedCost", `${portalMoney(governor.savings?.estimated_saved_cost_eur)} EUR`);
  renderReasoningEngineMetrics("reasoningRule", engines.rule_engine, governor.current_engine === "RULE_ENGINE");
  renderReasoningEngineMetrics("reasoningLocal", engines.local_llm, governor.current_engine === "LOCAL_LLM");
  renderReasoningEngineMetrics("reasoningGemini", engines.gemini, governor.current_engine === "GEMINI");
  const periods = [...(governor.history || []), {
    day: governor.day,
    engines,
    budget,
    savings: governor.savings || {},
    quality: governor.quality || {},
  }].filter((row) => row.day).slice(-31);
  const total = (engine) => periods.reduce((sum, row) => sum + Number(row.engines?.[engine]?.requests_today || 0), 0);
  const totalSpent = periods.reduce((sum, row) => sum + Number(row.budget?.spent || 0), 0);
  const totalSaved = periods.reduce((sum, row) => sum + Number(row.savings?.estimated_saved_cost_eur || 0), 0);
  const quality = governor.quality || {};
  setText("reasoningQualityStatus", quality.status || "NO_DATA");
  setText("reasoningQualityBasis", quality.basis || "Quality signal begins with the first governed decision.");
  if ($("reasoningHistory")) $("reasoningHistory").innerHTML = [
    ["Days recorded", periods.length],
    ["Rule decisions", total("rule_engine")],
    ["Local decisions", total("local_llm")],
    ["Gemini decisions", total("gemini")],
    ["Gemini spent", `${portalMoney(totalSpent)} ${budget.currency || "EUR"}`],
    ["Estimated saved", `${portalMoney(totalSaved)} EUR`],
    ["Reasoning failures", quality.reasoning_failures || 0],
    ["Low confidence", quality.low_confidence_decisions || 0],
  ].map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  const improvements = governor.improvement_candidates || [];
  setText("reasoningImprovementCount", improvements.length);
  if ($("reasoningImprovements")) $("reasoningImprovements").innerHTML = improvements.map((row) => `<li><strong>${escapeHtml(row.reason)}</strong><span>${escapeHtml(row.recommendation)} · ${escapeHtml(row.status || "PROPOSED")}</span></li>`).join("") || `<li class="portal-empty">No repeated escalation pattern has crossed the policy threshold.</li>`;
}

function renderReasoningEngineMetrics(prefix, metrics = {}, active = false) {
  setText(`${prefix}Status`, active ? "ACTIVE" : "STANDBY");
  const target = $(`${prefix}Metrics`);
  if (!target) return;
  const values = [
    ["Requests", metrics.requests_today || 0],
    ["Successful", metrics.successful || 0],
    ["Prevented", metrics.prevented || 0],
    ["Escalated", metrics.escalated || 0],
    ["Avg latency", `${Math.round(Number(metrics.average_latency_ms || 0))} ms`],
    ["Est. cost", `${portalMoney(metrics.estimated_cost_eur)} EUR`],
  ];
  target.innerHTML = values.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}

function portalMoney(value) {
  const number = Number(value || 0);
  return number < 0.01 ? number.toFixed(6) : number.toFixed(2);
}

function renderFireMonitor(fire) {
  setText("fireOpen", `${fire.open || 0} open`);
  setText("fireToday", fire.today || 0);
  setText("fireWeek", fire.week || 0);
  setText("fireMonth", fire.month || 0);
  setText("fireObjective", fire.objective || "—");
  if ($("fireCategories")) $("fireCategories").innerHTML = Object.entries(fire.categories || {}).map(([name, count]) => `<div><span>${escapeHtml(name)}</span><strong>${escapeHtml(count)}</strong></div>`).join("") || `<div class="portal-empty">No recorded incidents.</div>`;
}

function renderBlockedGraph(contours) {
  const blocked = contours.filter((row) => ["BLOCKED", "WAITING_OWNER"].includes(row.status));
  setText("blockedGraphCount", blocked[0]?.title ? `${blocked[0].title}${blocked.length > 1 ? ` (+${blocked.length - 1})` : ""}` : "No blocked objects");
  if ($("blockedGraph")) $("blockedGraph").innerHTML = blocked.map((row) => {
    const explanation = row.block_explanations?.[0] || {};
    const chain = (row.flow_chain || []).map((node) => `${node.type} ${node.status}`).join(" → ");
    return `<article class="blocked-node"><div class="blocked-node-head"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.contour_id)}</span></div><p><b>Why:</b> ${escapeHtml((row.blocking_reasons || []).join(", ") || "UNKNOWN")}</p><p><b>Unblocks:</b> ${escapeHtml(explanation.required_action || "No formal unblock rule")}</p><dl><div><dt>Actor</dt><dd>${escapeHtml(explanation.unblocked_by || "UNKNOWN")}</dd></div><div><dt>Autonomous</dt><dd>${explanation.can_execute_automatically ? "YES" : "NO"}</dd></div><div><dt>Expected gain</dt><dd>${escapeHtml(explanation.expected_gain ?? "unknown")}</dd></div><div><dt>ETA</dt><dd>${escapeHtml(portalEta(explanation.eta_hours))}</dd></div></dl><small>${escapeHtml(chain)}</small></article>`;
  }).join("") || `<div class="portal-empty">No blocked contours.</div>`;
}

function renderAutonomousActions(actions) {
  setText("autonomousActionCount", actions.length);
  if ($("autonomousActions")) $("autonomousActions").innerHTML = actions.map((row) => `<article><div><strong>✓ ${escapeHtml(row.action)}</strong><span>${escapeHtml(portalDate(row.executed_at))}</span></div><p><b>Root Cause:</b> ${escapeHtml(row.root_cause || "—")}</p><p><b>System Improvement:</b> ${escapeHtml(row.system_improvement || "—")}</p></article>`).join("") || `<div class="portal-empty">No recent autonomous action.</div>`;
}

function renderOwnerAttention(items) {
  setText("ownerAttentionCount", items.length);
  if ($("ownerAttention")) $("ownerAttention").innerHTML = items.map((row) => `<article><strong>${escapeHtml(row.what)}</strong><p>${escapeHtml(row.why)}</p><dl><div><dt>Consequence</dt><dd>${escapeHtml(row.consequence)}</dd></div><div><dt>Deadline</dt><dd>${escapeHtml(portalDate(row.deadline))}</dd></div></dl></article>`).join("") || `<div class="portal-empty positive">No genuine owner decision is required.</div>`;
}

function renderResearchContours(operations) {
  const contours = operations?.contours || [];
  const filtered = contours.filter((row) => researchContourFilter === "BLOCKED"
    ? ["BLOCKED", "WAITING_OWNER"].includes(row.status)
    : researchContourFilter === "COMPLETED"
      ? row.status === "COMPLETED"
      : !["BLOCKED", "WAITING_OWNER", "COMPLETED", "REJECTED"].includes(row.status));
  if ($("researchContours")) $("researchContours").innerHTML = filtered.slice(0, 24).map((row) => `<article class="research-contour tone-${portalTone(row.status)}"><div><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.status)}</span></div><small>${escapeHtml(row.contour_id)}</small><div class="research-contour-bar"><i style="width:${Number(row.progress || 0)}%"></i></div><dl><div><dt>ETA</dt><dd>${escapeHtml(row.eta_days == null ? "unknown" : `${row.eta_days}d`)}</dd></div><div><dt>Artifact</dt><dd>${escapeHtml(row.current_artifact || "—")}</dd></div></dl><p>${escapeHtml(row.next_milestone || row.blocking_reasons?.join(", ") || "No next milestone")}</p></article>`).join("") || `<div class="portal-empty">No ${escapeHtml(researchContourFilter.toLowerCase())} contours.</div>`;
}

function renderHandoffPortal(operations) {
  const handoff = operations.handoff || {};
  setText("handoffRevision", `revision ${handoff.state_revision || "—"}`);
  const changes = handoff.latest_changes || [];
  setText("handoffChangeCount", changes.length);
  if ($("handoffChanges")) $("handoffChanges").innerHTML = changes.map((row) => `<li><time>${escapeHtml(portalDate(row.timestamp))}</time><div><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.detail)}</span></div></li>`).join("") || `<li class="portal-empty">No canonical changes recorded.</li>`;
  if ($("handoffFacts")) $("handoffFacts").innerHTML = (handoff.next_agent_must_know || []).map((fact) => `<li>${escapeHtml(fact)}</li>`).join("") || `<li>No handoff facts available.</li>`;
  const artifacts = handoff.recent_artifacts || [];
  setText("handoffArtifactCount", artifacts.length);
  if ($("handoffArtifacts")) $("handoffArtifacts").innerHTML = artifacts.map((row) => `<article><strong>${escapeHtml(row.artifact_id)}</strong><span>${escapeHtml(row.contour_id)} · ${escapeHtml(portalDate(row.timestamp))}</span><small>${escapeHtml(row.hash?.slice(0, 18) || "no hash")} · ${row.evidence_bearing ? "evidence" : "preparation"}</small></article>`).join("") || `<div class="portal-empty">No immutable artifacts.</div>`;
  const mismatches = operations.reconciliation?.mismatches?.length || 0;
  setText("handoffIntegrity", mismatches ? `${mismatches} reconciliation mismatches` : "No reconciliation mismatches");
}

function renderCouncilPortal(council, operations) {
  council ||= { status: "UNAVAILABLE", entries: [] };
  setText("portalCouncilFreshness", council.updatedAt ? portalDate(council.updatedAt) : council.status || "unavailable");
  setText("portalCouncilStatus", council.status || "UNKNOWN");
  setText("portalCouncilSummary", council.summary || "No council takeaway available.");
  const entries = council.entries || [];
  setText("portalCouncilCount", entries.length);
  if ($("portalCouncilEntries")) $("portalCouncilEntries").innerHTML = entries.slice(0, 30).map((row) => `<article><div><strong>${escapeHtml(row.title || "Untitled decision")}</strong><span>${escapeHtml(row.verdict || row.status || "recorded")}</span></div><p>${escapeHtml(compactText(row.insight || row.reasoning || "", 280))}</p><small>${escapeHtml(row.source || "Council")} · ${escapeHtml(portalDate(row.createdAt || row.updatedAt || row.time))}</small></article>`).join("") || `<div class="portal-empty">No Council decisions recorded.</div>`;
  const incidents = operations?.open_incidents || [];
  setText("portalCouncilIncidentCount", incidents.length);
  if ($("portalCouncilIncidents")) $("portalCouncilIncidents").innerHTML = incidents.map((row) => `<article class="incident"><div><strong>${escapeHtml(row.code)}</strong><span>${escapeHtml(row.status)}</span></div><p>${escapeHtml(row.detail)}</p><small>${escapeHtml(row.contour_id)} · ${escapeHtml(portalDate(row.detected_at))}</small></article>`).join("") || `<div class="portal-empty positive">No open institute incidents.</div>`;
}

function render(state) {
  currentState = state;
  if (!dashboardStrategyView) dashboardStrategyView = "demo_earn";
  lastRenderAt = Date.now();
  renderInstitutePortal(state);
  const dashboardView = currentDashboardView(state);
  const dashboardLane = currentDashboardLane(state);
  const dashboardLaneLabel = dashboardLane === "demo_earn" ? "Demo Earn" : dashboardLane === "investigate" ? "Demo Investigate" : "Real";
  const earnView = dashboardView === "real";
  const metricView = dashboardMetricView(state);
  const fullHistory = metricView.history || [];
  const demoEarnMetrics = metricView.usesReal ? null : demoEarnFinancialStats(fullHistory, periodRangeMs);
  const execution = executionState(state);
  const mt5Demo = mt5Lane(state, "demo");
  const mt5Real = mt5Lane(state, "real");
  const usesMt5Execution = execution.current === "MT5";
  const mt5ConfiguredButInactive = Boolean(execution.mt5Configured && !usesMt5Execution);
  const connected = usesMt5Execution ? Boolean(execution.online) : Boolean(state.cdp.connected);
  const connectionPill = $("connectionPill");
  connectionPill.textContent = usesMt5Execution
    ? `MT5 ${connected ? "Online" : "Offline"}`
    : (mt5ConfiguredButInactive
      ? `CDP fallback ${connected ? "Online" : "Offline"}`
      : `CDP ${connected ? "Online" : "Offline"}`);
  connectionPill.classList.toggle("online", connected);

  setText("subtitle", usesMt5Execution
    ? `Current execution: MT5 · Demo source: ${execution.demoSource || "MT5 Demo"} · Real source: ${execution.realSource || "MT5 Real"}`
    : (mt5ConfiguredButInactive
      ? `Current execution: CDP_LEGACY fallback · MT5 not authorized / no MT5 trades · ${execution.mt5OfflineReason || "waiting for MT5 authorization"}`
      : `Current execution: CDP_LEGACY · ${state.cdp.error || state.cdp.url || "Waiting for Libertex terminal"}`));
  setText("statusPill", metricView.statusPill);
  setText("runtimeText", metricView.runtimeText);
  const realSummaryForLabels = metricView.usesReal ? realLaneSummary(state) : null;
  const realHasOpenTrades = Number(realSummaryForLabels?.openTrades || 0) > 0;
  const realNetText = metricView.usesReal ? money(realSummaryForLabels?.netProfitUsd || 0).replace(/^\+/, "") : metricView.openProfitText;
  setText("openProfitPill", metricView.usesReal
    ? `${realHasOpenTrades ? "Open P/L" : "Closed net"} ${realHasOpenTrades ? metricView.openProfitText : realNetText}`
    : `Open P/L ${metricView.openProfitText}`);
  setText("periodTitle", `Изменение за ${periodLabel(periodRangeMs)}`);
  setText("exposureMeta", `${fullHistory.length} points`);
  setText("usedChartText", metricView.usedText);
  setText("profitChartLabel", metricView.usesReal
    ? (realHasOpenTrades ? "Real net + open" : "Real closed net")
    : `${dashboardLaneLabel} P/L`);
  setText("profitChartText", metricView.usesReal
    ? realNetText
    : metricView.openProfitText);
  const demoEarnStats = metricView.usesReal ? { visible: false, current: 0, delta: 0 } : demoEarnHistoryStats(fullHistory);
  const demoEarnLegend = $("demoEarnLegend");
  if (demoEarnLegend) {
    demoEarnLegend.hidden = metricView.usesReal || chartLaneFilter === "explore" || !demoEarnStats.visible;
  }
  setText("demoEarnChartText", demoEarnStats.visible ? `${money(demoEarnStats.current)} · ${money(demoEarnStats.delta)} delta` : "not isolated");
  setText("chartNote", metricView.usesReal
    ? "Real uses a cent-scale P/L overlay for micro-real probes, so a $0.01 move stays visible beside small used funds."
    : dashboardLane === "demo_earn"
      ? "Demo Earn показывает только попытки заработка на демо. Это proof of intent; real readiness растёт только после закрытых разборов."
      : "Demo Investigate должен быстро проверять MSE/human-chart паттерны и превращать закрытия в уроки, не смешиваясь с earn-контуром.");
  setCompactText("robotSummary", buildRobotSummary(state), earnView ? 190 : 180);
  renderRealEtaPanel(state);
  setMoney("sessionProfit", metricView.openProfitValue);
  setText("sessionTotalText", metricView.usesReal ? "" : `${dashboardLaneLabel} total ${money(historyNetChange(fullHistory, metricView.openProfitValue).value)} · open ${metricView.openProfitText}`);
  const selectedPeriod = metricView.usesReal
    ? periodProfitStrictWindow(fullHistory, periodRangeMs, metricView.openProfitValue, "openProfit")
    : periodNetProfit(fullHistory, periodRangeMs, state);
  updatePeriodRangeButtons(fullHistory, metricView.usesReal);
  setMoney("profitPerHour", selectedPeriod.value);
  setText("periodTotalText", metricView.usesReal ? "" : `${dashboardLaneLabel} ${money(selectedPeriod.value)} за ${periodLabel(periodRangeMs)}`);
  const coverageText = metricView.usesReal
    ? (metricView.funded
      ? (selectedPeriod.points >= 2
        ? `real-точек ${selectedPeriod.points}, покрыто ${shortDuration(selectedPeriod.coverageMs)} из ${periodLabel(periodRangeMs)}`
        : `в окне ${periodLabel(periodRangeMs)} только ${selectedPeriod.points} ${selectedPeriod.points === 1 ? "точка" : "точек"}`)
      : "real-истории пока нет")
    : (selectedPeriod.fullCoverage
      ? `последний период: ${periodLabel(periodRangeMs)}`
      : `покрыто ${shortDuration(selectedPeriod.coverageMs)} из ${periodLabel(periodRangeMs)}`);
  const periodDetails = metricView.usesReal
    ? (metricView.funded
      ? `Только real-метрики: ${coverageText}; текущий real net ${money(metricView.openProfitValue)}.`
      : "Только real-дорожка: подтверждённой real-истории ещё нет, поэтому график честно пустой.")
    : (selectedPeriod.flatOpen
      ? `итог ${coverageText}; открытый P/L ${money(selectedPeriod.currentOpen)} почти не менялся`
      : `итог ${coverageText}; закрыто ${money(selectedPeriod.balanceDelta)}, открыто ${money(selectedPeriod.openDelta)}`);
  setText("availableText", `доступно ${metricView.availableText} · ${periodDetails}`);
  if (metricView.usesReal) {
    setDelta("balanceDay", { value: 0, fullCoverage: false, coverageMs: 0, rangeMs: 86400000 });
    setDelta("balanceWeek", { value: 0, fullCoverage: false, coverageMs: 0, rangeMs: 604800000 });
    setDelta("balanceMonth", { value: 0, fullCoverage: false, coverageMs: 0, rangeMs: 2592000000 });
  } else {
    renderBalanceDeltas(fullHistory);
  }
  drawExposureChart(fullHistory, metricView.openProfitValue, metricView.usesReal
    ? {
        emptyText: metricView.chartEmptyText,
        emptyMeta: metricView.chartEmptyMeta,
        microProfitScale: true,
        strictRange: true,
        usesReal: true,
        profitNowLabel: realHasOpenTrades ? "сейчас" : "закрыто",
      }
    : { usesReal: false });
  setText("modeText", earnView ? modeLabel("earn-view") : modeLabel(state.mode));
  setText("scannerText", scannerLabel(state, earnView));
  setText("accountGuard", usesMt5Execution
    ? (execution.online ? "MT5 bridge online" : "MT5 execution offline")
    : (earnView ? modeLabel(`real-${String(realLaneStatus(state)).toLowerCase()}`) : modeLabel(state.terminal.accountGuard)));
  setText("accountText", usesMt5Execution
    ? (earnView ? mt5LaneMetaText(mt5Real) : mt5LaneMetaText(mt5Demo))
    : metricView.accountText);
  if (metricView.usesReal) {
    setText("balanceText", metricView.balanceText);
    $("balanceText")?.classList.remove("positive", "negative");
    setText("balanceTotalText", "");
  } else {
    setText("balanceText", metricView.balanceText);
    $("balanceText")?.classList.remove("positive", "negative");
    setText("balanceTotalText", `${dashboardLaneLabel} ${metricView.laneNetText || "$0"} · total demo balance ${fallbackDemoBalanceText(state)}`);
  }
  const realSummaryNow = realLaneSummary(state);
  const realTerminal = realTerminalSnapshot(state);
  const demoReportedOpenCount = Number(state.terminal.activeTradesCount ?? 0) || 0;
  const demoExposureOpenCount = Number(state.terminal.usedValue || 0) > 0.01 || Math.abs(Number(state.terminal.profitValue || 0)) > 0.01
    ? Math.max(1, Number(state.terminal.activeTrades?.length || 0) || demoReportedOpenCount || 1)
    : demoReportedOpenCount;
  const selectedDemoOpenSnapshots = metricView.usesReal ? [] : currentDemoOpenFeedItems(state, dashboardLane);
  const selectedDemoOpenCount = metricView.usesReal
    ? 0
    : Math.max(selectedDemoOpenSnapshots.length, currentDemoLaneOpenCount(state, dashboardLane));
  setText("selectedInstrument", earnView ? (realTerminal.accountType === "real" ? (state?.realTerminal?.selectedInstrument || "только real-дорожка") : "только real-дорожка") : `${dashboardLaneLabel}: ${state.terminal.selectedInstrument || "сканирую"}`);
  setText("openProfitText", metricView.openProfitText);
  setText("usedText", metricView.usedText);
  setText("openTradesText", earnView ? realSummaryNow.openTrades : selectedDemoOpenCount);
  setText("feedOpenCount", earnView ? realSummaryNow.openTrades : selectedDemoOpenCount);
  setText("feedOpenProfit", metricView.openProfitText);
  setText("feedUsedFunds", earnView ? metricView.usedText : (selectedDemoOpenCount > 0 ? metricView.usedText : "$0.00"));
  setText("pendingTradesText", earnView ? realTerminal.pendingTradesCount : (state.terminal.pendingTradesCount ?? "-"));
  setText("closedTradesText", earnView ? `${realSummaryNow.closedTradesAll} всего / ${realSummaryNow.closedTrades24h} за 24ч` : (state.terminal.closedTrades24hCount ?? 0));
  setText("mobileFeedMeta", earnView
    ? `${realSummaryNow.openTrades} open · ${currentFeedItems(state).filter(isTradeFeedItem).length} real-событий`
    : `${selectedDemoOpenCount} open · ${currentFeedItems(state).filter(isTradeFeedItem).length} торговых событий`);
  setText("mobileSummaryMeta", earnView
    ? `${modeLabel(String(realLaneStatus(state)).toLowerCase())} · ${metricView.openProfitText}`
    : `${healthInfo(state.health?.state || "HEALTHY")?.label || "Работает"} · ${state.terminal.profit || "$0.00"}`);
  setText("mobileReviewMeta", `${currentClosedReviewItems(state).length} reviews`);
  if (earnView) {
    const realReviewState = realClosedReviewState(state);
    setText("mobileReviewMeta", `${realReviewState.closedAll} closed · ${realReviewState.reviewed} reviews`);
  }
  setText("mobileInsightMeta", `${(state.learning.insights || []).length} инсайтов`);
  setText("mobileStrategyMeta", `${currentClosedReviewItems(state).length} reviewed`);
  const realLane = state.risk?.realLane || {};
  renderEarnRibbon(state);
  const demoOpenCount = selectedDemoOpenCount;
  const demoPendingCount = state.terminal.pendingTradesCount ?? 0;
  const demoOpenProfit = state.terminal.profit || "$0.00";
  const demoUsed = state.terminal.used || "$0.00";
  const demoAccount = state.terminal.account ? `${state.terminal.account} ${state.terminal.accountType || ""}` : "demo lane";
  const demoExposureNote = demoReportedOpenCount === 0 && demoOpenCount > 0 ? " · список сделок пуст, exposure виден по терминалу" : "";
  setText("mobileExecutionMeta", `${demoOpenCount} demo открыто · ${realLaneSummary(state).totalTrades || 0} real сделок`);
  setText("mobileScannerMeta", `${state.scanner.counters.scans} сканов · ${state.scanner.counters.candidates} кандидатов`);
  const visibleInstrumentsSeen = state.scanner.counters.visibleInstrumentsSeen || 0;
  setText("mobileMarketMeta", `${state.scanner.counters.instrumentsSeen} в каталоге · ${visibleInstrumentsSeen} видно`);
  setText("lastScan", fmtTime(state.scanner.lastScanAt));
  setText("executionPill", usesMt5Execution
    ? "Current execution: MT5"
    : (mt5ConfiguredButInactive ? "CDP fallback · MT5 not authorized" : (demoEarnIsActive(state) ? "demo earn активен" : "demo explore")));
  setText("executionDemoStatus", usesMt5Execution
    ? mt5LaneStatusText(mt5Demo)
    : `${demoOpenCount} открыто · ${demoPendingCount} отложено · ${demoOpenProfit}`);
  setText("executionDemoMeta", usesMt5Execution
    ? mt5LaneMetaText(mt5Demo)
    : `${demoEarnIsActive(state) ? "Demo Earn validation-only" : "Explore / сбор данных"} · provider CDP_LEGACY${mt5ConfiguredButInactive ? " · MT5 not authorized / no MT5 trades" : ""} · ${demoAccount} · занято ${demoUsed}${demoExposureNote} · ${healthInfo(state.health?.state || "HEALTHY")?.label || "Работает"}${state.health?.reason ? ` · ${state.health.reason}` : ""}`);
  const resetText = state.startedAt ? fmtTime(state.startedAt) : "-";
  const currentRunText = state.processStartedAt ? fmtTime(state.processStartedAt) : "не запущен";
  setText("executionEpochNote", `Текущий запуск с ${currentRunText}; baseline ${resetText}. Demo продолжает учиться, если не включён общий стоп.`);
  const realLaneStatusText = String(realLane.status || "DISABLED").toLowerCase();
  const realLaneStatusCode = String(realLane.status || "DISABLED");
  const realLaneNext = realLane.nextStep || "Робот ждёт отдельную real-сессию Libertex. После этого он сделает маленькую калибровочную real-сделку и замерит исполнение.";
  const realSummary = realLaneSummary(state);
  const showRealLaneUi = realLaneHasFundedActivity(state);
  setText("executionRealStatus", usesMt5Execution
    ? mt5LaneStatusText(mt5Real)
    : (showRealLaneUi
      ? `${realSummary.closedTradesAll} закрыто всего · ${realSummary.closedTrades24h} за 24ч · net ${money(realSummary.netProfitUsd)}`
      : "real ещё не пополнен"));
  setText("executionRealMeta", usesMt5Execution
    ? mt5LaneMetaText(mt5Real)
    : (showRealLaneUi
      ? `${modeLabel(realLaneStatusText)} · ${realLaneNext}`
      : `${modeLabel(realLaneStatusText)} · real-дорожка ждёт отдельную real-сессию и первый калибровочный вход`));
  const demoPill = $("executionDemoPill");
  if (demoPill) {
    demoPill.textContent = demoEarnIsActive(state) ? "demo earn" : (state.scannerRunning ? "explore" : "пауза");
    demoPill.classList.toggle("online", Boolean(state.scannerRunning));
    demoPill.classList.toggle("locked", !state.scannerRunning);
  }
  const realPill = $("executionRealPill");
  if (realPill) {
    realPill.textContent = modeLabel(realLaneStatusText);
    realPill.classList.toggle("online", realLaneStatusCode === "LIVE");
    realPill.classList.toggle("locked", !showRealLaneUi || ["DISABLED", "STOPPED"].includes(realLaneStatusCode));
    realPill.classList.toggle("danger", realLaneStatusCode === "DRAINING");
  }
  const mseText = marketStateSummary(state);
  setText("executionSummary", usesMt5Execution
    ? `${execution.online ? "MT5 bridge heartbeat свежий." : `MT5 execution offline: ${execution.offlineReason || "heartbeat missing"}.`} Dashboard читает MT5 positions/history/results; CDP помечен как legacy/fallback и не подставляется вместо MT5. ${mseText}`
    : (mt5ConfiguredButInactive
      ? `MT5 = not authorized / no MT5 trades (${execution.mt5OfflineReason || "no authorized MT5 account"}). CDP = active fallback / trades possible. Provider по сделкам ставится только по факту MT5 ticket; без ticket это CDP_LEGACY. ${mseText}`
      : (dashboardView === "real"
        ? `Earn показывает только real-дорожку. CDP legacy execution. ${mseText}`
        : `${demoEarnIsActive(state) ? "Demo Earn проверяет лучшие демо-правила как попытку заработка." : "Explore собирает demo-гипотезы."} ${mseText}. Real отдельно показывает реальное исполнение. CDP legacy execution.`)));
  const openResultModeText = dashboardView === "real"
    ? (showRealLaneUi
      ? `Earn показывает только real: ${realSummary.closedTradesAll} закрыто всего, ${realSummary.closedTrades24h} за 24ч, итог ${money(realSummary.netProfitUsd)}. ${realLaneWhyNow(state)}`
      : `Earn показывает только real. На real уже есть ${configuredRealBalanceText(state)}, но входы ещё заблокированы до отдельной real-сессии Libertex. После её подключения робот начнёт с маленькой real-сделки для замера исполнения и проскальзывания.`)
    : `${demoEarnIsActive(state) ? "Demo Earn" : "Explore"} показывает demo-контур. Сейчас demo: открыто ${demoOpenCount}, P/L ${demoOpenProfit}. Demo Earn — это намерение заработать на демо, но real readiness растёт только через закрытые разборы.`;
  setCompactText("openResultModeNote", openResultModeText, 170);
  const earnAutoRunning = realLaneStatusCode === "LIVE" && Boolean(realLane.autoEntriesAllowed);
  const startRealButton = $("startRealLane");
  if (startRealButton) {
    const showStartReal = dashboardView === "real" && showRealLaneUi && !earnAutoRunning && realLaneStatusCode !== "DRAINING";
    const startEnabled = showStartReal && realLaneCanArm(state);
    startRealButton.hidden = !showStartReal;
    startRealButton.disabled = !startEnabled;
    startRealButton.textContent = "Start earning";
    startRealButton.title = showRealLaneUi
      ? "Включить Earn: робот сам выберет маленькую real-калибровочную сделку, demo investigation продолжит работать параллельно."
      : "Включить real-дорожку. Реальные входы всё равно останутся заблокированы, пока не будет отдельной real-сессии Libertex и первой калибровочной сделки.";
  }
  const stopRealButton = $("stopRealLane");
  if (stopRealButton) {
    const showStopReal = dashboardView === "real" && (earnAutoRunning || realLaneStatusCode === "DRAINING");
    stopRealButton.hidden = !showStopReal;
    stopRealButton.disabled = realLaneStatusCode === "DRAINING";
    stopRealButton.textContent = realLaneStatusCode === "DRAINING" ? "Stopping earning..." : "Stop earning";
    stopRealButton.title = "Плавно остановить только Earn: новые real-входы запрещены, открытые real-сделки закрываются штатно, demo-investigation продолжает работать.";
  }
  setText("scanCount", state.scanner.counters.scans);
  setText("instrumentCount", `${state.scanner.counters.instrumentsSeen} / ${visibleInstrumentsSeen}`);
  setText("errorCount", state.scanner.counters.connectionErrors);
  setText("candidatePill", `${state.scanner.counters.candidates} candidates`);
  setText("terminalTitle", usesMt5Execution
    ? `MT5 bridge · ${execution.accountSource || execution.provider || "MT5"}`
    : `CDP legacy · ${state.cdp.title || "No tab"}`);
  setText("learnRealtime", state.learning.realtime);
  setText("learnHourly", state.learning.hourly);
  setText("learnDaily", state.learning.daily);
  setText("learnWeekly", state.learning.weekly);
  setText("demoPolicy", state.demoExecution.policy);
  setText("catalogTotal", state.catalog.total);
  setText("demoStatus", state.demoExecution.lastError || state.demoExecution.lastResult?.side || mseText || "Demo only. Real account is blocked.");
  renderAdvisor(state);
  const closedScan = state.learning.lastClosedReviewScan || null;
  const closedScanText = earnView
    ? (() => {
        const realReviews = currentClosedReviewItems(state);
        if (realReviews.length) {
          const latest = realReviews[0];
          return `Real-закрытий ${realReviews.length} · последнее ${latest.instrument || "сделка"} ${latest.profitText || ""}`;
        }
        const realReviewState = realClosedReviewState(state);
        if (realReviewState.closedAll > 0) {
          return `Real-закрытий ${realReviewState.closedAll} · детальных разборов ${realReviewState.reviewed} · realized ${money(realReviewState.realized)}`;
        }
        return realLaneHumanReason(state);
      })()
    : closedScan?.error
      ? `Последняя проверка ${fmtTime(closedScan.time)} · ошибка: ${closedScan.error}`
      : closedScan
        ? `Последняя проверка ${fmtTime(closedScan.time)} · строк ${closedScan.reviewed ?? 0} · новых ${closedScan.newReviews ?? 0}${closedScan.latestInstrument ? ` · последняя ${closedScan.latestInstrument} ${closedScan.latestProfitText || ""}` : ""}`
        : `Автослежение · открыто ${(state.terminal.openTradeReviews || []).length} · скан ${Math.round((state.scanner.intervalMs || 0) / 1000)}с · ${(healthInfo(state.health?.state || "HEALTHY")?.label || "работает").toLowerCase()}`;
  setText("reviewClosedStatus", closedScanText);

  $("toggleScanner").textContent = state.scannerRunning ? "Пауза" : "Продолжить";
  $("killSwitch").classList.toggle("active", state.killSwitch);
  const robotToggle = $("robotToggle");
  const stopStatus = globalStopStatus(state);
  if (robotStopCountdown && stopStatus !== "IDLE") {
    clearRobotStopCountdown({ rerender: false });
  }
  const running = state.scannerRunning && !state.killSwitch && stopStatus !== "STOPPED";
  const stopCountdownActive = !IS_SHARED_VIEW && robotStopCountdown && stopStatus === "IDLE";
  if (stopCountdownActive) {
    const secondsLeft = Math.max(1, Math.ceil((robotStopCountdown.deadline - Date.now()) / 1000));
    robotToggle.textContent = `Cancel stop ${secondsLeft}s`;
    robotToggle.title = "Нажми ещё раз, чтобы отменить общий stop до начала мягкой остановки.";
  } else if (stopStatus === "DRAINING") {
    robotToggle.textContent = "Stopping";
    robotToggle.title = "Общий stop уже запущен: новые входы и LLM отключены, существующие сделки дренируются.";
  } else {
    robotToggle.textContent = running ? "Stop" : "Start";
    robotToggle.title = running
      ? "Остановить весь контур: через 5 секунд без отмены новые входы и LLM будут остановлены, а живые сделки пойдут в мягкое закрытие."
      : "Запустить сканирование, решения и исполнение снова.";
  }
  if (IS_SHARED_VIEW) robotToggle.textContent = running ? "Running" : "Stopped";
  robotToggle.classList.toggle("running", running);
  robotToggle.classList.toggle("stopped", !running && stopStatus !== "DRAINING");
  robotToggle.classList.toggle("pending", Boolean(stopCountdownActive || stopStatus === "DRAINING"));

  renderModeButtons(state.mode);
  renderInstruments(state.scanner.instruments || []);
  renderFeed(currentFeedItems(state), { view: dashboardView });
  renderClosedReviews(currentClosedReviewItems(state));
  if (!earnView) {
    notifyNewClosedReviews(state.learning.closedTradeReviews || []);
    renderInsights(state.learning.insights || []);
    renderStrategyBalance(state.learning.closedTradeReviews || []);
    renderHypothesisHealth(state);
  }
  renderLearningMeter(state);
  setDashboardSectionVisibility(dashboardView);

  const image = $("terminalSnapshot");
  const snapshotSource = earnView ? state.realTerminal : state.terminal;
  if (snapshotSource?.screenshot) {
    image.src = `${portalApiUrl(snapshotSource.screenshot)}?t=${encodeURIComponent(snapshotSource.screenshotCapturedAt || snapshotSource.lastGoodSnapshotAt || state.scanner.lastScanAt || "")}`;
    setText("snapshotMeta", `${earnView ? "Real" : "Demo"} · ${fmtTime(snapshotSource.screenshotCapturedAt || snapshotSource.lastGoodSnapshotAt || state.scanner.lastScanAt)}`);
  }
}

async function refreshState(reason = "manual") {
  if (fallbackRefreshInFlight) return;
  fallbackRefreshInFlight = true;
  try {
    const response = await portalFetch(`/api/state?refresh=${encodeURIComponent(reason)}&t=${Date.now()}`, {
      cache: "no-store",
    });
    if (response.status === 401) {
      apiLocked = true;
      if (IS_GITHUB_PORTAL) sessionStorage.removeItem(PORTAL_ACCESS_TOKEN_KEY);
      showPortalLogin("Dashboard code required.");
      renderClosedReviews([]);
      setText("connectionPill", "Locked");
      $("connectionPill")?.classList.add("locked");
      return;
    }
    if (!response.ok) throw new Error(`state_http_${response.status}`);
    apiLocked = false;
    hidePortalLogin();
    renderIncomingState(await response.json());
  } catch (error) {
    console.warn("state refresh failed", error);
  } finally {
    fallbackRefreshInFlight = false;
  }
}

function connectEventStream() {
  if (IS_GITHUB_PORTAL) return;
  if (eventSource) eventSource.close();
  const source = new EventSource("/events");
  eventSource = source;
  source.onmessage = (event) => {
    try {
      apiLocked = false;
      renderIncomingState(JSON.parse(event.data));
    } catch (error) {
      console.warn("event render failed", error);
    }
  };
  source.onerror = () => {
    if (eventSource !== source) return;
    setTimeout(() => {
      if (eventSource === source && source.readyState === EventSource.CLOSED) {
        connectEventStream();
      }
    }, 3000);
  };
}

function titleForMobileSection(section) {
  return section?.querySelector(".panel-head h2")?.textContent?.trim() || "Section";
}

function closeMobileSection() {
  if (!activeMobileSection) return;
  activeMobileSection.placeholder.replaceWith(activeMobileSection.section);
  activeMobileSection = null;
  $("mobileDetailBody").innerHTML = "";
  $("mobileDetail").setAttribute("aria-hidden", "true");
  document.body.classList.remove("mobile-detail-open");
}

function openMobileSection(id) {
  const section = $(id);
  const body = $("mobileDetailBody");
  if (!section || !body) return;
  closeMobileSection();
  const placeholder = document.createComment(`mobile-placeholder:${id}`);
  section.replaceWith(placeholder);
  body.appendChild(section);
  setText("mobileDetailTitle", titleForMobileSection(section));
  $("mobileDetail").setAttribute("aria-hidden", "false");
  document.body.classList.add("mobile-detail-open");
  activeMobileSection = { id, section, placeholder };
  body.scrollTop = 0;
}

document.querySelectorAll("[data-mobile-target]").forEach((button) => {
  button.addEventListener("click", () => openMobileSection(button.dataset.mobileTarget));
});

if ($("mobileBack")) {
  $("mobileBack").addEventListener("click", closeMobileSection);
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMobileSection();
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 640) closeMobileSection();
});

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (IS_SHARED_VIEW) return;
    render(await postJson("/api/mode", { mode: button.dataset.mode }));
  });
});

window.addEventListener("pointerdown", armSound, { once: true });

document.querySelectorAll("[data-strategy-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    if (IS_SHARED_VIEW) return;
    dashboardStrategyView = button.dataset.strategyMode;
    if (dashboardStrategyView === "demo_earn") chartLaneFilter = "earn";
    if (dashboardStrategyView === "investigate") chartLaneFilter = "explore";
    if (dashboardStrategyView === "real") chartLaneFilter = "all";
    syncChartControls();
    if (currentState) render(currentState);
  });
});

bindDetailsOnClick($("openResultModeNote"), "Open Result");
bindDetailsOnClick($("summary-section"), "Что делает робот", () => $("robotSummary")?.dataset.fullText || "");
bindDetailsOnClick(document.querySelector(".strategy-mode-card"), "Готовность к real", () => document.querySelector(".strategy-mode-card")?.dataset.fullText || "");

if ($("stopRealLane")) {
  $("stopRealLane").addEventListener("click", async () => {
    if (IS_SHARED_VIEW) return;
    render(await postJson("/api/real-lane", { action: "stop" }));
  });
}

if ($("startRealLane")) {
  $("startRealLane").addEventListener("click", async () => {
    if (IS_SHARED_VIEW) return;
    render(await postJson("/api/real-lane", { action: "arm" }));
  });
}

document.querySelectorAll("[data-period-range]").forEach((button) => {
  button.addEventListener("click", () => {
    periodRangeMs = Number(button.dataset.periodRange);
    document.querySelectorAll("[data-period-range]").forEach((item) => item.classList.toggle("active", item === button));
    if (currentState) render(currentState);
  });
});

document.querySelectorAll("[data-feed-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    feedFilter = button.dataset.feedFilter;
    document.querySelectorAll("[data-feed-filter]").forEach((item) => item.classList.toggle("active", item === button));
    if (currentState) render(currentState);
  });
});

document.querySelectorAll("[data-chart-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    chartFilter = button.dataset.chartFilter;
    syncChartControls();
    if (currentState) render(currentState);
  });
});

document.querySelectorAll("[data-chart-lane]").forEach((button) => {
  button.addEventListener("click", () => {
    chartLaneFilter = button.dataset.chartLane || "all";
    syncChartControls();
    if (currentState) render(currentState);
  });
});

document.querySelectorAll("[data-chart-range]").forEach((button) => {
  button.addEventListener("click", () => {
    chartRangeMs = button.dataset.chartRange === "all" ? null : Number(button.dataset.chartRange);
    syncChartControls();
    if (currentState) render(currentState);
  });
});

document.querySelectorAll("[data-insight-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    insightFilter = button.dataset.insightFilter;
    document.querySelectorAll("[data-insight-filter]").forEach((item) => item.classList.toggle("active", item === button));
    if (currentState) render(currentState);
  });
});

document.querySelectorAll("[data-strategy-metric]").forEach((button) => {
  button.addEventListener("click", () => {
    strategyMetric = button.dataset.strategyMetric;
    document.querySelectorAll("[data-strategy-metric]").forEach((item) => item.classList.toggle("active", item === button));
    if (currentState) render(currentState);
  });
});

document.querySelectorAll("[data-strategy-range]").forEach((button) => {
  button.addEventListener("click", () => {
    strategyRangeMs = button.dataset.strategyRange === "all" ? null : Number(button.dataset.strategyRange);
    document.querySelectorAll("[data-strategy-range]").forEach((item) => item.classList.toggle("active", item === button));
    if (currentState) render(currentState);
  });
});

document.querySelectorAll("[data-strategy-provider]").forEach((button) => {
  button.addEventListener("click", () => {
    strategyProviderFilter = button.dataset.strategyProvider || "combined";
    document.querySelectorAll("[data-strategy-provider]").forEach((item) => item.classList.toggle("active", item === button));
    if (currentState) render(currentState);
  });
});

$("reviewPrev").addEventListener("click", () => scrollReviewSlider(-1));
$("reviewNext").addEventListener("click", () => scrollReviewSlider(1));
setupReviewSliderDrag();

$("scanOnce").addEventListener("click", async () => {
  if (IS_SHARED_VIEW) return;
  render(await postJson("/api/scan-once"));
});

$("toggleScanner").addEventListener("click", async () => {
  if (IS_SHARED_VIEW) return;
  render(await postJson("/api/scanner", { running: !currentState?.scannerRunning }));
});

$("killSwitch").addEventListener("click", async () => {
  if (IS_SHARED_VIEW) return;
  render(await postJson("/api/kill-switch", { enabled: !currentState?.killSwitch }));
});

$("robotToggle").addEventListener("click", async () => {
  if (IS_SHARED_VIEW) return;
  if (robotStopCountdown) {
    clearRobotStopCountdown();
    return;
  }
  if (globalStopStatus(currentState) === "DRAINING") return;
  const running = !(currentState?.scannerRunning && !currentState?.killSwitch && globalStopStatus(currentState) !== "STOPPED");
  if (!running) {
    startRobotStopCountdown();
    return;
  }
  render(await postJson("/api/robot-toggle", { running }));
});

$("shareDashboard").addEventListener("click", async () => {
  if (IS_SHARED_VIEW) return;
  const button = $("shareDashboard");
  button.disabled = true;
  try {
    const payload = await postJson("/api/share");
    await navigator.clipboard?.writeText(payload.url);
    setText("shareStatus", `copied · expires ${fmtTime(payload.expiresAt)}`);
  } catch (error) {
    setText("shareStatus", error.message);
  } finally {
    button.disabled = false;
  }
});

if ($("prepareBuy")) $("prepareBuy").addEventListener("click", async () => {
  const payload = await postJson("/api/demo/prepare-ticket", { side: "BUY" });
  render(payload.state);
});

if ($("prepareSell")) $("prepareSell").addEventListener("click", async () => {
  const payload = await postJson("/api/demo/prepare-ticket", { side: "SELL" });
  render(payload.state);
});

if ($("runSmallBuy")) $("runSmallBuy").addEventListener("click", async () => {
  const payload = await postJson("/api/demo/run-small-market-test", { side: "BUY" });
  render(payload.state);
});

if ($("runSmallSell")) $("runSmallSell").addEventListener("click", async () => {
  const payload = await postJson("/api/demo/run-small-market-test", { side: "SELL" });
  render(payload.state);
});

$("crawlCatalog").addEventListener("click", async () => {
  const payload = await postJson("/api/catalog/crawl");
  render(payload.state);
});

if ($("reviewClosedTrades")) $("reviewClosedTrades").addEventListener("click", async () => {
  const button = $("reviewClosedTrades");
  button.disabled = true;
  setText("reviewClosedStatus", "Checking closed trades...");
  try {
    const payload = await postJson("/api/review-closed-trades");
    render(payload.state);
    const reviewed = payload.result?.reviewed ?? 0;
    const added = payload.result?.newReviews?.length ?? 0;
    setText("reviewClosedStatus", `Reviewed ${reviewed}, new ${added}`);
  } catch (error) {
    setText("reviewClosedStatus", error.message);
  } finally {
    button.disabled = false;
  }
});

if ($("reviewOpenTrades")) $("reviewOpenTrades").addEventListener("click", async () => {
  const button = $("reviewOpenTrades");
  button.disabled = true;
  setText("reviewClosedStatus", "Checking open trades...");
  try {
    const payload = await postJson("/api/review-open-trades");
    render(payload.state);
    const reviewed = payload.result?.reviewed ?? 0;
    const saved = payload.result?.saved ?? 0;
    setText("reviewClosedStatus", `Open reviewed ${reviewed}, saved ${saved}`);
  } catch (error) {
    setText("reviewClosedStatus", error.message);
  } finally {
    button.disabled = false;
  }
});

initializePortalShell();
bindPortalLogin();
connectEventStream();
setInterval(() => {
  if (IS_GITHUB_PORTAL) {
    if (portalAccessToken()) refreshState("github-pages-poll");
    return;
  }
  const maxStaleMs = document.hidden ? 120000 : 45000;
  if (!lastRenderAt || Date.now() - lastRenderAt > maxStaleMs) {
    refreshState("fallback-poll");
  }
}, IS_GITHUB_PORTAL ? 5000 : 15000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (!lastRenderAt || Date.now() - lastRenderAt > 10000)) {
    refreshState("visible");
  }
});

refreshState("initial");
