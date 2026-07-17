// ---------------------------------------------------------------------------
// Pure data-transform helpers for the Stats dashboard.
//
// Everything here is side-effect-free and free of `Date.now()` / `new Date()`
// (except when derived from an explicit YYYY-MM-DD string), so each function is
// deterministic and easy to unit-test in isolation (see stats.test.js). The
// React layer (salon-manager.jsx) imports these and only worries about rendering.
//
// Shapes it consumes (see the schema notes in the app):
//   sale    = { date:"YYYY-MM-DD", time:"11:27 pm", payment:"UPI|Cash|Udhari",
//               total, profit, paid?, payments?[{amount,date}],
//               customerPhone?, lines:[{name, qty, amount, price, buyPrice,
//               unit, misc?, lineType?:"service"|"product", staffId?}] }
//   expense = { date, desc, amount }   // one-time setup capex, NOT operating cost
//   item    = { name, category, buyPrice, sellPrice, stock, ... }
//
// Everything above the "Salon analytics" banner near the bottom is the grocery
// core's validated analytics, ported unchanged. The salon metrics are appended
// there rather than woven in, so those functions and their tests stay untouched.
// ---------------------------------------------------------------------------

import { isServiceLine } from "./salon.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Row order for the heatmap / weekday views: business weeks read Mon → Sun.
export const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

// --- money ------------------------------------------------------------------

// Round to paise so summed floats don't drift (0.1 + 0.2 = 0.30000000004).
// A non-numeric input collapses to 0 rather than poisoning a total with NaN.
export const round2 = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : 0;
};

// Indian digit grouping: 125503 -> "₹1,25,503", 1250000 -> "₹12,50,000".
export const formatINR = (n, { symbol = true, decimals = 2 } = {}) =>
  (symbol ? "₹" : "") +
  Number(round2(n)).toLocaleString("en-IN", { maximumFractionDigits: decimals });

// Compact axis/label form using Indian scale words: k (thousand), L (lakh),
// Cr (crore). 1250 -> "₹1.3k", 250000 -> "₹2.5L", 12000000 -> "₹1.2Cr".
export const inrCompact = (v) => {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const trim = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  if (a >= 1e7) return sign + "₹" + trim(Math.round((a / 1e7) * 10) / 10) + "Cr";
  if (a >= 1e5) return sign + "₹" + trim(Math.round((a / 1e5) * 10) / 10) + "L";
  if (a >= 1e3) return sign + "₹" + trim(Math.round((a / 1e3) * 10) / 10) + "k";
  return sign + "₹" + (Number.isInteger(a) ? a : round2(a));
};

// --- dates ------------------------------------------------------------------

// Parse a YYYY-MM-DD string as *local* midnight (never UTC — an IST early-morning
// sale must not slip to the previous calendar day).
export const parseDate = (ds) => new Date(ds + "T00:00");
const dstr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD string.
export const weekdayIndex = (ds) => parseDate(ds).getDay();

// Whole days from date `a` to date `b` (b − a). Negative if b precedes a.
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

// Locale-independent short labels so tests are stable across machines.
export const dayLabel = (ds) => { const d = parseDate(ds); return d.getDate() + " " + MON[d.getMonth()]; };
export const monthLabel = (ym) => { const [y, m] = String(ym).split("-"); return MON[(+m) - 1] + " '" + String(y).slice(2); };

// Inclusive list of YYYY-MM-DD from `from` to `to`. Empty on bad/reversed input.
// A guard caps the walk so a malformed range can never spin forever.
export const eachDate = (from, to) => {
  const out = [];
  const start = parseDate(from), end = parseDate(to);
  if (isNaN(start) || isNaN(end) || end < start) return out;
  const d = new Date(start);
  let guard = 0;
  while (d <= end && guard++ < 20000) { out.push(dstr(d)); d.setDate(d.getDate() + 1); }
  return out;
};

// Inclusive list of YYYY-MM month keys spanning [from, to].
export const eachMonth = (from, to) => {
  const out = [];
  const start = parseDate(from), end = parseDate(to);
  if (isNaN(start) || isNaN(end) || end < start) return out;
  let d = new Date(start.getFullYear(), start.getMonth(), 1);
  let guard = 0;
  while (d <= end && guard++ < 600) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return out;
};

// --- time-of-day parsing ----------------------------------------------------

// Clock hour 0–23 from a stored 12-hour time like "02:15 pm (back-dated)".
// Returns null when there's no parseable "hh:mm am/pm" — callers skip those
// rows (many consolidated back-dated entries have no real clock time).
export const parseHour = (t) => {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let h = (+m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h;
};

// Minutes since midnight, or -1 if unknown. Accepts 12-hour ("2:15 pm") and,
// as a fallback, bare 24-hour ("14:15") strings.
export const parseMinutes = (t) => {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return -1;
  let h = +m[1];
  const ap = (m[3] || "").toLowerCase();
  if (ap) { h = h % 12; if (ap === "pm") h += 12; }
  return h * 60 + (+m[2]);
};

// hour 14 -> "2p", hour 9 -> "9a".
export const hourLabel = (h) => (h % 12 || 12) + (h < 12 ? "a" : "p");

// --- names / consolidated entries -------------------------------------------

export const normalizeName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

// Some sales are consolidated / back-dated summary rows whose line.name carries
// "Misc", "SwadSutra" or "Sold" (or the explicit misc flag). They belong in
// TOTAL revenue but distort item-level top-seller charts, so item aggregations
// can opt to drop them.
const CONSOLIDATED_RE = /misc|swadsutra|sold/i;
export const isConsolidatedLine = (line) =>
  !!line && (line.misc === true || CONSOLIDATED_RE.test(String(line.name || "")));

// --- generic filters --------------------------------------------------------

export const filterByDateRange = (rows, from, to) =>
  (rows || []).filter((r) => r && r.date >= from && r.date <= to);

// --- headline totals --------------------------------------------------------

export const summarize = (sales) => {
  let revenue = 0, profit = 0;
  for (const s of sales || []) { revenue += Number(s.total) || 0; profit += Number(s.profit) || 0; }
  const bills = (sales || []).length;
  return {
    revenue: round2(revenue),
    profit: round2(profit),
    bills,
    margin: revenue > 0 ? Math.round((profit / revenue) * 100) : 0,
    avgTicket: bills > 0 ? round2(revenue / bills) : 0,
  };
};

// --- moving average ---------------------------------------------------------

// Trailing simple moving average of `key` over `window` rows, written to `outKey`.
// Leading rows average over however many points exist so far (no NaN gap).
export const withMovingAverage = (rows, key, window, outKey = key + "Ma") =>
  (rows || []).map((r, i) => {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) { sum += Number(rows[j][key]) || 0; count++; }
    return { ...r, [outKey]: count ? round2(sum / count) : 0 };
  });

// --- daily / monthly series -------------------------------------------------

// One bucket per calendar day in [from, to]; empty days are zero. Attaches a
// 7-day trailing moving average of revenue as `ma7`.
export const dailyRevenueSeries = (sales, from, to) => {
  const days = eachDate(from, to);
  const idx = new Map(days.map((d, i) => [d, i]));
  const rows = days.map((d) => ({ date: d, label: dayLabel(d), revenue: 0, profit: 0 }));
  for (const s of sales || []) {
    const i = idx.get(s.date);
    if (i != null) { rows[i].revenue += Number(s.total) || 0; rows[i].profit += Number(s.profit) || 0; }
  }
  return withMovingAverage(
    rows.map((r) => ({ ...r, revenue: round2(r.revenue), profit: round2(r.profit) })),
    "revenue", 7, "ma7"
  );
};

// One bucket per calendar month in [from, to]. revenue (bar) + profit (line).
export const monthlyRevenueProfit = (sales, from, to) => {
  const months = eachMonth(from, to);
  const idx = new Map(months.map((m, i) => [m, i]));
  const rows = months.map((m) => ({ month: m, label: monthLabel(m), revenue: 0, profit: 0 }));
  for (const s of sales || []) {
    if (!s.date) continue;
    const i = idx.get(String(s.date).slice(0, 7));
    if (i != null) { rows[i].revenue += Number(s.total) || 0; rows[i].profit += Number(s.profit) || 0; }
  }
  return rows.map((r) => ({ ...r, revenue: round2(r.revenue), profit: round2(r.profit) }));
};

// --- heatmap ----------------------------------------------------------------

// Revenue by weekday × clock-hour. grid[dayOfWeek 0–6][hour 0–23] = revenue.
// Bills without a parseable clock time are skipped (they can't be placed on an
// hour). minHour/maxHour bound the active window so the UI can render compact
// columns instead of a full 24-wide grid; both are null when there's no data.
export const salesHeatmap = (sales) => {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0, total = 0, minHour = null, maxHour = null, placed = 0;
  for (const s of sales || []) {
    const h = parseHour(s.time);
    if (h == null || !s.date) continue;
    const wd = weekdayIndex(s.date);
    const v = Number(s.total) || 0;
    grid[wd][h] += v;
    total += v;
    placed++;
    if (minHour == null || h < minHour) minHour = h;
    if (maxHour == null || h > maxHour) maxHour = h;
  }
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) { grid[d][h] = round2(grid[d][h]); if (grid[d][h] > max) max = grid[d][h]; }
  return { grid, max: round2(max), total: round2(total), placed, minHour, maxHour };
};

// --- item aggregation / top sellers -----------------------------------------

// Roll every sold line up to its item. `includeConsolidated` keeps Misc/SwadSutra/
// Sold summary rows (off by default so they don't swamp real products).
export const aggregateItems = (sales, { includeConsolidated = false } = {}) => {
  const m = new Map();
  for (const s of sales || []) for (const l of s.lines || []) {
    if (!includeConsolidated && isConsolidatedLine(l)) continue;
    const key = normalizeName(l.name);
    if (!key) continue;
    const e = m.get(key) || { name: l.name, key, revenue: 0, qty: 0, profit: 0 };
    e.revenue += Number(l.amount) || 0;
    e.qty += Number(l.qty) || 0;
    e.profit += ((Number(l.price) || 0) - (Number(l.buyPrice) || 0)) * (Number(l.qty) || 0);
    m.set(key, e);
  }
  return [...m.values()].map((e) => ({
    ...e, revenue: round2(e.revenue), profit: round2(e.profit), qty: Math.round(e.qty * 1000) / 1000,
  }));
};

export const topItems = (sales, { metric = "revenue", limit = 15, includeConsolidated = false } = {}) =>
  aggregateItems(sales, { includeConsolidated })
    .sort((a, b) => (b[metric] || 0) - (a[metric] || 0))
    .slice(0, limit);

// --- payment mix ------------------------------------------------------------

// Amount + share by payment method. Unknown/blank methods fall into "Other".
export const paymentBreakdown = (sales) => {
  const order = ["UPI", "Cash", "Udhari"];
  const sums = { UPI: 0, Cash: 0, Udhari: 0, Other: 0 };
  let total = 0;
  for (const s of sales || []) {
    const v = Number(s.total) || 0;
    total += v;
    sums[order.includes(s.payment) ? s.payment : "Other"] += v;
  }
  const rows = [...order, "Other"]
    .map((name) => ({ name, value: round2(sums[name]) }))
    .filter((r) => r.value > 0)
    .map((r) => ({ ...r, pct: total > 0 ? Math.round((r.value / total) * 100) : 0 }));
  return { rows, total: round2(total) };
};

// --- udhari (credit) outstanding over time ----------------------------------

// Every balance-changing event on the credit book: +total when credit is given
// (bill date), −amount for each repayment (from the payments ledger, or the
// legacy `paid` field reconciled to the bill date).
export const udhariEvents = (sales) => {
  const events = [];
  for (const s of sales || []) {
    if (s.payment !== "Udhari" || !s.date) continue;
    events.push({ date: s.date, delta: Number(s.total) || 0 });
    const ledger = Array.isArray(s.payments) ? s.payments : [];
    if (ledger.length) {
      for (const p of ledger) events.push({ date: p.date || s.date, delta: -(Number(p.amount) || 0) });
    } else {
      const paid = Number(s.paid) || 0;
      if (paid > 0) events.push({ date: s.date, delta: -paid });
    }
  }
  return events;
};

// Running outstanding balance for each day in [from, to]. Balance is carried in
// from before `from` so the visible window shows the *true* running total, not a
// slice that resets to zero. Displayed values clamp at 0 (a debt can't be
// negative even if messy repayment data briefly over-counts).
export const udhariOutstandingSeries = (sales, from, to) => {
  const byDay = new Map();
  for (const e of udhariEvents(sales)) byDay.set(e.date, (byDay.get(e.date) || 0) + e.delta);
  let running = 0;
  for (const [d, delta] of byDay) if (d < from) running += delta;
  return eachDate(from, to).map((d) => {
    running += byDay.get(d) || 0;
    return { date: d, label: dayLabel(d), outstanding: round2(Math.max(0, running)) };
  });
};

// --- inventory (current snapshot, independent of the date range) ------------

export const inventoryValue = (items) => {
  let cost = 0, retail = 0, units = 0, outOfStock = 0;
  for (const i of items || []) {
    const stock = Number(i.stock) || 0;
    cost += (Number(i.buyPrice) || 0) * stock;
    retail += (Number(i.sellPrice) || 0) * stock;
    units += stock;
    if (stock <= 0) outOfStock += 1;
  }
  return { cost: round2(cost), retail: round2(retail), units: round2(units), outOfStock, count: (items || []).length };
};

// Stock value grouped by category — cost vs retail, for the treemap. Sorted by
// cost descending; categories with no on-hand value are dropped.
export const inventoryByCategory = (items) => {
  const m = new Map();
  for (const i of items || []) {
    const cat = ((i.category || "").trim()) || "Other";
    const stock = Number(i.stock) || 0;
    const e = m.get(cat) || { name: cat, cost: 0, retail: 0, items: 0 };
    e.cost += (Number(i.buyPrice) || 0) * stock;
    e.retail += (Number(i.sellPrice) || 0) * stock;
    e.items += 1;
    m.set(cat, e);
  }
  return [...m.values()]
    .map((e) => ({ ...e, cost: round2(e.cost), retail: round2(e.retail) }))
    .filter((e) => e.cost > 0 || e.retail > 0)
    .sort((a, b) => b.cost - a.cost);
};

// In-stock items that never sold in the given (already period-filtered) sales.
// Value at cost, highest first — the money sitting idle on the shelf.
export const deadStock = (items, sales) => {
  const sold = new Set();
  for (const s of sales || []) for (const l of s.lines || []) sold.add(normalizeName(l.name));
  return (items || [])
    .filter((i) => (Number(i.stock) || 0) > 0 && !sold.has(normalizeName(i.name)))
    .map((i) => ({ name: i.name, stock: Number(i.stock) || 0, unit: i.unit, value: round2((Number(i.buyPrice) || 0) * (Number(i.stock) || 0)) }))
    .sort((a, b) => b.value - a.value);
};

// --- expenses (one-time capital / setup cost) -------------------------------

// Total spend across the given expenses.
export const expenseTotal = (expenses) =>
  round2((expenses || []).reduce((a, e) => a + (Number(e.amount) || 0), 0));

// One bucket per calendar month in [from, to] — capital deployed per month.
export const expenseByMonth = (expenses, from, to) => {
  const months = eachMonth(from, to);
  const idx = new Map(months.map((m, i) => [m, i]));
  const rows = months.map((m) => ({ month: m, label: monthLabel(m), amount: 0 }));
  for (const e of expenses || []) {
    if (!e.date) continue;
    const i = idx.get(String(e.date).slice(0, 7));
    if (i != null) rows[i].amount += Number(e.amount) || 0;
  }
  return rows.map((r) => ({ ...r, amount: round2(r.amount) }));
};

// Spend grouped by description ("where the money went"), biggest first, with %.
export const expenseBreakdown = (expenses, { limit = 10 } = {}) => {
  const m = new Map();
  let total = 0;
  for (const e of expenses || []) {
    const name = String(e.desc || "").trim() || "Uncategorised";
    const v = Number(e.amount) || 0;
    total += v;
    m.set(name, (m.get(name) || 0) + v);
  }
  const rows = [...m.entries()]
    .map(([name, value]) => ({ name, value: round2(value), pct: total > 0 ? Math.round((value / total) * 100) : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
  return { rows, total: round2(total) };
};

// --- break-even (cumulative trading profit vs total capex) ------------------

// Capex is the one-time setup spend (all expenses) — a horizontal line the
// cumulative *trading* profit has to climb over. Trading profit is sales profit
// only; capex is never subtracted from it (they're compared, not netted). Uses
// ALL sales, not a period slice: break-even is an all-time journey.
export const breakEvenSeries = (sales, expenses) => {
  const capex = round2((expenses || []).reduce((a, e) => a + (Number(e.amount) || 0), 0));
  const byDay = new Map();
  for (const s of sales || []) {
    if (!s.date) continue;
    byDay.set(s.date, (byDay.get(s.date) || 0) + (Number(s.profit) || 0));
  }
  const dates = [...byDay.keys()].sort();
  let cum = 0, breakEvenDate = null;
  const series = dates.map((d) => {
    cum += byDay.get(d);
    if (breakEvenDate == null && capex > 0 && cum >= capex) breakEvenDate = d;
    return { date: d, label: dayLabel(d), cumProfit: round2(cum), capex };
  });
  const cumulativeProfit = round2(cum);
  return {
    series, capex, cumulativeProfit, breakEvenDate,
    recovered: capex > 0 ? Math.round((cumulativeProfit / capex) * 100) : (cumulativeProfit > 0 ? 100 : 0),
  };
};

// Turn a breakEvenSeries() result into a plain-language estimate:
//   { status: "no-capex" }                       — nothing invested to recover
//   { status: "reached", breakEvenDate, days }   — already broke even (days it took)
//   { status: "projected", daysLeft, perDay }    — on track; ETA from avg daily profit
//   { status: "stalled" | "unknown" }            — no positive trend / too little data
export const breakEvenEstimate = (be) => {
  if (!be || !be.capex) return { status: "no-capex" };
  const { series, capex, cumulativeProfit, breakEvenDate } = be;
  if (breakEvenDate) return { status: "reached", breakEvenDate, days: daysBetween(series[0].date, breakEvenDate) };
  if (!series || series.length < 2) return { status: "unknown" };
  const spanDays = Math.max(1, daysBetween(series[0].date, series[series.length - 1].date));
  const perDay = cumulativeProfit / spanDays;
  if (perDay <= 0) return { status: "stalled" };
  return { status: "projected", daysLeft: Math.ceil((capex - cumulativeProfit) / perDay), perDay: round2(perDay) };
};

// ============================================================================
// Salon analytics (Phase 6).
//
// Appended, not woven in: everything above is the grocery core's validated
// analytics and its tests must keep passing untouched. These read the salon
// fields on a bill (lineType, customerPhone) and treat their absence as
// "grocery-era bill" rather than as an error.
//
// One rule runs through all of it: a bill with no customerPhone is a WALK-IN,
// not a customer with a blank name. Walk-ins must never be counted as one giant
// returning customer — that would make the repeat ratio, LTV and new-vs-returning
// all quietly wrong, in the flattering direction.
// ============================================================================

/** Bills within [from, to] inclusive. Blank bounds are open. */
export const inRange = (sales, from, to) =>
  (sales || []).filter((s) => {
    const d = String(s.date || "");
    return (!from || d >= from) && (!to || d <= to);
  });

/**
 * Revenue split between labour and stock.
 *
 * The most useful single number in a salon's accounts: services and retail have
 * completely different margins, and an owner who can't see the split can't tell
 * which half of the business is paying the rent.
 */
export const serviceVsProductRevenue = (sales, from, to) => {
  let service = 0;
  let product = 0;
  for (const s of inRange(sales, from, to)) {
    for (const l of s.lines || []) {
      const amt = Number(l.amount) || 0;
      if (isServiceLine(l)) service += amt;
      else product += amt;
    }
  }
  const total = service + product;
  return {
    service: round2(service),
    product: round2(product),
    total: round2(total),
    servicePct: total > 0 ? round2((service / total) * 100) : 0,
  };
};

/** Top services by revenue (or by count), from service lines only. */
export const topServices = (sales, { metric = "revenue", limit = 10, from = "", to = "" } = {}) => {
  const m = new Map();
  for (const s of inRange(sales, from, to)) {
    for (const l of s.lines || []) {
      if (!isServiceLine(l)) continue;
      const key = String(l.name || "").trim() || "(unnamed)";
      const e = m.get(key) || { name: key, revenue: 0, count: 0 };
      e.revenue += Number(l.amount) || 0;
      e.count += Number(l.qty) || 1;
      m.set(key, e);
    }
  }
  return [...m.values()]
    .map((e) => ({ ...e, revenue: round2(e.revenue) }))
    .sort((a, b) => (metric === "count" ? b.count - a.count : b.revenue - a.revenue))
    .slice(0, limit);
};

/**
 * What share of identified customers came back.
 *
 * Walk-ins are excluded entirely — they have no identity, so "did they return?"
 * is unanswerable for them, and lumping them together would answer it wrongly.
 * The denominator is customers the salon can actually track.
 */
export const repeatRatio = (sales, from, to) => {
  const visits = new Map();
  for (const s of inRange(sales, from, to)) {
    const p = String(s.customerPhone || "");
    if (!p) continue; // walk-in
    visits.set(p, (visits.get(p) || 0) + 1);
  }
  const identified = visits.size;
  const repeat = [...visits.values()].filter((n) => n > 1).length;
  return {
    identified,
    repeat,
    once: identified - repeat,
    pct: identified > 0 ? round2((repeat / identified) * 100) : 0,
  };
};

/** Average bill value per month, with the bill count behind it. */
export const avgBillTrend = (sales, from, to) => {
  const m = new Map();
  for (const s of inRange(sales, from, to)) {
    const ym = String(s.date || "").slice(0, 7);
    if (!ym) continue;
    const e = m.get(ym) || { ym, total: 0, bills: 0 };
    e.total += Number(s.total) || 0;
    e.bills++;
    m.set(ym, e);
  }
  return [...m.values()]
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((e) => ({ ym: e.ym, label: monthLabel(e.ym), bills: e.bills, avg: round2(e.total / e.bills) }));
};

/**
 * Lifetime value per identified customer, bucketed for a histogram.
 *
 * Fixed rupee bands rather than quantiles: an owner reads "how many customers are
 * worth over 20k" directly, where a quantile chart needs interpreting first.
 */
export const ltvDistribution = (sales, buckets = [1000, 5000, 10000, 20000, 50000]) => {
  const spend = new Map();
  for (const s of sales || []) {
    const p = String(s.customerPhone || "");
    if (!p) continue;
    spend.set(p, (spend.get(p) || 0) + (Number(s.total) || 0));
  }
  const bands = [];
  for (let i = 0; i < buckets.length; i++) {
    bands.push({
      label: i === 0 ? "< " + inrCompact(buckets[0]) : inrCompact(buckets[i - 1]) + "–" + inrCompact(buckets[i]),
      min: i === 0 ? 0 : buckets[i - 1],
      max: buckets[i],
      count: 0,
    });
  }
  bands.push({ label: inrCompact(buckets[buckets.length - 1]) + "+", min: buckets[buckets.length - 1], max: Infinity, count: 0 });
  for (const v of spend.values()) {
    const band = bands.find((b) => v < b.max) || bands[bands.length - 1];
    band.count++;
  }
  return bands;
};

/**
 * New vs returning customers per month.
 *
 * "New" means their FIRST EVER bill fell in that month — computed against the whole
 * history, not the visible range, or every customer would look new in the first
 * month of whatever window you happened to pick.
 */
export const newVsReturning = (sales, from, to) => {
  const firstSeen = new Map();
  for (const s of sales || []) {
    const p = String(s.customerPhone || "");
    const d = String(s.date || "");
    if (!p || !d) continue;
    const prev = firstSeen.get(p);
    if (!prev || d < prev) firstSeen.set(p, d);
  }
  const months = new Map();
  const seenThisMonth = new Map(); // ym -> Set(phone), so one customer counts once per month
  for (const s of inRange(sales, from, to)) {
    const p = String(s.customerPhone || "");
    const d = String(s.date || "");
    if (!p || !d) continue;
    const ym = d.slice(0, 7);
    if (!months.has(ym)) {
      months.set(ym, { ym, label: monthLabel(ym), new: 0, returning: 0 });
      seenThisMonth.set(ym, new Set());
    }
    if (seenThisMonth.get(ym).has(p)) continue;
    seenThisMonth.get(ym).add(p);
    const isNew = String(firstSeen.get(p) || "").slice(0, 7) === ym;
    months.get(ym)[isNew ? "new" : "returning"]++;
  }
  return [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym));
};

/**
 * No-show percentage across the salon, over appointments that RESOLVED.
 * Cancellations are excluded — same reasoning as the per-stylist rate.
 */
export const noShowPct = (appointments, from, to) => {
  let completed = 0;
  let noShow = 0;
  for (const a of appointments || []) {
    const d = String(a.date || "");
    if ((from && d < from) || (to && d > to)) continue;
    if (a.status === "completed") completed++;
    else if (a.status === "no-show") noShow++;
  }
  const resolved = completed + noShow;
  return { completed, noShow, resolved, pct: resolved > 0 ? round2((noShow / resolved) * 100) : 0 };
};

/**
 * How many customers were dormant at each month end — the trend that says whether
 * the salon is leaking customers.
 *
 * Counted at each month's END using only the bills up to that point, so the line
 * shows what was true then rather than what hindsight says.
 */
export const dormantTrend = (sales, from, to, dormantDays = 60) => {
  const withPhone = (sales || []).filter((s) => s.customerPhone && s.date);
  if (!withPhone.length) return [];
  const out = [];
  for (const ym of eachMonth(from, to)) {
    const [y, m] = ym.split("-").map(Number);
    const monthEnd = new Date(y, m, 0); // day 0 of next month = last day of this one
    const endStr = y + "-" + String(m).padStart(2, "0") + "-" + String(monthEnd.getDate()).padStart(2, "0");
    const lastVisit = new Map();
    for (const s of withPhone) {
      if (String(s.date) > endStr) continue; // no peeking at the future
      const p = String(s.customerPhone);
      const prev = lastVisit.get(p);
      if (!prev || String(s.date) > prev) lastVisit.set(p, String(s.date));
    }
    let dormant = 0;
    for (const d of lastVisit.values()) {
      if (daysBetween(d, endStr) > dormantDays) dormant++;
    }
    out.push({ ym, label: monthLabel(ym), dormant, known: lastVisit.size });
  }
  return out;
};

/**
 * Rebooking conversion: of the customers a reminder went out to, how many came
 * back within `windowDays`.
 *
 * The only honest measure of whether the reminders are worth sending.
 * `remindersSentAt` on each customer is the record of what was sent; a visit
 * strictly AFTER the send date, inside the window, counts as a conversion.
 *
 * Reminders sent too recently to have had their full window are held back from the
 * denominator — counting them would drag the rate down for no reason but impatience.
 */
export const rebookConversion = (customers, sales, today, windowDays = 14) => {
  const billsByPhone = new Map();
  for (const s of sales || []) {
    const p = String(s.customerPhone || "");
    if (!p || !s.date) continue;
    if (!billsByPhone.has(p)) billsByPhone.set(p, []);
    billsByPhone.get(p).push(String(s.date));
  }
  let sent = 0;
  let converted = 0;
  let pending = 0;
  for (const c of customers || []) {
    const marks = c.remindersSentAt || {};
    for (const at of Object.values(marks)) {
      if (!at) continue;
      const elapsed = daysBetween(at, today);
      if (elapsed < 0) continue; // future date — corrupt, ignore
      if (elapsed < windowDays) { pending++; continue; }
      sent++;
      const visits = billsByPhone.get(String(c.phone)) || [];
      if (visits.some((d) => d > at && daysBetween(at, d) <= windowDays)) converted++;
    }
  }
  return { sent, converted, pending, pct: sent > 0 ? round2((converted / sent) * 100) : 0 };
};
