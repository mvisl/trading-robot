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

function numeric(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  const declared = String(operationalState?.hunter_status || "").replace(/_EXTERNAL_BOUNDARY$/, "");
  const runnable = Number(operationalState?.runnable_jobs || 0) + Number(operationalState?.runnable_hypothesis_evaluations || 0);
  if (reviewed24h === 0 && runnable > 0) {
    return { status: "STARVED", label: "Простаивает при наличии работы", detail: `${runnable} runnable jobs · 0 reviewed / 24h`, tone: "starved" };
  }
  if (declared === "NO_RAW_MATERIAL") {
    return { status: "NO_RAW_MATERIAL", label: "Нет подходящего сырья", detail: operationalState?.hunter_status_reason || "Нет честно проверяемого кандидата", tone: "no-raw-material" };
  }
  if (declared === "LEGITIMATELY_IDLE" || operationalState?.legitimate_idle === true) {
    return { status: "LEGITIMATELY_IDLE", label: "Нет разрешённой работы", detail: operationalState?.hunter_status_reason || "Нет разрешённой runnable work", tone: "legitimate-idle" };
  }
  if (declared === "BLOCKED" || operationalState?.block_reason) {
    return { status: "BLOCKED", label: "Заблокирован", detail: operationalState?.block_reason || operationalState?.hunter_status_reason, tone: "blocked" };
  }
  if (!telemetryComplete) {
    return { status: "UNKNOWN", label: "Нет данных", detail: "Нет operational telemetry", tone: "missing" };
  }
  if (reviewed24h > 0) return { status: "ACTIVE", label: "Работает", detail: `${reviewed24h} formally reviewed / 24h`, tone: "active" };
  const lastReview = Math.max(...rows.map((row) => timestamp(row.review_finished_at) || 0));
  const idleHours = lastReview > 0 ? Math.max(0, (now - lastReview) / 3600000) : null;
  return {
    status: "LEGITIMATELY_IDLE",
    label: "Нет разрешённой работы",
    detail: idleHours == null ? "Нет точного времени последнего review" : `0 reviewed / ${Math.round(idleHours * 10) / 10}h`,
    tone: idleHours != null && idleHours >= thresholds.no_activity_hours ? "idle" : "waiting",
  };
}

export function deriveHypothesisThroughput(snapshot = {}, options = {}) {
  const now = timestamp(options.now || snapshot.generated_at) || Date.now();
  const period = PERIOD_MS[options.period] ? options.period : "24H";
  const periodStart = period === "ALL" ? Number.NEGATIVE_INFINITY : now - PERIOD_MS[period];
  const thresholds = { ...DEFAULT_OPERATIONAL_THRESHOLDS, ...(snapshot.thresholds || {}), ...(options.thresholds || {}) };
  const rows = uniqueRows(snapshot.events || []);
  const totals = snapshot.authoritative_totals || {};
  const hasAuthoritativeTotals = snapshot.authoritative_totals != null;
  const window = snapshot.window_metrics?.[period] || {};
  const window24h = snapshot.window_metrics?.["24H"] || {};
  const window7d = snapshot.window_metrics?.["7D"] || {};
  const declaredMissing = new Set(snapshot.coverage?.missing_fields || []);
  const nonNullCounts = snapshot.coverage?.field_non_null_counts || {};
  const requiredCoverage = Object.fromEntries(REQUIRED_EVENT_FIELDS.map((field) => [
    field,
    !declaredMissing.has(field) && (Number(nonNullCounts[field]) > 0 || fieldCoverage(rows, field)),
  ]));
  const reviewCoverage = numeric(totals.reviewed) != null || numeric(window.reviewed) != null || (requiredCoverage.hypothesis_id && requiredCoverage.review_finished_at);
  const deathCoverage = requiredCoverage.primary_death_reason && requiredCoverage.last_transition_at;
  const stageTimestampCoverage = rows.length > 0 && rows.every((row) => row.stage_timestamps && typeof row.stage_timestamps === "object");
  const reviewed = numeric(window.reviewed) != null
    ? numeric(window.reviewed)
    : requiredCoverage.review_finished_at ? rows.filter((row) => inPeriod(row.review_finished_at, periodStart, now)).length : null;
  const reviewed24h = numeric(window24h.reviewed) != null
    ? numeric(window24h.reviewed)
    : requiredCoverage.review_finished_at ? rows.filter((row) => inPeriod(row.review_finished_at, now - PERIOD_MS["24H"], now)).length : null;
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const fullReviewTimestampCoverage = rows.length > 0 && (Object.hasOwn(nonNullCounts, "review_finished_at")
    ? Number(nonNullCounts.review_finished_at) === rows.length
    : rows.every((row) => timestamp(row.review_finished_at) != null));
  const reviewedToday = fullReviewTimestampCoverage ? rows.filter((row) => inPeriod(row.review_finished_at, todayStart.getTime(), now)).length : null;
  const reviewed7d = numeric(window7d.reviewed) != null
    ? numeric(window7d.reviewed)
    : fullReviewTimestampCoverage ? rows.filter((row) => inPeriod(row.review_finished_at, now - PERIOD_MS["7D"], now)).length : null;
  const totalReviewed = numeric(totals.reviewed) ?? (fullReviewTimestampCoverage ? rows.length : null);
  const lastReviewAt = fullReviewTimestampCoverage
    ? rows.map((row) => timestamp(row.review_finished_at)).filter(Number.isFinite).sort((a, b) => b - a)[0] || null
    : null;

  const totalByKey = {
    created_at: totals.generated,
    review_finished_at: totals.reviewed,
    pre_screen_status: totals.pre_screen,
    D0_status: totals.D0,
    D1_status: totals.D1,
    screen_status: totals.screens,
    signal_status: totals.signals,
    formal_status: totals.formal_tests,
    survivor_status: totals.survivors,
  };
  const selectedByKey = {
    created_at: window.stage_counts?.generated,
    review_finished_at: window.stage_counts?.reviewed ?? window.reviewed,
    pre_screen_status: window.stage_counts?.pre_screen,
    D0_status: window.stage_counts?.D0,
    D1_status: window.stage_counts?.D1,
    screen_status: window.stage_counts?.screen,
    signal_status: window.stage_counts?.signal,
    formal_status: window.stage_counts?.formal,
    survivor_status: window.stage_counts?.survivor,
  };

  const funnel = FUNNEL.map(([label, key]) => {
    const rowCovered = key === "created_at" || key === "review_finished_at"
      ? requiredCoverage[key]
      : rows.length > 0 && fieldCoverage(rows, key);
    const total = numeric(totalByKey[key]) ?? (!hasAuthoritativeTotals && rowCovered ? rows.filter((row) => passed(row, key)).length : null);
    const selected = numeric(selectedByKey[key]) ?? (!snapshot.window_metrics && rowCovered && (key === "created_at" || key === "review_finished_at" || stageTimestampCoverage)
      ? rows.filter((row) => passed(row, key) && inPeriod(stageTime(row, key), periodStart, now)).length
      : null);
    const covered = total != null;
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
  const periodClosed = null;
  const periodKills = reviewed === 0 ? 0 : period === "ALL" ? numeric(totals.early_kills) : null;
  const deathReasons = period === "ALL"
    ? (snapshot.death_reasons_total || []).slice().sort((a, b) => b.count - a.count)
    : reviewed === 0 ? [] : deathCoverage ? reasonRows(rows, periodStart, now) : null;
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
  const historicalPartial = (snapshot.coverage?.partial_fields || []).length > 0
    || (snapshot.coverage?.missing_fields || []).length > 0
    || (!snapshot.authoritative_totals && rows.length === 0);
  if (historicalPartial) alerts.push({ tone: "partial", text: "Часть исторической телеметрии недоступна" });
  const current7d = reviewed7d;
  const prior7d = fullReviewTimestampCoverage ? rows.filter((row) => inPeriod(row.review_finished_at, now - 14 * 86400000, now - 7 * 86400000)).length : null;
  const dropPct = current7d != null && prior7d > 0 ? ((prior7d - current7d) / prior7d) * 100 : null;
  if (dropPct != null && dropPct >= thresholds.throughput_drop_pct) alerts.push({ tone: "warning", text: `7D THROUGHPUT DOWN ${Math.round(dropPct)}%` });
  const runnableWork = Number(snapshot.operational_state?.runnable_jobs || 0) + Number(snapshot.operational_state?.runnable_hypothesis_evaluations || 0);
  if (reviewCoverage && reviewed24h === 0 && runnableWork > 0) {
    alerts.push({ tone: "critical", text: "RUNNABLE WORK EXISTS BUT THROUGHPUT = 0" });
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
    total_closed: numeric(totals.closed),
    period_closed: periodClosed,
    period_kills: periodKills,
    last_review_at: lastReviewAt ? new Date(lastReviewAt).toISOString() : null,
    funnel,
    conversions,
    death_reasons: deathReasons,
    trend: fullReviewTimestampCoverage ? reviewedDaySeries(rows, now) : null,
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
      total_closed: numeric(totals.closed),
      total_early_kills: numeric(totals.early_kills) ?? (!hasAuthoritativeTotals ? rows.filter((row) => row.primary_death_reason && !passed(row, "D0_status")).length : null),
      total_screens: numeric(totals.screens) ?? (!hasAuthoritativeTotals ? funnelByKey.screen_status?.total ?? null : null),
      total_formal_verdicts: numeric(totals.formal_tests) ?? (!hasAuthoritativeTotals ? funnelByKey.formal_status?.total ?? null : null),
      total_survivors: numeric(totals.survivors) ?? (!hasAuthoritativeTotals ? funnelByKey.survivor_status?.total ?? null : null),
      unique_mechanism_families: numeric(totals.unique_mechanism_families) ?? (!hasAuthoritativeTotals ? new Set(rows.map((row) => row.mechanism_family).filter(Boolean)).size : null),
      unique_data_worlds: numeric(totals.unique_data_worlds) ?? (!hasAuthoritativeTotals ? new Set(rows.map((row) => row.data_world).filter(Boolean)).size : null),
    },
    historical_partial: snapshot.historical_partial || null,
    state_transitions: window.state_transitions ?? null,
    zero_transition_hours: window.zero_transition_hours ?? null,
    sources: snapshot.live_sources || [],
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
  if (!["A", "B", "C"].includes(key)) return null;
  let events = [];
  let operational_state = { timer_active: true, resource_floor_active: true, resource_floor_delivered: true, runnable_idle_hours_24h: 0 };
  let authoritative_totals = null;
  let window_metrics = null;
  if (key === "A") {
    events = Array.from({ length: 44 }, (_, i) => ({
      ...fixtureEvent(`A-${i + 1}`, now, 48 + i, i < 10 ? `EARLY_FILTER_${i % 4}` : null, { D0_status: i === 10 ? "PASSED" : "NOT_REACHED" }),
      created_at: null,
      review_started_at: null,
      review_finished_at: null,
      last_transition_at: null,
      stage_timestamps: null,
    }));
    authoritative_totals = { reviewed: 44, evidence_backed: 44, normalized: 44, early_kills: 10, D0: 1, D1: 1, screens: 4, signals: 0, formal_tests: 1, survivors: 0 };
    window_metrics = { "24H": { reviewed: 0, state_transitions: 0, zero_transition_hours: 24, stage_counts: { reviewed: 0, pre_screen: 0, D0: 0, D1: 0, screen: 0, signal: 0, formal: 0, survivor: 0 } }, "7D": { reviewed: 0 }, "30D": { reviewed: null }, ALL: { reviewed: 44 } };
    operational_state = { timer_active: true, hunter_status: "NO_RAW_MATERIAL", hunter_status_reason: "No eligible candidate survives current strict data requirements.", legitimate_idle: true, runnable_jobs: 0, runnable_hypothesis_evaluations: 0, open_supply_requests: 1, runnable_idle_hours_24h: 0 };
  } else if (key === "B") {
    events = Array.from({ length: 15 }, (_, i) => fixtureEvent(`B-${i + 1}`, now, i + 1, i < 13 ? `EARLY_FILTER_${i % 4}` : null, i < 13 ? { D0_status: "NOT_REACHED" } : { D1_status: "PASSED" }));
  } else {
    events = [fixtureEvent("C-1", now, 31, "DATA_UNAVAILABLE", { D0_status: "NOT_REACHED" })];
    operational_state = { timer_active: true, runnable_jobs: 3, runnable_hypothesis_evaluations: 0, resource_floor_active: true, resource_floor_delivered: true, runnable_idle_hours_24h: 24 };
  }
  return {
    generated_at: new Date(now).toISOString(),
    events,
    operational_state,
    authoritative_totals,
    window_metrics,
    thresholds: DEFAULT_OPERATIONAL_THRESHOLDS,
    fixture: key,
  };
}

function displayNumber(value, suffix = "") {
  return value == null ? "—" : `${value}${suffix}`;
}

function ageLabel(value, now) {
  const time = timestamp(value);
  if (time == null) return "—";
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function durationLabel(value) {
  if (value == null) return "Нет данных";
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

const EXPLANATIONS = {
  throughput: { title: "Скорость проверки гипотез", what: "Количество уникальных гипотез, реально получивших формальную оценку за последние 24 часа. ИИ-отчёты и просто просмотренные идеи не считаются.", why: "Так видно, перерабатывает ли фабрика реальные кандидаты, а не только создаёт документы.", source: "NO_IDLE_TELEMETRY_V0" },
  today: { title: "Проверено сегодня", what: "Число формальных оценок с начала текущего календарного дня.", why: "Помогает отличить суточный темп от активности именно сегодня.", source: "Hypothesis Experience Ledger timestamps" },
  total_reviewed: { title: "Накопленный опыт фабрики", what: "Количество evidence-backed гипотез, приведённых к одной нормализованной записи.", why: "Показывает реальный объём накопленной практики без повторного счёта отчётов.", source: "HYPOTHESIS_EXPERIENCE_LEDGER_V1" },
  last_hypothesis: { title: "Последняя формальная оценка", what: "Время с момента последнего подтверждённого завершения evaluation.", why: "Помогает быстро заметить остановку потока. Если исторического timestamp нет, интерфейс честно показывает «Нет данных».", source: "HYPOTHESIS_EXPERIENCE_LEDGER_V1" },
  created_at: { title: "Сгенерированные гипотезы", what: "Уникальные кандидаты, созданные фабрикой. Создание ещё не означает формальную проверку.", why: "Не позволяет спутать генерацию идей с реальным throughput.", source: "NO_IDLE_TELEMETRY / Experience Ledger" },
  review_finished_at: { title: "Формально рассмотренные гипотезы", what: "Уникальные гипотезы, получившие зафиксированную factory evaluation.", why: "Это основная единица работы Hunter и Strict.", source: "HYPOTHESIS_EXPERIENCE_LEDGER_V1 + NO_IDLE_TELEMETRY_V0" },
  pre_screen_status: { title: "Предварительный отсев", what: "Дешёвая проверка до расходования ресурсов на строгие стадии.", why: "Она должна быстро закрывать очевидно слабые или непроверяемые идеи.", source: "Experience Ledger stage telemetry" },
  D0_status: { title: "Первая серьёзная проверка", what: "Сюда доходят гипотезы, пережившие дешёвый предварительный отсев. Проверяется, есть ли основания тратить ресурсы на дальнейшее исследование.", why: "Если до D0 ничего не доходит, идеи могут быть слабыми, фильтр слишком жёстким или фабрика может фактически не работать.", source: "FAILURE_EXPERIENCE_TABLE_V0" },
  D1_status: { title: "Независимая проверка основания", what: "Следующий строгий шаг после D0: проверяется устойчивость основания и независимая воспроизводимость решения.", why: "Отделяет единичный удачный проход от кандидата, достойного empirical screen.", source: "FAILURE_EXPERIENCE_TABLE_V0" },
  screen_status: { title: "Быстрая эмпирическая проверка", what: "Проверяем, видно ли вообще ожидаемый эффект в данных до запуска дорогого подтверждения.", why: "Экономит время и закрывает идеи, не показывающие даже базовый наблюдаемый эффект.", source: "FAILURE_EXPERIENCE_TABLE_V0" },
  signal_status: { title: "Обнаруженный сигнал", what: "Screen показал эффект, который допускает переход к более строгому тесту.", why: "Сигнал ещё не является доказанным edge и не разрешает реальную торговлю.", source: "FAILURE_EXPERIENCE_TABLE_V0" },
  formal_status: { title: "Формальный научный тест", what: "Дорогая подтверждающая проверка с заранее зафиксированными критериями.", why: "Здесь отделяется предварительный сигнал от evidence, способного выдержать строгий verdict.", source: "FAILURE_EXPERIENCE_TABLE_V0" },
  survivor_status: { title: "Гипотеза пережила строгую проверку", what: "Редкий кандидат, прошедший весь научный контур.", why: "Это ещё не разрешение торговать реальными деньгами: capital и safety gates остаются отдельными.", source: "FAILURE_EXPERIENCE_TABLE_V0" },
  hunter: { title: "Состояние Хантера", what: "Показывает, есть ли у Strict фактическая разрешённая работа и выполняется ли она. Включённый timer сам по себе не означает ACTIVE.", why: "Так различаются честное отсутствие сырья, блокировка и простой при наличии runnable jobs.", source: "NO_IDLE_TELEMETRY_V1 + DATA_SUPPLY_QUEUE_V1" },
  death_reasons: { title: "Почему гипотезы закрываются", what: "Основные причины, по которым evidence-backed кандидаты не прошли дальше.", why: "Концентрация одной причины может указывать на проблему источников, selection policy или повторяющийся data blocker.", source: "FAILURE_EXPERIENCE_TABLE_V0" },
  zero_transitions: { title: "Часы без переходов", what: "Сколько часов не было подтверждённых переходов между состояниями фабрики.", why: "Вместе с runnable work отличает законное ожидание от скрытого простоя.", source: "NO_IDLE_TELEMETRY_V0" },
  prediction: { title: "Контур прогнозов", what: "Запечатанные прогнозы оцениваются только после наступления заранее заданного горизонта.", why: "Это самый быстрый источник OOS feedback, но до разрешения исходов метрики качества остаются pending.", source: "Prediction Factory runtime state" },
  demo: { title: "Демо-арена стратегий", what: "Paper-only сравнение моделей и baseline после одинаковых замороженных издержек.", why: "Проверяет экономический смысл сигнала без использования реального капитала.", source: "Prediction Factory paper positions" },
  investment: { title: "Средне- и долгосрочные тезисы", what: "Запечатанные инвестиционные тезисы для горизонтов от недели до месяцев.", why: "Они отделены от быстрых прогнозов и не являются рекомендацией.", source: "Investment Thesis Ledger" },
  strict: { title: "Строгий научный контур", what: "Консервативный путь от evidence-backed гипотезы до formal verdict.", why: "Он защищает от ложного edge и не смешивается с Empirical Discovery.", source: "Hypothesis Experience Ledger + Failure Experience Table" },
  empirical: { title: "Эмпирический поиск", what: "Отдельный исследовательский lane для широких predeclared empirical tests. Он не подменяет Strict.", why: "Даёт быстрый поиск закономерностей с отдельным контролем multiplicity и границами outcome access.", source: "EMPIRICAL_DISCOVERY_RUNTIME_STATE_V1" },
  atlas: { title: "Готовность Atlas и данных", what: "Показывает состояние карты механизмов, data readiness и fidelity controls.", why: "Atlas отвечает за качество пространства поиска и источников, а не за strict survivor напрямую.", source: "ATLAS_FIDELITY_WATCHDOG_VERDICT_V1" },
};

function openExplanation(trigger) {
  const dialog = document.getElementById("researchExplainDialog");
  const key = trigger?.dataset?.explain;
  const explanation = EXPLANATIONS[key];
  if (!dialog || !explanation) return;
  const liveTarget = trigger.dataset.liveTarget ? document.getElementById(trigger.dataset.liveTarget) : null;
  const live = liveTarget?.textContent?.trim() || trigger.dataset.live || trigger.innerText?.trim() || "Нет данных";
  set("researchExplainTitle", explanation.title);
  set("researchExplainWhat", explanation.what);
  set("researchExplainWhy", explanation.why);
  set("researchExplainNow", live || "Нет данных");
  set("researchExplainSource", trigger.dataset.source || explanation.source || "Нет данных");
  set("researchExplainMachine", trigger.dataset.machine || key);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function renderTrend(rows) {
  if (!rows) return '<div class="hpt-missing-inline">— · Нет полных исторических timestamps</div>';
  const max = Math.max(1, ...rows.map((row) => row.count));
  return rows.map((row) => `<i title="${escapeHtml(row.date)} · ${row.count}" style="height:${Math.max(3, Math.round((row.count / max) * 100))}%"></i>`).join("");
}

function renderReasonRows(rows) {
  if (!rows) return '<p class="hpt-missing-inline">— · Нет периодной разбивки</p>';
  if (!rows.length) return '<p class="hpt-empty">Нет смертей за выбранный период</p>';
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return rows.slice(0, 5).map((row) => `<li><span>${escapeHtml(row.reason.replaceAll("_", " "))}</span><strong>${total < 10 ? row.count : `${Math.round((row.count / total) * 100)}%`}</strong></li>`).join("");
}

export function renderHypothesisThroughput(snapshot, options = {}) {
  const root = document.getElementById("hypothesisFactoryThroughput");
  if (!root) return null;
  const fixtureName = new URLSearchParams(window.location.search).get("throughputFixture");
  const fixture = hypothesisThroughputFixture(fixtureName);
  const source = fixture || snapshot || {};
  const model = deriveHypothesisThroughput(source, { period: options.period || root.dataset.period || "24H" });
  root.dataset.period = model.period;
  root.classList.toggle("hpt-zero", model.review_coverage && model.reviewed_24h === 0 && ["STARVED", "BLOCKED"].includes(model.hunter.status));
  root.classList.toggle("hpt-no-raw", model.hunter.status === "NO_RAW_MATERIAL");
  root.classList.toggle("hpt-missing", !model.review_coverage);
  const badge = document.getElementById("hptFixtureBadge");
  if (badge) { badge.hidden = !fixture; badge.textContent = fixture ? `TEST STATE ${fixture.fixture} · NOT PRODUCTION` : ""; }
  set("hptToday", displayNumber(model.reviewed_today));
  set("hptTodayNote", model.reviewed_today == null ? "Нет данных · календарный timestamp неполный" : "UTC calendar day");
  set("hptRate24h", model.reviewed_24h == null ? "—" : `${model.reviewed_24h} / day`);
  set("hptRateNote", model.reviewed_24h == null ? "Нет данных" : "Unique hypotheses formally reviewed");
  set("hptTotalReviewed", displayNumber(model.total_reviewed));
  set("hptLastActivity", ageLabel(model.last_review_at, timestamp(model.generated_at)));
  set("hptLastNote", model.last_review_at == null ? "Нет данных · historical timestamp absent" : "Formal review finished");
  set("hpt7dAverage", model.seven_day_average == null ? "— · Нет данных" : `${model.seven_day_average} / day`);
  set("hptSelectedReviewed", displayNumber(model.reviewed));
  set("hptSelectedKills", displayNumber(model.period_kills));
  set("hptHunterStatus", model.hunter.label || model.hunter.status);
  set("hptHunterMachine", model.hunter.status);
  set("hptHunterDetail", model.hunter.detail);
  set("hptZeroTransitions", model.zero_transition_hours == null ? "—" : `${model.zero_transition_hours}h`);
  set("hptZeroTransitionsNote", model.zero_transition_hours == null ? "Нет данных для выбранного периода" : `${model.state_transitions ?? "—"} state transitions`);
  const hunter = document.getElementById("hptHunter");
  if (hunter) hunter.dataset.tone = model.hunter.tone;
  const alertList = document.getElementById("hptAlerts");
  if (alertList) alertList.innerHTML = model.alerts.map((row) => `<li data-tone="${escapeHtml(row.tone)}">${row.tone === "partial" ? "ℹ" : "⚠"} ${escapeHtml(row.text)}</li>`).join("") || '<li data-tone="clear">Нет material operational alerts</li>';
  const funnel = document.getElementById("hptFunnel");
  if (funnel) funnel.innerHTML = model.funnel.map((row, index) => {
    const previous = model.funnel[index - 1];
    const conversion = previous?.selected != null && row.selected != null
      ? `${row.selected}/${previous.selected}${previous.selected >= model.thresholds.small_denominator && previous.selected > 0 ? ` · ${Math.round((row.selected / previous.selected) * 100)}%` : ""}`
      : "Нет данных";
    return `<li class="${row.period_covered ? "" : "missing"} hpt-clickable" data-explain="${escapeHtml(row.key)}" tabindex="0" role="button"><span>${escapeHtml(row.label)}</span><strong>${row.selected == null ? "—" : row.selected} <em>/ ${row.total == null ? "—" : row.total}</em></strong><small>${index ? escapeHtml(conversion) : "period / total"}</small></li>`;
  }).join("");
  const trend = document.getElementById("hptTrend");
  if (trend) trend.innerHTML = renderTrend(model.trend);
  const reasons = document.getElementById("hptDeathReasons");
  if (reasons) reasons.innerHTML = renderReasonRows(model.death_reasons);
  const topReason = model.death_reasons?.[0];
  set("hptTopReason", topReason ? `${topReason.reason.replaceAll("_", " ")} · ${topReason.count}` : model.death_reasons ? "Нет смертей за период" : "— · Нет данных");
  const conversions = document.getElementById("hptConversions");
  if (conversions) conversions.innerHTML = model.conversions.map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.display || "Нет данных")}</dd></div>`).join("");
  const timeMetrics = document.getElementById("hptTimeMetrics");
  if (timeMetrics) timeMetrics.innerHTML = [
    ["Median time to early kill", durationLabel(model.time_metrics.median_early_kill_hours)],
    ["Median time to D0", durationLabel(model.time_metrics.median_d0_hours)],
    ["Median time to screen", durationLabel(model.time_metrics.median_screen_hours)],
    ["Oldest active hypothesis", durationLabel(model.time_metrics.oldest_active_hours)],
    ["Runnable idle", model.time_metrics.runnable_idle_hours_24h == null ? "Нет данных" : `${durationLabel(model.time_metrics.runnable_idle_hours_24h)} / 24h`],
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
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value == null ? "Нет данных" : escapeHtml(value)}</dd></div>`).join("");
  const missing = document.getElementById("hptMissingFields");
  if (missing) missing.textContent = model.missing_fields.length ? model.missing_fields.join(" · ") : "Нет полностью отсутствующих обязательных полей";
  const partial = model.historical_partial;
  set("hptHistoricalCoverage", partial
    ? `${partial.normalized_cases ?? "—"}/${partial.total_cases ?? "—"} cases normalized · timestamps: created ${partial.timestamp_coverage?.created_at ?? "—"}/${partial.timestamp_coverage?.denominator ?? "—"}, review finished ${partial.timestamp_coverage?.review_finished_at ?? "—"}/${partial.timestamp_coverage?.denominator ?? "—"}, transition ${partial.timestamp_coverage?.last_transition_at ?? "—"}/${partial.timestamp_coverage?.denominator ?? "—"}.`
    : "Нет данных об историческом покрытии.");
  document.querySelectorAll("[data-hpt-period]").forEach((button) => button.classList.toggle("active", button.dataset.hptPeriod === model.period));
  return model;
}

export function initHypothesisThroughput(getSnapshot) {
  document.querySelectorAll("[data-hpt-period]").forEach((button) => button.addEventListener("click", () => {
    const root = document.getElementById("hypothesisFactoryThroughput");
    if (root) root.dataset.period = button.dataset.hptPeriod;
    renderHypothesisThroughput(getSnapshot?.(), { period: button.dataset.hptPeriod });
  }));
  if (!document.body.dataset.researchExplainBound) {
    document.body.dataset.researchExplainBound = "true";
    document.addEventListener("click", (event) => {
      if (event.target.closest?.("button, a, summary")) return;
      const trigger = event.target.closest?.("[data-explain]");
      if (trigger) openExplanation(trigger);
    });
    document.addEventListener("keydown", (event) => {
      const trigger = event.target.closest?.("[data-explain]");
      if (trigger && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        openExplanation(trigger);
      }
    });
    document.getElementById("researchExplainClose")?.addEventListener("click", () => document.getElementById("researchExplainDialog")?.close());
    document.getElementById("researchExplainDialog")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    });
  }
}
