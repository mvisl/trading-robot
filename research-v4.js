import { initHypothesisThroughput, renderHypothesisThroughput } from "./hypothesis-throughput.js?v=20260821-live-v2";

const MINIMUM_EVALUATION_TARGET = 200;

const byId = (id) => document.getElementById(id);

function setText(id, value) {
  const node = byId(id);
  if (node) node.textContent = value == null || value === "" ? "Not available" : String(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value, fallback = 0) {
  return finite(value) ?? fallback;
}

function humanStatus(value, fallback = "WAITING") {
  const status = String(value || fallback).toUpperCase();
  if (/ERROR|FAIL|UNAVAILABLE/.test(status)) return "ERROR";
  if (/WAIT|PARK|IDLE|PENDING/.test(status)) return "WAITING";
  return "ACTIVE";
}

function setStatus(id, value) {
  const node = byId(id);
  if (!node) return;
  const status = humanStatus(value);
  node.textContent = status;
  node.classList.remove("active", "waiting", "error");
  node.classList.add(status.toLowerCase());
}

function dateLabel(value) {
  if (!value) return "Not available";
  const dateMatch = String(value).match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const parsed = new Date(`${dateMatch || value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return String(value).replaceAll("_", " ");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsed);
}

function timestampLabel(value) {
  const parsed = new Date(value || "");
  if (!Number.isFinite(parsed.getTime())) return "Authoritative state pending";
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed)}`;
}

function pendingMetric(value, formatter = String) {
  return value == null ? "Pending" : formatter(value);
}

function money(value) {
  const parsed = finite(value);
  if (parsed == null) return "Pending";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(parsed);
}

function pct(value) {
  const parsed = finite(value);
  if (parsed == null) return "Pending";
  return `${parsed.toFixed(1)}%`;
}

function metricArticle(label, value, note = "") {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ""}</article>`;
}

function routeArticle(title, status, note = "") {
  return `<article><strong>${escapeHtml(title)}</strong><span>${escapeHtml(status)}</span>${note ? `<small>${escapeHtml(note)}</small>` : ""}</article>`;
}

function authoritativeBatch(runtime, contour) {
  const batchId = contour?.authoritative_batch_id;
  return runtime?.batches?.[batchId] || Object.values(runtime?.batches || {}).find((batch) => batch?.state === "WAITING_OUTCOME") || null;
}

function projection(state) {
  const operations = state?.instituteOperations || {};
  const bundle = operations.research_factory_v4?.multi_contour_state
    ? operations.research_factory_v4
    : publishedBundle || {};
  const factory = bundle.multi_contour_state || null;
  const prediction = factory?.prediction_contour || {};
  const demo = factory?.demo_strategy_arena || {};
  const investment = factory?.investment_contour || {};
  const strict = factory?.strict_institute || {};
  const hypothesisThroughput = bundle.hypothesis_throughput || null;
  const empirical = bundle.empirical_discovery || null;
  const atlas = bundle.atlas_state || null;
  const predictionV41 = bundle.prediction_v4_1 || null;
  const runtime = bundle.prediction_runtime || {};
  const manifest = bundle.first_batch_manifest || {};
  const batch = authoritativeBatch(runtime, prediction);
  return { operations, bundle, factory, prediction, demo, investment, strict, runtime, manifest, batch, hypothesisThroughput, empirical, atlas, predictionV41 };
}

let activePerformanceView = "learning";
let publishedBundle = (() => {
  const node = document.getElementById("researchV4PublishedState");
  if (!node?.textContent) return null;
  try {
    return JSON.parse(node.textContent);
  } catch {
    return null;
  }
})();
let publishedBundleRequest = null;

function loadPublishedBundle() {
  if (publishedBundle || publishedBundleRequest) return publishedBundleRequest;
  publishedBundleRequest = fetch("./research-v4-state.json", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`research_v4_snapshot_http_${response.status}`);
      return response.json();
    })
    .then((bundle) => {
      publishedBundle = bundle;
      if (window.__researchFactoryCurrentState) renderResearchV4(window.__researchFactoryCurrentState);
      return bundle;
    })
    .catch(() => null);
  return publishedBundleRequest;
}

function renderPerformance(view, data) {
  const grid = byId("rfv4PerformanceGrid");
  if (!grid) return;
  const resolved = count(data.prediction.resolved_oos_observations);
  const waiting = resolved === 0;
  const rows = view === "money"
    ? [
      ["Net expectancy", waiting ? "Pending" : pendingMetric(data.demo.net_expectancy, money)],
      ["Average win / loss", "Pending"],
      ["Payoff ratio", "Pending"],
      ["Profit factor", "Pending"],
      ["Drawdown", "Pending"],
      ["vs baselines", waiting ? "Pending" : "Not available"],
    ]
    : view === "science"
      ? [
        ["Strict screens", String(count(data.strict.screens_run))],
        ["Formal tests", String(count(data.strict.formal_tests))],
        ["Strict survivors", String(count(data.strict.strict_survivors))],
        ["Prospective shadows", String(count(data.strict.prospective_shadows_active))],
      ]
      : [
        ["Direction accuracy", waiting ? "Pending" : "Not available"],
        ["Brier", waiting ? "Pending" : "Not available"],
        ["Calibration", waiting ? "Pending" : "Not available"],
        ["Resolved N", String(resolved)],
      ];
  grid.innerHTML = rows.map(([label, value]) => metricArticle(label, value)).join("");
}

function renderModels(data) {
  const body = byId("rfv4ModelRows");
  if (!body) return;
  const resolved = count(data.prediction.resolved_oos_observations);
  const active = new Set(data.prediction.models_participating || data.manifest.model_responses?.map((row) => row.slot) || []);
  const models = [
    ["GPT", active.has("GPT") ? "active" : "inactive"],
    ["Gemini", active.has("GEMINI") ? "active" : "inactive"],
    ["Claude", data.prediction.claude_status || "inactive"],
    ["Consensus", "derived arm"],
    ["Random", "baseline"],
    ["Always Long", "baseline"],
  ];
  body.innerHTML = models.map(([name, status]) => {
    const unavailable = name === "Claude" && !active.has("CLAUDE");
    const value = unavailable ? "Inactive" : resolved ? "Not available" : "Pending";
    return `<tr><td>${escapeHtml(name)} <small>${escapeHtml(status)}</small></td>${Array.from({ length: 5 }, () => `<td class="pending">${escapeHtml(value)}</td>`).join("")}</tr>`;
  }).join("");
  setText("rfv4ModelNote", resolved ? `${resolved} resolved OOS rows` : "Pending first resolution");
}

function renderDetailViews(data) {
  const { prediction, demo, investment, strict, manifest, empirical, hypothesisThroughput } = data;
  const strictTotals = hypothesisThroughput?.authoritative_totals || {};
  const resolved = count(prediction.resolved_oos_observations);
  const sealed = count(prediction.sealed_prediction_rows, count(manifest.rows?.total_sealed));
  const consensus = count(manifest.rows?.consensus_rows);
  const progress = Math.min(100, (resolved / MINIMUM_EVALUATION_TARGET) * 100);

  setStatus("rfv4PredictionDetailStatus", prediction.active ? (resolved ? "ACTIVE" : "WAITING") : "ERROR");
  setText("rfv4PredictionDetailSealed", sealed);
  setText("rfv4PredictionDetailResolved", resolved);
  setText("rfv4PredictionDetailResolvedNote", resolved ? "OOS outcomes available" : "Waiting for first resolution");
  setText("rfv4DecisionDates", count(prediction.decision_dates));
  setText("rfv4PredictionDetailConsensus", consensus);
  setText("rfv4EvaluationReadiness", `${resolved} / ${MINIMUM_EVALUATION_TARGET} resolved`);
  if (byId("rfv4EvaluationBar")) byId("rfv4EvaluationBar").style.width = `${progress}%`;
  if (byId("rfv4ModelRoutes")) {
    const activeModels = prediction.models_participating || [];
    byId("rfv4ModelRoutes").innerHTML = [
      ...activeModels.map((model) => routeArticle(model, "ACTIVE · sealed route", "Independent frozen forecast")),
      routeArticle("Claude", "INACTIVE", "No current authorized route"),
      routeArticle("Consensus", "ACTIVE · deterministic", `${consensus} sealed derived rows`),
    ].join("");
  }

  setStatus("rfv4DemoDetailStatus", demo.active ? "ACTIVE" : "WAITING");
  if (byId("rfv4DemoDetailMetrics")) {
    byId("rfv4DemoDetailMetrics").innerHTML = [
      metricArticle("Active arms", count(demo.arms?.length)),
      metricArticle("Resolved trades", count(demo.resolved_trades), "After frozen costs"),
      metricArticle("Open positions", count(demo.open_positions)),
      metricArticle("Net expectancy", pendingMetric(demo.net_expectancy, money), resolved ? "Available after scoring" : "Waiting for first resolution"),
      metricArticle("Net paper P&L", resolved ? "Not available" : "Pending"),
      metricArticle("Profit factor", resolved ? "Not available" : "Pending"),
      metricArticle("Max drawdown", resolved ? "Not available" : "Pending"),
      metricArticle("Next threshold", "First resolved trade"),
    ].join("");
  }
  if (byId("rfv4ArenaArms")) {
    byId("rfv4ArenaArms").innerHTML = (demo.arms || []).map((arm) => routeArticle(arm.replaceAll("_", " "), "SEALED", resolved ? "Awaiting full metrics" : "Pending first outcome")).join("") || routeArticle("Arena", "WAITING", "No active arms reported");
  }

  setStatus("rfv4InvestmentDetailStatus", investment.ledger_active ? (count(investment.sealed_theses) ? "ACTIVE" : "WAITING") : "ERROR");
  if (byId("rfv4InvestmentDetailMetrics")) {
    byId("rfv4InvestmentDetailMetrics").innerHTML = [
      metricArticle("Active sealed theses", count(investment.sealed_theses)),
      metricArticle("Resolved theses", count(investment.resolved_theses)),
      metricArticle("Horizons", "1W · 1M · 3M"),
      metricArticle("Paper performance", count(investment.resolved_theses) ? "Not available" : "Pending"),
    ].join("");
  }
  if (byId("rfv4InvestmentEmpty")) byId("rfv4InvestmentEmpty").hidden = count(investment.sealed_theses) > 0;

  setStatus("rfv4StrictDetailStatus", strict.active ? "ACTIVE" : "ERROR");
  if (byId("rfv4StrictDetailMetrics")) {
    byId("rfv4StrictDetailMetrics").innerHTML = [
      metricArticle("Evidence-backed / normalized", `${strictTotals.evidence_backed ?? "Not available"} / ${strictTotals.normalized ?? "Not available"}`),
      metricArticle("Early kills", strictTotals.early_kills ?? "Not available"),
      metricArticle("D0 / D1", `${strictTotals.D0 ?? "Not available"} / ${strictTotals.D1 ?? "Not available"}`),
      metricArticle("Screens run", strictTotals.screens ?? "Not available"),
      metricArticle("Signals", strictTotals.signals ?? "Not available"),
      metricArticle("Formal tests", strictTotals.formal_tests ?? "Not available"),
      metricArticle("Strict survivors", strictTotals.survivors ?? "Not available"),
      metricArticle("Prospective shadows", count(strict.prospective_shadows_active)),
    ].join("");
  }
  setText("rfv4ShadowCount", `${count(strict.prospective_shadows_active)} active`);
  if (byId("rfv4ShadowRows")) {
    byId("rfv4ShadowRows").innerHTML = [
      routeArticle("Treasury", strict.treasury || "Not available", "Prospective accumulation only"),
      routeArticle("Binance delisting", strict.binance_delisting || "Not available", "Shadow-only; no rescue metadata"),
      routeArticle("T1", strict.t1 || "Not available", "Strict gate unchanged"),
    ].join("");
  }

  const empiricalAvailable = empirical?.artifact_contract === "EMPIRICAL_DISCOVERY_RUNTIME_STATE_V1";
  if (byId("rfv4EmpiricalDetailStatus")) {
    setStatus("rfv4EmpiricalDetailStatus", empiricalAvailable ? "WAITING" : "ERROR");
    setText("rfv4EmpiricalDetailStatus", empiricalAvailable ? String(empirical.phase || "STATE AVAILABLE").replaceAll("_", " ") : "NO STATE");
  }
  if (byId("rfv4EmpiricalDetailMetrics")) {
    byId("rfv4EmpiricalDetailMetrics").innerHTML = [
      metricArticle("Predeclared tests", empiricalAvailable ? count(empirical.predeclared_tests) : "Not available"),
      metricArticle("Completed tests", empiricalAvailable ? count(empirical.completed_tests) : "Not available"),
      metricArticle("Forward confirmations", empiricalAvailable ? count(empirical.forward_confirmations_active) : "Not available"),
      metricArticle("Outcomes accessed", empiricalAvailable ? String(empirical.outcomes_accessed === true).toUpperCase() : "Not available"),
      metricArticle("Research only", empiricalAvailable ? String(empirical.research_only === true).toUpperCase() : "Not available"),
      metricArticle("Capital used", empiricalAvailable ? String(empirical.capital_used === true).toUpperCase() : "Not available"),
    ].join("");
  }
  setText("rfv4EmpiricalUpdated", empiricalAvailable ? timestampLabel(empirical.updated_at) : "Нет данных");
  setText("rfv4EmpiricalDetailSummary", empiricalAvailable
    ? "Lane is materialized and frozen pre-outcome. It remains separate from Strict and has no real-capital authority."
    : "Нет authoritative Empirical Discovery state; фиктивные значения не показываются.");
}

export function renderResearchV4(state) {
  if (!byId("researchFactoryV4")) return;
  const data = projection(state);
  renderHypothesisThroughput(data.hypothesisThroughput, { period: byId("hypothesisFactoryThroughput")?.dataset.period || "7D" });
  const { factory, prediction, demo, investment, strict, manifest, batch } = data;
  if (!factory) {
    setStatus("rfv4FactoryStatus", "ERROR");
    setText("rfv4UpdatedAt", "Authoritative V4 state not available");
    void loadPublishedBundle();
    return;
  }

  const sealed = count(prediction.sealed_prediction_rows, count(batch?.prediction_count));
  const resolved = count(prediction.resolved_oos_observations, count(batch?.resolved_count));
  const demoTrades = count(demo.resolved_trades);
  const activeTheses = count(investment.sealed_theses);
  const strictTotals = data.hypothesisThroughput?.authoritative_totals || {};
  const strictScreens = finite(strictTotals.screens) ?? count(strict.screens_run);
  const strictSurvivors = finite(strictTotals.survivors) ?? count(strict.strict_survivors);
  const consensus = count(manifest.rows?.consensus_rows);
  const modelsActive = count(prediction.models_participating?.length);
  const nextResolution = dateLabel(prediction.earliest_expected_resolution || manifest.earliest_expected_resolution);
  const progress = Math.min(100, (resolved / MINIMUM_EVALUATION_TARGET) * 100);

  setStatus("rfv4FactoryStatus", "ACTIVE");
  setText("rfv4UpdatedAt", timestampLabel(data.runtime.updated_at_utc || factory.created_at_utc || data.bundle.loaded_at || data.bundle.published_at));
  setText("rfv4Sealed", sealed);
  setText("rfv4Resolved", resolved);
  setText("rfv4DemoTrades", demoTrades);
  setText("rfv4ActiveTheses", activeTheses);
  setText("rfv4StrictScreens", strictScreens);
  setText("rfv4StrictSurvivors", strictSurvivors);

  setText("rfv4FastestLoop", String(prediction.fastest_feedback_loop || "Not available").replaceAll("_", " "));
  setText("rfv4FastestLoopMeta", resolved ? `${resolved} resolved OOS` : `First expected ${nextResolution}`);
  setText("rfv4BestExpectancy", resolved ? pendingMetric(demo.net_expectancy, money) : "Waiting for first resolution");
  setText("rfv4BestExpectancyMeta", resolved ? "After frozen costs" : "No positive edge claim before sufficient N");
  setText("rfv4MoneyMilestone", resolved ? "First scored paper comparison" : "First 1D outcome");
  setText("rfv4MoneyMilestoneMeta", resolved ? "Awaiting economic scoring" : `Expected ${nextResolution}`);

  const ownerItems = factory.owner_decisions_pending || [];
  const ownerPanel = byId("rfv4OwnerAttention");
  if (ownerPanel) ownerPanel.hidden = ownerItems.length === 0;
  if (ownerItems.length) {
    const owner = ownerItems[0] || {};
    setText("rfv4OwnerWhat", owner.what || owner.title || owner.decision || "Owner decision pending");
    setText("rfv4OwnerWhy", owner.why || owner.reason || "A protected decision requires owner authority.");
    setText("rfv4OwnerAge", owner.age || owner.since || "Age not available");
  }

  setStatus("rfv4PredictionStatus", prediction.active ? (resolved ? "ACTIVE" : "WAITING") : "ERROR");
  setText("rfv4PredictionProgress", `${resolved} / ${MINIMUM_EVALUATION_TARGET}`);
  if (byId("rfv4PredictionProgressBar")) byId("rfv4PredictionProgressBar").style.width = `${progress}%`;
  setText("rfv4ModelsActive", modelsActive);
  setText("rfv4ConsensusCount", consensus);
  setText("rfv4PredictionExpectancy", resolved ? pendingMetric(demo.net_expectancy, money) : "Pending");
  setText("rfv4VsRandom", resolved ? "Not available" : "Pending");
  setText("rfv4VsLong", resolved ? "Not available" : "Pending");
  setText("rfv4Brier", resolved ? "Not available" : "Pending");
  setText("rfv4PredictionNext", resolved ? "Next evaluation update pending" : `Next resolution ${nextResolution}`);

  setStatus("rfv4DemoStatus", demo.active ? "ACTIVE" : "WAITING");
  setText("rfv4DemoLead", demoTrades);
  setText("rfv4DemoArms", count(demo.arms?.length));
  setText("rfv4DemoPnl", resolved ? "Not available" : "Pending");
  setText("rfv4DemoExpectancy", resolved ? pendingMetric(demo.net_expectancy, money) : "Pending");
  setText("rfv4DemoProfitFactor", resolved ? "Not available" : "Pending");
  setText("rfv4DemoDrawdown", resolved ? "Not available" : "Pending");
  setText("rfv4DemoBaseline", resolved ? "Not available" : "Pending");
  setText("rfv4DemoNext", resolved ? "Next evaluation threshold not available" : "Next threshold: first resolved trade");

  setStatus("rfv4InvestmentStatus", investment.ledger_active ? (activeTheses ? "ACTIVE" : "WAITING") : "ERROR");
  setText("rfv4InvestmentLead", activeTheses);
  setText("rfv4InvestmentResolved", count(investment.resolved_theses));
  setText("rfv4InvestmentPerformance", count(investment.resolved_theses) ? "Not available" : "Pending");
  setText("rfv4StrongestThesis", activeTheses ? "Not available" : "No active thesis");
  setText("rfv4InvestmentNext", activeTheses ? "Next thesis resolution not available" : "Waiting for first sealed thesis");

  setStatus("rfv4StrictStatus", strict.active ? "ACTIVE" : "ERROR");
  setText("rfv4StrictLead", strictSurvivors);
  setText("rfv4CompiledSeeds", `${strictTotals.evidence_backed ?? "—"} / ${strictTotals.normalized ?? "—"}`);
  setText("rfv4D0D1", `${strictTotals.D0 ?? "—"} / ${strictTotals.D1 ?? "—"}`);
  setText("rfv4ScreenReady", strictTotals.early_kills ?? "—");
  setText("rfv4ScreensSignals", `${strictScreens} / ${strictTotals.signals ?? "—"}`);
  setText("rfv4FormalTests", strictTotals.formal_tests ?? "—");
  setText("rfv4Shadows", count(strict.prospective_shadows_active));
  const noRawMaterial = String(data.hypothesisThroughput?.operational_state?.hunter_status || "").startsWith("NO_RAW_MATERIAL");
  setText("rfv4StrictPath", noRawMaterial ? "Нет подходящего сырья · data-supply request remains open" : "Strict path follows authoritative Hunter state");

  const empiricalAvailable = data.empirical?.artifact_contract === "EMPIRICAL_DISCOVERY_RUNTIME_STATE_V1";
  setStatus("rfv4EmpiricalStatus", empiricalAvailable ? "WAITING" : "ERROR");
  setText("rfv4EmpiricalStatus", empiricalAvailable ? String(data.empirical.phase || "STATE AVAILABLE").replaceAll("_", " ") : "NO STATE");
  setText("rfv4EmpiricalLead", empiricalAvailable ? count(data.empirical.predeclared_tests) : "—");
  setText("rfv4EmpiricalSummary", empiricalAvailable
    ? `${count(data.empirical.completed_tests)} completed · ${count(data.empirical.forward_confirmations_active)} forward confirmations · research only`
    : "Нет authoritative state; no values are inferred.");
  const atlasAvailable = Boolean(data.atlas?.artifact_contract);
  setStatus("rfv4AtlasStatus", atlasAvailable ? "WAITING" : "ERROR");
  setText("rfv4AtlasStatus", atlasAvailable ? "BLOCKED" : "NO STATE");
  setText("rfv4AtlasLead", atlasAvailable ? String(data.atlas.blocking_scope || "—").replaceAll("_", " ") : "—");
  setText("rfv4AtlasSummary", atlasAvailable
    ? `${String(data.atlas.verdict || "Not available").replaceAll("_", " ")} · ${dateLabel(data.atlas.generated_at)}`
    : "Нет authoritative Atlas readiness state.");

  setText("rfv4FeedbackLead", String(prediction.fastest_feedback_loop || "Not available").replaceAll("_", " "));
  setText("rfv4Next1d", nextResolution);
  setText("rfv4Next5d", "After 5 eligible sessions");
  setText("rfv4Next20d", "After 20 eligible sessions");
  setText("rfv4ServerRobot", factory.server_execution?.active ? "ACTIVE" : "ERROR");
  setText("rfv4CodexCloud", "Not available");
  setText("rfv4LocalOnly", "Gemini / auth");
  setText("rfv4OperationalMix", String(factory.workload_mix_target?.current_measured_mix || "Not available").replaceAll("_", " "));

  renderPerformance(activePerformanceView, data);
  renderModels(data);
  renderDetailViews(data);
  enhanceExplainableMetrics();
}

function setActiveTab(tab) {
  const next = byId("researchFactoryV4")?.querySelector(`[data-rfv4-pane="${tab}"]`);
  if (!next) return;
  document.querySelectorAll("[data-rfv4-tab]").forEach((button) => button.classList.toggle("active", button.dataset.rfv4Tab === tab));
  document.querySelectorAll("[data-rfv4-pane]").forEach((pane) => {
    const active = pane.dataset.rfv4Pane === tab;
    pane.hidden = !active;
    pane.classList.toggle("active", active);
  });
  byId("portal-research")?.classList.remove("rfv4-legacy-visible");
  byId("researchFactoryV4")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function enhanceExplainableMetrics() {
  const contourKeys = ["prediction", "demo", "investment", "strict"];
  document.querySelectorAll(".rfv4-contour").forEach((contour, index) => {
    const key = contourKeys[index] || "strict";
    contour.querySelectorAll(".rfv4-contour-lead, dl > div").forEach((node) => {
      node.classList.add("hpt-clickable");
      node.dataset.explain = key;
      node.tabIndex = 0;
      node.setAttribute("role", "button");
    });
  });
  const detailKeys = { prediction: "prediction", demo: "demo", investment: "investment", strict: "strict", empirical: "empirical" };
  Object.entries(detailKeys).forEach(([pane, key]) => {
    document.querySelectorAll(`[data-rfv4-pane="${pane}"] .rfv4-detail-grid > article, [data-rfv4-pane="${pane}"] .rfv4-route-grid > article`).forEach((node) => {
      node.classList.add("hpt-clickable");
      node.dataset.explain = key;
      node.tabIndex = 0;
      node.setAttribute("role", "button");
    });
  });
}

export function initResearchV4() {
  initHypothesisThroughput(() => projection(window.__researchFactoryCurrentState || {}).hypothesisThroughput);
  enhanceExplainableMetrics();
  document.querySelectorAll("[data-rfv4-tab]").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.rfv4Tab)));
  document.querySelectorAll("[data-rfv4-open]").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.rfv4Open)));
  document.querySelectorAll("[data-rfv4-performance]").forEach((button) => button.addEventListener("click", () => {
    activePerformanceView = button.dataset.rfv4Performance;
    document.querySelectorAll("[data-rfv4-performance]").forEach((row) => row.classList.toggle("active", row === button));
    const state = window.__researchFactoryCurrentState;
    if (state) renderPerformance(activePerformanceView, projection(state));
  }));
  byId("rfv4ShowLegacy")?.addEventListener("click", () => {
    byId("portal-research")?.classList.add("rfv4-legacy-visible");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  byId("rfv4Return")?.addEventListener("click", () => {
    byId("portal-research")?.classList.remove("rfv4-legacy-visible");
    setActiveTab("archive");
  });
}

export function rememberResearchV4State(state) {
  window.__researchFactoryCurrentState = state;
}
