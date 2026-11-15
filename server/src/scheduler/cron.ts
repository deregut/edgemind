/**
 * Dependency-free schedule math (works on workerd: only Intl + Date).
 *
 * - 5-field cron (minute hour day-of-month month day-of-week): `*`, lists, ranges, steps (`*\/15`, `1-30/5`),
 *   names (JAN–DEC, SUN–SAT), 7 = Sunday, macros @hourly @daily @midnight @weekly @monthly @yearly @annually.
 *   Day-of-month and day-of-week follow Vixie cron: when both are restricted, a day matches if EITHER matches.
 * - Evaluated in an IANA timezone. DST: a wall-clock time that does not exist (spring-forward gap) runs at the
 *   same wall time shifted forward by the gap (02:30 → 03:30); an ambiguous time (fall-back) runs once, at its
 *   first occurrence.
 */

import type { ScheduleSpec } from "@edgemind/shared";
export type { ScheduleSpec, ScheduleType } from "@edgemind/shared";

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export class ScheduleError extends Error {}

function parseField(src: string, min: number, max: number, names?: string[], name = ""): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  const val = (t: string): number => {
    const lower = t.toLowerCase();
    if (names) {
      const i = names.indexOf(lower);
      if (i >= 0) return i + (names === MONTHS ? 1 : 0);
    }
    if (!/^\d+$/.test(t)) throw new ScheduleError(`cron 欄位「${name}」含無效的值：${t}`);
    return Number(t);
  };
  let star = false;
  for (const part of src.split(",")) {
    if (!part) throw new ScheduleError(`cron 欄位「${name}」格式錯誤`);
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new ScheduleError(`cron 欄位「${name}」的間隔無效：${part}`);
    let lo: number, hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
      if (stepS === undefined) star = true;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = val(a);
      hi = val(b);
    } else {
      lo = val(range);
      hi = stepS === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new ScheduleError(`cron 欄位「${name}」超出範圍（${min}–${max}）：${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, star };
}

export function parseCron(expr: string): CronFields {
  const src = (MACROS[expr.trim().toLowerCase()] ?? expr).trim();
  const f = src.split(/\s+/);
  if (f.length !== 5) throw new ScheduleError("cron 運算式必須有 5 個欄位（分 時 日 月 星期）");
  const minute = parseField(f[0], 0, 59, undefined, "分");
  const hour = parseField(f[1], 0, 23, undefined, "時");
  const dom = parseField(f[2], 1, 31, undefined, "日");
  const month = parseField(f[3], 1, 12, MONTHS, "月");
  const dow = parseField(f[4], 0, 7, DAYS, "星期");
  if (dow.set.has(7)) {
    dow.set.delete(7);
    dow.set.add(0);
  }
  return { minute: minute.set, hour: hour.set, dom: dom.set, month: month.set, dow: dow.set, domStar: dom.star, dowStar: dow.star };
}

// ---------- timezone helpers ----------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in tz, packed as a "fake UTC" millisecond value. */
export function wallMs(instant: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(instant))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
}

/** UTC offset (ms) of tz at an instant. */
export function tzOffset(instant: number, tz: string): number {
  const floored = Math.floor(instant / 1000) * 1000;
  return wallMs(floored, tz) - floored;
}

/**
 * Instant for a wall-clock time (fake-UTC ms) in tz. Ambiguous → earliest; non-existent → shifted forward by the gap.
 */
export function zonedToUtc(wall: number, tz: string): number {
  const before = tzOffset(wall - 86_400_000, tz);
  const after = tzOffset(wall + 86_400_000, tz);
  const candidates = [...new Set([before, after])].map((o) => wall - o).sort((a, b) => a - b);
  for (const t of candidates) if (wallMs(t, tz) === wall) return t;
  return wall - before; // gap: interpret with the pre-transition offset → lands after the gap
}

/** Start of the local day (and month) containing `instant` in tz, as instants. */
export function localDayStart(instant: number, tz: string): number {
  const w = wallMs(instant, tz);
  const d = new Date(w);
  return zonedToUtc(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), tz);
}
export function localMonthStart(instant: number, tz: string): number {
  const d = new Date(wallMs(instant, tz));
  return zonedToUtc(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), tz);
}
/** Local calendar date "YYYY-MM-DD" of an instant. */
export function localDate(instant: number, tz: string): string {
  return new Date(wallMs(instant, tz)).toISOString().slice(0, 10);
}

// ---------- next run ----------

const MIN = 60_000;

/** First instant strictly after `after` matching the cron expression in tz (null if none within ~5 years). */
export function nextCron(expr: string | CronFields, after: number, tz: string): number | null {
  const f = typeof expr === "string" ? parseCron(expr) : expr;
  const dayOk = (d: Date) => {
    const domOk = f.dom.has(d.getUTCDate());
    const dowOk = f.dow.has(d.getUTCDay());
    if (f.domStar && f.dowStar) return true;
    if (f.domStar) return dowOk;
    if (f.dowStar) return domOk;
    return domOk || dowOk;
  };
  // walk wall-clock time; fake-UTC Date gives calendar arithmetic without DST
  let w = Math.floor(wallMs(after, tz) / MIN) * MIN + MIN;
  const limit = w + 5 * 366 * 86_400_000;
  while (w < limit) {
    const d = new Date(w);
    if (!f.month.has(d.getUTCMonth() + 1)) {
      w = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    if (!dayOk(d)) {
      w = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!f.hour.has(d.getUTCHours())) {
      w = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!f.minute.has(d.getUTCMinutes())) {
      w += MIN;
      continue;
    }
    const t = zonedToUtc(w, tz);
    if (t > after) return t;
    w += MIN; // e.g. second pass through a fall-back hour already handled
  }
  return null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Normalize + validate a spec (throws ScheduleError with a 正體中文 message). */
export function validateSpec(raw: any): ScheduleSpec {
  if (!raw || typeof raw !== "object") throw new ScheduleError("缺少排程設定");
  const timezone = raw.timezone;
  if (!isValidTimezone(timezone)) throw new ScheduleError("時區無效（請用 IANA 名稱，例如 Asia/Taipei）");
  const type = raw.type as ScheduleSpec["type"];
  switch (type) {
    case "once": {
      if (typeof raw.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw.at)) throw new ScheduleError("單次排程需要日期時間（YYYY-MM-DDTHH:MM）");
      const [d, t] = raw.at.split("T");
      const [y, mo, da] = d.split("-").map(Number);
      const [h, mi] = t.split(":").map(Number);
      const w = Date.UTC(y, mo - 1, da, h, mi);
      if (Number.isNaN(w) || new Date(w).toISOString().slice(0, 16) !== raw.at) throw new ScheduleError("日期時間無效");
      return { type, at: raw.at, timezone };
    }
    case "interval": {
      const n = Number(raw.everyMinutes);
      if (!Number.isInteger(n) || n < 5 || n > 525_600) throw new ScheduleError("間隔必須是 5 分鐘到 1 年之間的整數分鐘");
      const anchor = typeof raw.anchor === "string" && !Number.isNaN(Date.parse(raw.anchor)) ? new Date(raw.anchor).toISOString() : new Date().toISOString();
      return { type, everyMinutes: n, anchor, timezone };
    }
    case "daily":
    case "weekly": {
      if (typeof raw.time !== "string" || !HHMM.test(raw.time)) throw new ScheduleError("時間格式必須是 HH:MM");
      if (type === "daily") return { type, time: raw.time, timezone };
      const days = Array.isArray(raw.weekdays) ? [...new Set((raw.weekdays as unknown[]).map(Number))].filter((x: number) => Number.isInteger(x) && x >= 0 && x <= 6).sort() : [];
      if (!days.length) throw new ScheduleError("每週排程至少要選一天");
      return { type, time: raw.time, weekdays: days as number[], timezone };
    }
    case "cron": {
      if (typeof raw.cron !== "string" || raw.cron.length > 200) throw new ScheduleError("缺少 cron 運算式");
      const f = parseCron(raw.cron);
      if (nextCron(f, Date.now(), timezone) === null) throw new ScheduleError("這個 cron 運算式在未來五年內不會觸發");
      return { type, cron: raw.cron.trim(), timezone };
    }
    default:
      throw new ScheduleError("排程類型必須是 once、interval、daily、weekly 或 cron");
  }
}

/** The equivalent cron expression for daily/weekly specs. */
function asCron(spec: ScheduleSpec): string | null {
  if (spec.type === "cron") return spec.cron!;
  if (spec.type === "daily" || spec.type === "weekly") {
    const [h, m] = spec.time!.split(":").map(Number);
    return `${m} ${h} * * ${spec.type === "daily" ? "*" : spec.weekdays!.join(",")}`;
  }
  return null;
}

/** Next run strictly after `after` (ms). `once` → its instant if still in the future, else null. */
export function nextRun(spec: ScheduleSpec, after: number): number | null {
  switch (spec.type) {
    case "once": {
      const [d, t] = spec.at!.split("T");
      const [y, mo, da] = d.split("-").map(Number);
      const [h, mi] = t.split(":").map(Number);
      const at = zonedToUtc(Date.UTC(y, mo - 1, da, h, mi), spec.timezone);
      return at > after ? at : null;
    }
    case "interval": {
      const step = spec.everyMinutes! * MIN;
      const anchor = Date.parse(spec.anchor!);
      if (after < anchor) return anchor;
      return anchor + (Math.floor((after - anchor) / step) + 1) * step;
    }
    default:
      return nextCron(asCron(spec)!, after, spec.timezone);
  }
}

/** Human summary in 正體中文 (for lists). */
export function describeSpec(spec: ScheduleSpec): string {
  const wd = ["日", "一", "二", "三", "四", "五", "六"];
  switch (spec.type) {
    case "once":
      return `單次：${spec.at!.replace("T", " ")}（${spec.timezone}）`;
    case "interval":
      return spec.everyMinutes! % 60 === 0 ? `每 ${spec.everyMinutes! / 60} 小時` : `每 ${spec.everyMinutes} 分鐘`;
    case "daily":
      return `每天 ${spec.time}（${spec.timezone}）`;
    case "weekly":
      return `每週${spec.weekdays!.map((d) => wd[d]).join("、")} ${spec.time}（${spec.timezone}）`;
    case "cron":
      return `cron「${spec.cron}」（${spec.timezone}）`;
  }
}
