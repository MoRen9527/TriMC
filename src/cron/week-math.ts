/**
 * Week math — ISO 8601 week arithmetic for weekly plane shift tokens.
 *
 * Pure functions (no I/O). Token rule per r1-1 design §4.1:
 *   toWeek    = ISO week of (today + 1 day)   — the week that begins next Monday
 *   startDate = the Monday that opens toWeek
 *   fromWeek  = toWeek − 1 (wraps to last ISO week of the previous year)
 *
 * Window check (design §4.1): Sun 08-16 run → to=W34 ✓; any Mon–Sat catchup run
 * → tomorrow still inside the W34 window → to=W34 ✓; next Sun 08-23 run → to=W35 ✓.
 */

export interface WeekShiftTokens {
  /** Previous ISO week, zero-padded, e.g. "W33". */
  fromWeek: string;
  /** Target ISO week, zero-padded, e.g. "W34". */
  toWeek: string;
  /** Monday of toWeek as YYYY-MM-DD (local calendar). */
  startDate: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * ISO 8601 week number (1–53) of the given date.
 * A week belongs to the ISO year that contains its Thursday.
 */
export function isoWeekOf(date: Date): number {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayNum = d.getDay() || 7; // 1=Mon … 7=Sun
  d.setDate(d.getDate() + 4 - dayNum); // move to this week's Thursday
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);
}

/** Zero-padded week token, e.g. "W09". */
export function formatIsoWeek(week: number): string {
  return `W${String(week).padStart(2, "0")}`;
}

function isoWeekOfLastWeekOfYear(year: number): number {
  // Dec 28 always falls in the final ISO week of its calendar year.
  return isoWeekOf(new Date(year, 11, 28));
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Compute {fromWeek, toWeek, startDate} for a weekly plane shift triggered at `now`.
 * Defaults to the current local time. All calendar math is local-time based,
 * matching the server timezone (Asia/Shanghai = Beijing time, UTC+8).
 */
export function computeWeekShiftTokens(now: Date = new Date()): WeekShiftTokens {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Monday of tomorrow's ISO week = the Monday that opens toWeek.
  const dayNum = tomorrow.getDay() || 7;
  const monday = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
  monday.setDate(monday.getDate() - (dayNum - 1));

  const toWeek = isoWeekOf(monday);
  let fromWeek = toWeek - 1;
  if (fromWeek < 1) {
    fromWeek = isoWeekOfLastWeekOfYear(monday.getFullYear() - 1);
  }

  return {
    fromWeek: formatIsoWeek(fromWeek),
    toWeek: formatIsoWeek(toWeek),
    startDate: formatDate(monday),
  };
}
