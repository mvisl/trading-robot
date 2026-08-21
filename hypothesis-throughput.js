const PERIOD_MS = {
  "24H": 24 * 60 * 60 * 1000,
  "7D": 7 * 24 * 60 * 60 * 1000,
  "30D": 30 * 24 * 60 * 60 * 1000,
  ALL: Number.POSITIVE_INFINITY,
};

export const DEFAULT_OPERATIONAL_THRESHOLDS = Object.freeze({
  classification: "OPERATIONAL_HEURISTIC_NOT_SCIENTIFIC_GATE",
  no_activity_hours: 12,
  throughput_drop_pct: 60,
  consecutive_early_kills: 20,
  death_reason_concentration_pct: 70,
  death_reason_window: 20,
  small_denominator: 10,
});

export const REQUIRED_EVENT_FIELDS = Object.freeze([
  "hypothesis_id",
  "mechanism_family",
  "data_world",
  "created_at",
  "review_started_at",
  "review_finished_at",
  "terminal_stage",
  "terminal_status",
  "primary_death_reason",
  "D0_status",
  "D1_status",
  "screen_status",
  "formal_status",
  "last_transition_at",
]);

const FUNNEL = [
  ["Generated", "created_at"],
  ["Reviewed", "review_finished_at"],
  ["Pre-screen", "pre_screen_status"],
  ["D0", "D0_status"],
  ["D1", "D1_status"],
  ["Screen", "screen_status"],
  ["Signal", "signal_status"],
  ["Formal test", "formal_status"],
  ["Strict survivor", "survivor_status"],
];

const PASS_RE = /^(PASS|PASSED|READY|COMPLETE|COMPLETED|RUN|SURVIVOR|ACCEPTED|POSITIVE)$/i;
const CLOSED_RE = /CLOSED|KILLED|REJECTED|FAILED|TERMINAL|VERDICT/i;

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function uniqueRows(events) {
  const rows = new Map();
  for (const event of events || []) {
    if (!event?.hypothesis_id) continue;
    const previous = rows.get(event.hypothesis_id);
    if (!previous || (timestamp(event.last_transition_at) || 0) >= (timestamp(previous.last_transition_at) || 0)) {
      rows.set(event.hypothesis_id, event);
    }
  }
  return [...rows.values()];
}

function inPeriod(value, start, now) {
  const time = timestamp(value);
  return time != null && time >= start && time <= now;
}

function stageTime(row, key) {
  if (key === "created_at" || key === "review_finished_at") return row[key];
  return row.stage_timestamps?.[key] || null;
}

function passed(row, key) {
  if (key === "created_at" || key === "review_finished_at") return timestamp(row[key]) != null;
  return PASS_RE.test(String(row[key] || ""));
}

function fieldCoverage(rows, field) {
  return rows.length > 0 && rows.every((row) => Object.hasOwn(row, field));
}

function rateLabel(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function reasonRows(rows, start, now) {
  const counts = new Map();
  for (const row of rows) {
    if (!row.primary_death_reason || !inPeriod(row.last_transition_at, start, now)) continue;
    counts.set(row.primary_death_reason, (counts.get(row.primary_death_reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function reviewedDaySeries(rows, now, days = 21) {
  const result = [];
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const start = end.getTime() - offset * 86400000;
    const finish = start + 86400000;
    result.push({
      date: new Date(start).toISOString().slice(0, 10),
      count: rows.filter((row) => {
        const time = timestamp(row.review_finished_at);
        return time != null && time >= start && time < finish;
      }).length,
    });
  }
  return result;
}

function lastConsecutiveEarlyKills(rows) {
  const ordered = rows
    .filter((row) => timestamp(row.last_transition_at) != null)
    .sort((a, b) => timestamp(b.last_transition_at) - timestamp(a.last_transition_at));
  let count = 0;
  for (const row of ordered) {
    const early = row.primary_death_reason && !passed(row, "D0_status");
    if (!early) break;
    count += 1;
  }
  return count;
}

function conversionMetric(numerator, denominator, threshold) {
  if (numerator == null || denominator == null) return { numerator: null, denominator: null, display: null };
  return {
    numerator,
    denominator,
    display: denominator < threshold || denominator === 0
      ? `${numerator}/${denominator}`
      : `${Math.round((numerator / denominator) * 100)}%`,
  };
}

function deriveHunter({ rows, reviewed24h, telemetryComplete, operationalState, now, thresholds }) {
  if (!telemetryComplete) {
    return { status: "UNKNOWN", detail: "Formal review activity telemetry unavailable", tone: "missing" };
  }
  if (reviewed24h > 0) return { status: "ACTIVE", detail: `${reviewed24h} formally reviewed / 24h`, tone: "active" };
  if (operationalState?.block_reason) return { status: "BLOCKED", detail: operationalState.block_reason, tone: "blocked" };
  if (operationalState?.resource_floor_delivered === false) {
    return { status: "STARVED", detail: "Resource floor not delivered", tone: "starved" };
  }
  const lastReview = Math.max(...rows.map((row) => timestamp(row.review_finished_at) || 0));
  const idleHours = lastReview > 0 ? Math.max(0, (now - lastReview) / 3600000) : null;
  return {
    status: "IDLE",
    detail: idleHours == null ? "No formally reviewed hypothesis recorded" : `0 reviewed / ${Math.round(idleHours * 10) / 10}h`,
    tone: idleHours != null && idleHours >= thresholds.no_activity_hours ? "idle" : "waiting",
  };
}

export function deriveHypothesisThroughput(snapshot = {}, options = {}) {
  const now = timestamp(options.now || snapshot.generated_at) || Date.now();
  const period = PERIOD_MS[options.period] ? options.period : "7D";
  const periodStart = period === "ALL" ? Number.NEGATIVE_INFINITY : now - PERIOD_MS[period];
  const thresholds = { ...DEFAULT_OPERATIONAL_THRESHOLDS, ...(snapshot.thresholds || {}), ...(options.thresholds || {}) };
  const rows = uniqueRows(snapshot.events || []);
  const declaredMissing = new Set(snapshot.coverage?.missing_fields || []);
  const requiredCoverage = Object.fromEntries(REQUIRED_EVENT_FIELDS.map((field) => [
    field,
    !declaredMissing.has(field) && fieldCoverage(rows, field),
  ]));
  const reviewCoverage = requiredCoverage.hypothesis_id && requiredCoverage.review_finished_at;
  const deathCoverage = requiredCoverage.primary_death_reason && requiredCoverage.last_transition_at;
  const stageTimestampCoverage = rows.length > 0 && rows.every((row) => row.stage_timestamps && typeof row.stage_timestamps === "object");
  const reviewed = reviewCoverage ? rows.filter((row) => inPeriod(row.review_finished_at, periodStart, now)).length : null;
  const reviewed24h = reviewCoverage ? rows.filter((row) => inPeriod(row.review_finished_at, now - PERIOD_MS["24H"], now)).length : null;
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const reviewedToday = reviewCoverage ? rows.filter((row) => inPeriod(row.review_finished_at, todayStart.getTime(), now)).length : null;
  const reviewed7d = reviewCoverage ? rows.filter((row) => inPeriod(row.review_finished_at, now - PERIOD_MS["7D"], now)).length : null;
  const totalReviewed = reviewCoverage ? rows.filter((row) => timestamp(row.review_finished_at) != null).length : null;
  const lastReviewAt = reviewCoverage
    ? rows.map((row) => timestamp(row.review_finished_at)).filter(Number.isFinite).sort((a, b) => b - a)[0] || null
    : null;

  const funnel = FUNNEL.map(([label, key]) => {
    const covered = key === "created_at" || key === "review_finished_at"
      ? requiredCoverage[key]
      : rows.length > 0 && fieldCoverage(rows, key);
    const total = covered ? rows.filter((row) => passed(row, key)).length : null;
    const selected = covered && (key === "created_at" || key === "review_finished_at" || stageTimestampCoverage)
      ? rows.filter((row) => passed(row, key) && inPeriod(stageTime(row, key), periodStart, now)).length
      : null;
    return { label, key, selected, total, covered, period_covered: selected != null };
  });
  const funnelByKey = Object.fromEntries(funnel.map((row) => [row.key, row]));
  const conversions = [
    ["Reviewed → D0", "D0_status", "review_finished_at"],
    ["D0 → D1", "D1_status", "D0_status"],
    ["D1 → Screen", "screen_status", "D1_status"],
    ["Screen → Signal", "signal_status", "screen_status"],
    ["Signal → Formal survivor", "survivor_status", "signal_status"],
  ].map(([label, numeratorKey, denominatorKey]) => ({
    label,
    ...conversionMetric(funnelByKey[numeratorKey]?.selected, funnelByKey[denominatorKey]?.selected, thresholds.small_denominator),
  }));

  const closedRows = rows.filter((row) => CLOSED_RE.test(String(row.terminal_status || "")));
  const periodClosed = requiredCoverage.terminal_status && requiredCoverage.last_transition_at
    ? closedRows.filter((row) => inPeriod(row.last_transition_at, periodStart, now)).length
    : null;
  const periodKills = deathCoverage
    ? rows.filter((row) => row.primary_death_reason && inPeriod(row.last_transition_at, periodStart, now)).length
    : null;
  const deathReasons = deathCoverage ? reasonRows(rows, periodStart, now) : null;
  const timeCoverage = requiredCoverage.review_started_at && requiredCoverage.review_finished_at && stageTimestampCoverage;
  const earlyKillHours = rows.filter((row) => row.primary_death_reason).map((row) => {
    const start = timestamp(row.review_started_at); const end = timestamp(row.last_transition_at);
    return start != null && end != null ? (end - start) / 3600000 : null;
  });
  const stageHours = (stage) => rows.map((row) => {
    const start = timestamp(row.review_started_at); const end = timestamp(row.stage_timestamps?.[stage]);
    return start != null && end != null ? (end - start) / 3600000 : null;
  });
  const activeRows = rows.filter((row) => !CLOSED_RE.test(String(row.terminal_status || "")));
  const oldestActiveHours = requiredCoverage.created_at && requiredCoverage.terminal_status && activeRows.length
    ? Math.max(...activeRows.map((row) => (now - timestamp(row.created_at)) / 3600000).filter(Number.isFinite))
    : null;
  const runnableIdle = snapshot.operational_state?.runnable_idle_hours_24h;
  const hunter = deriveHunter({ rows, reviewed24h, telemetryComplete: reviewCoverage, operationalState: snapshot.operational_state, now, thresholds });

  const alerts = [];
  if (!reviewCoverage) alerts.push({ tone: "missing", text: "FORMAL REVIEW TELEMETRY MISSING" });
  if (reviewCoverage && reviewed24h === 0 && (lastReviewAt == null || (now - lastReviewAt) / 3600000 >= thresholds.no_activity_hours)) {
    alerts.push({ tone: "critical", text: `NO HYPOTHESES REVIEWED FOR ${thresholds.no_activity_hours}H` });
  }
  const current7d = reviewed7d;
  const prior7d = reviewCoverage ? rows.filter((row) => inPeriod(row.review_finished_at, now - 14 * 86400000, now - 7 * 86400000)).length : null;
  const dropPct = current7d != null && prior7d > 0 ? ((prior7d - current7d) / prior7d) * 100 : null;
  if (dropPct != null && dropPct >= thresholds.throughput_drop_pct) alerts.push({ tone: "warning", text: `7D THROUGHPUT DOWN ${Math.round(dropPct)}%` });
  if (reviewCoverage && reviewed24h === 0 && snapshot.operational_state?.resource_floor_active === true) {
    alerts.push({ tone: "critical", text: "STRICT RESOURCE FLOOR ACTIVE BUT THROUGHPUT = 0" });
  }
  const consecutiveEarlyKills = deathCoverage ? lastConsecutiveEarlyKills(rows) : null;
  if (consecutiveEarlyKills != null && consecutiveEarlyKills >= thresholds.consecutive_early_kills) {
    alerts.push({ tone: "warning", text: `${consecutiveEarlyKills} CONSECUTIVE EARLY KILLS — REVIEW GENERATOR` });
  }
  const lastReasons = deathCoverage
    ? rows.filter((row) => row.primary_death_reason).sort((a, b) => timestamp(b.last_transition_at) - timestamp(a.last_transition_at)).slice(0, thresholds.death_reason_window)
    : [];
  const reasonCounts = reasonRows(lastReasons, Number.NEGATIVE_INFINITY, now);
  if (lastReasons.length >= thresholds.death_reason_window && reasonCounts[0]) {
    const concentration = (reasonCounts[0].count / lastReasons.length) * 100;
    if (concentration > thresholds.death_reason_concentration_pct) {
      alerts.push({ tone: "warning", text: `SAME DEATH REASON ${Math.round(concentration)}% OF LAST ${lastReasons.length} — ${reasonCounts[0].reason}` });
    }
  }

  return {
    period,
    generated_at: new Date(now).toISOString(),
    review_coverage: reviewCoverage,
    death_coverage: deathCoverage,
    time_coverage: timeCoverage,
    required_coverage: requiredCoverage,
    missing_fields: REQUIRED_EVENT_FIELDS.filter((field) => !requiredCoverage[field]),
    stage_timestamp_coverage: stageTimestampCoverage,
    reviewed,
    reviewed_today: reviewedToday,
    reviewed_24h: reviewed24h,
    seven_day_average: reviewed7d == null ? null : rateLabel(reviewed7d / 7),
    total_reviewed: totalReviewed,
    total_closed: requiredCoverage.terminal_status ? closedRows.length : null,
    period_closed: periodClosed,
    period_kills: periodKills,
    last_review_at: lastReviewAt ? new Date(lastReviewAt).toISOString() : null,
    funnel,
    conversions,
    death_reasons: deathReasons,
    trend: reviewCoverage ? reviewedDaySeries(rows, now) : null,
    hunter,
    alerts,
    thresholds,
    time_metrics: {
      median_early_kill_hours: timeCoverage ? median(earlyKillHours) : null,
      median_d0_hours: timeCoverage ? median(stageHours("D0_status")) : null,
      median_screen_hours: timeCoverage ? median(stageHours("screen_status")) : null,
      oldest_active_hours: oldestActiveHours,
      runnable_idle_hours_24h: Number.isFinite(Number(runnableIdle)) ? Number(runnableIdle) : null,
    },
    experience: {
      total_closed: requiredCoverage.terminal_status ? closedRows.length : null,
      total_early_kills: deathCoverage ? rows.filter((row) => row.primary_death_reason && !passed(row, "D0_status")).length : null,
      total_screens: funnelByKey.screen_status?.total ?? null,
      total_formal_verdicts: rows.length && fieldCoverage(rows, "formal_status") ? rows.filter((row) => row.formal_status).length : null,
      total_survivors: funnelByKey.survivor_status?.total ?? null,
      unique_mechanism_families: requiredCoverage.mechanism_family ? new Set(rows.map((row) => row.mechanism_family).filter(Boolean)).size : null,
      unique_data_worlds: requiredCoverage.data_world ? new Set(rows.map((row) => row.data_world).filter(Boolean)).size : null,
    },
    historical_partial: snapshot.historical_partial || null,
  };
}

function fixtureEvent(id, now, hoursAgo, reason = null, stages = {}) {
  const at = (hours) => new Date(now - hours * 3600000).toISOString();
  const reviewedAt = at(hoursAgo);
  const passedStages = { pre_screen_status: "PASSED", D0_status: "PASSED", ...stages };
  const terminalStatus = reason ? "TERMINALLY_CLOSED" : "ACTIVE";
  return {
    hypothesis_id: id,
    mechanism_family: `FAMILY_${Number(id.match(/\d+/)?.[0] || 0) % 7}`,
    data_world: reason?.includes("PIT") ? "DATA_WORLD_PIT" : "DATA_WORLD_MAIN",
    created_at: at(hoursAgo + 2),
    review_started_at: at(hoursAgo + 1),
    review_finished_at: reviewedAt,
    terminal_stage: reason ? "D0" : "D1",
    terminal_status: terminalStatus,
    primary_death_reason: reason,
    D0_status: passedStages.D0_status || "NOT_REACHED",
    D1_status: passedStages.D1_status || "NOT_REACHED",
    screen_status: passedStages.screen_status || "NOT_REACHED",
    formal_status: passedStages.formal_status || "NOT_REACHED",
    pre_screen_status: passedStages.pre_screen_status || "NOT_REACHED",
    signal_status: passedStages.signal_status || "NOT_REACHED",
    survivor_status: passedStages.survivor_status || "NOT_REACHED",
    last_transition_at: reviewedAt,
    stage_timestamps: {
      pre_screen_status: at(hoursAgo + 0.8),
      D0_status: passedStages.D0_status === "PASSED" ? at(hoursAgo + 0.6) : null,
      D1_status: passedStages.D1_status === "PASSED" ? at(hoursAgo + 0.4) : null,
      screen_status: passedStages.screen_status === "PASSED" ? at(hoursAgo + 0.3) : null,
      signal_status: passedStages.signal_status === "PASSED" ? at(hoursAgo + 0.2) : null,
      formal_status: passedStages.formal_status === "COMPLETED" ? at(hoursAgo + 0.1) : null,
      survivor_status: passedStages.survivor_status === "SURVIVOR" ? reviewedAt : null,
    },
  };
}

export function hypothesisThroughputFixture(name, now = Date.now()) {
  const key = String(name || "").toUpperCase();
  if (!/[ABC]/.test(key)) return null;
  let events = [];
  let operational_state = { timer_active: true, resource_floor_active: true, resource_floor_delivered: true, runnable_idle_hours_24h: 0 };
  if (key === "A") {
    events = Array.from({ length: 15 }, (_, i) => fixtureEvent(`A-${i + 1}`, now, i + 1, i < 13 ? `EARLY_FILTER_${i % 4}` : null, i < 13 ? { D0_status: "NOT_REACHED" } : { D1_status: "PASSED" }));
  } else if (key === "B") {
    events = [fixtureEvent("B-1", now, 31, "DATA_UNAVAILABLE", { D0_status: "NOT_REACHED" })];
    operational_state = { timer_active: true, resource_floor_active: true, resource_floor_delivered: false, runnable_idle_hours_24h: 24 };
  } else {
    events = Array.from({ length: 20 }, (_, i) => fixtureEvent(`C-${i + 1}`, now, i + 1, i < 18 ? "DATA_PIT_LINEAGE" : "OTHER_BLOCKER", { D0_status: "NOT_REACHED" }));
  }
  return {
    generated_at: new Date(now).toISOString(),
    events,
    operational_state,
    thresholds: DEFAULT_OPERATIONAL_THRESHOLDS,
    fixture: key,
  };
}

function displayNumber(value, suffix = "") {
  return value == null ? "MISSING TELEMETRY" : `${value}${suffix}`;
}

function ageLabel(value, now) {
  const time = timestamp(value);
  if (time == null) return "MISSING TELEMETRY";
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function durationLabel(value) {
  if (value == null) return "MISSING";
  if (value < 1) return `${Math.round(value * 60)}m`;
  return `${Math.round(value * 10) / 10}h`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function set(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function renderTrend(rows) {
  if (!rows) return '<div class="hpt-missing-inline">MISSING TELEMETRY · review_finished_at</div>';
  const max = Math.max(1, ...rows.map((row) => row.count));
  return rows.map((row) => `<i title="${escapeHtml(row.date)} · ${row.count}" style="height:${Math.max(3, Math.round((row.count / max) * 100))}%"></i>`).join("");
}

function renderReasonRows(rows) {
  if (!rows) return '<p class="hpt-missing-inline">MISSING TELEMETRY · primary_death_reason, last_transition_at</p>';
  if (!rows.length) return '<p class="hpt-empty">No deaths in selected period</p>';
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return rows.slice(0, 5).map((row) => `<li><span>${escapeHtml(row.reason.replaceAll("_", " "))}</span><strong>${total < 10 ? row.count : `${Math.round((row.count / total) * 100)}%`}</strong></li>`).join("");
}

export function renderHypothesisThroughput(snapshot, options = {}) {
  const root = document.getElementById("hypothesisFactoryThroughput");
  if (!root) return null;
  const fixtureName = new URLSearchParams(window.location.search).get("throughputFixture");
  const fixture = hypothesisThroughputFixture(fixtureName);
  const source = fixture || snapshot || {};
  const model = deriveHypothesisThroughput(source, { period: options.period || root.dataset.period || "7D" });
  root.dataset.period = model.period;
  root.classList.toggle("hpt-zero", model.review_coverage && model.reviewed_24h === 0);
  root.classList.toggle("hpt-missing", !model.review_coverage);
  const badge = document.getElementById("hptFixtureBadge");
  if (badge) { badge.hidden = !fixture; badge.textContent = fixture ? `TEST STATE ${fixture.fixture} · NOT PRODUCTION` : ""; }
  set("hptToday", displayNumber(model.reviewed_today));
  set("hptRate24h", model.reviewed_24h == null ? "MISSING TELEMETRY" : `${model.reviewed_24h} / day`);
  set("hptTotalReviewed", displayNumber(model.total_reviewed));
  set("hptLastActivity", ageLabel(model.last_review_at, timestamp(model.generated_at)));
  set("hpt7dAverage", model.seven_day_average == null ? "MISSING" : `${model.seven_day_average} / day`);
  set("hptSelectedReviewed", displayNumber(model.reviewed));
  set("hptSelectedKills", displayNumber(model.period_kills));
  set("hptHunterStatus", model.hunter.status);
  set("hptHunterDetail", model.hunter.detail);
  const hunter = document.getElementById("hptHunter");
  if (hunter) hunter.dataset.tone = model.hunter.tone;
  const alertList = document.getElementById("hptAlerts");
  if (alertList) alertList.innerHTML = model.alerts.map((row) => `<li data-tone="${escapeHtml(row.tone)}">⚠ ${escapeHtml(row.text)}</li>`).join("") || '<li data-tone="clear">No material operational alert</li>';
  const funnel = document.getElementById("hptFunnel");
  if (funnel) funnel.innerHTML = model.funnel.map((row) => `<li class="${row.period_covered ? "" : "missing"}"><span>${escapeHtml(row.label)}</span><strong>${row.selected == null ? "—" : row.selected} <em>/ ${row.total == null ? "—" : row.total}</em></strong></li>`).join("");
  const trend = document.getElementById("hptTrend");
  if (trend) trend.innerHTML = renderTrend(model.trend);
  const reasons = document.getElementById("hptDeathReasons");
  if (reasons) reasons.innerHTML = renderReasonRows(model.death_reasons);
  const topReason = model.death_reasons?.[0];
  set("hptTopReason", topReason ? `${topReason.reason.replaceAll("_", " ")} · ${topReason.count}` : model.death_reasons ? "No deaths" : "MISSING TELEMETRY");
  const conversions = document.getElementById("hptConversions");
  if (conversions) conversions.innerHTML = model.conversions.map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.display || "MISSING")}</dd></div>`).join("");
  const timeMetrics = document.getElementById("hptTimeMetrics");
  if (timeMetrics) timeMetrics.innerHTML = [
    ["Median time to early kill", durationLabel(model.time_metrics.median_early_kill_hours)],
    ["Median time to D0", durationLabel(model.time_metrics.median_d0_hours)],
    ["Median time to screen", durationLabel(model.time_metrics.median_screen_hours)],
    ["Oldest active hypothesis", durationLabel(model.time_metrics.oldest_active_hours)],
    ["Runnable idle", model.time_metrics.runnable_idle_hours_24h == null ? "MISSING" : `${durationLabel(model.time_metrics.runnable_idle_hours_24h)} / 24h`],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  const experience = document.getElementById("hptExperience");
  if (experience) experience.innerHTML = [
    ["Total hypotheses closed", model.experience.total_closed],
    ["Total early kills", model.experience.total_early_kills],
    ["Total screens", model.experience.total_screens],
    ["Total formal verdicts", model.experience.total_formal_verdicts],
    ["Total survivors", model.experience.total_survivors],
    ["Unique mechanism families", model.experience.unique_mechanism_families],
    ["Unique data worlds", model.experience.unique_data_worlds],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value == null ? "MISSING" : escapeHtml(value)}</dd></div>`).join("");
  const missing = document.getElementById("hptMissingFields");
  if (missing) missing.textContent = model.missing_fields.length ? model.missing_fields.join(" · ") : "Complete required event coverage";
  const partial = model.historical_partial;
  set("hptHistoricalCoverage", partial
    ? `${partial.unique_hypothesis_records ?? "—"} registry hypotheses · ${partial.terminal_records ?? "—"} terminal flags · ${partial.unique_mechanism_families ?? "—"} families · snapshot ${partial.coverage_from || "unknown"}. Not counted as formal reviews.`
    : "No separately labeled historical partial registry snapshot available.");
  document.querySelectorAll("[data-hpt-period]").forEach((button) => button.classList.toggle("active", button.dataset.hptPeriod === model.period));
  return model;
}

export function initHypothesisThroughput(getSnapshot) {
  document.querySelectorAll("[data-hpt-period]").forEach((button) => button.addEventListener("click", () => {
    const root = document.getElementById("hypothesisFactoryThroughput");
    if (root) root.dataset.period = button.dataset.hptPeriod;
    renderHypothesisThroughput(getSnapshot?.(), { period: button.dataset.hptPeriod });
  }));
}
