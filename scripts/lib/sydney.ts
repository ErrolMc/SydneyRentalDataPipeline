/**
 * Sydney-time helpers (PLAN.md §3 conventions, §4 step 2).
 *
 * Run ids are Sydney calendar dates and the synthetic transit departure is a
 * Sydney wall-clock time, but Node has no Temporal yet and the plan's
 * dependency list has no date library. `Intl` knows the AEST/AEDT rules, so
 * everything here is derived from it rather than from a hardcoded +10:00.
 */

const SYDNEY = 'Australia/Sydney'

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export type DayName = (typeof DAY_NAMES)[number]

const dateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: SYDNEY,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: SYDNEY, weekday: 'long' })

const utcOffset = new Intl.DateTimeFormat('en-US', { timeZone: SYDNEY, timeZoneName: 'longOffset' })

/** The calendar date in Sydney right now, `YYYY-MM-DD`. */
export function sydneyToday(now: Date = new Date()): string {
  return dateParts.format(now)
}

/** `+10:00` in winter, `+11:00` during daylight saving — read from the ICU rules, never assumed. */
export function sydneyUtcOffset(onDate: Date): string {
  const name = utcOffset.formatToParts(onDate).find((part) => part.type === 'timeZoneName')?.value
  // Intl renders these as `GMT+10:00`, and as bare `GMT` for a zero offset.
  const offset = name?.replace(/^GMT/, '') ?? ''
  return offset === '' ? '+00:00' : offset
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

function weekdayOf(date: string): DayName {
  const [year, month, day] = date.split('-').map(Number)
  // Midday UTC keeps the lookup on the intended calendar day in every offset.
  const at = new Date(Date.UTC(year, month - 1, day, 12))
  return weekdayName.format(at) as DayName
}

/**
 * §4 step 2: the next `dayOfWeek` at `arriveBy` Sydney time, at least two days
 * out. Fixing a synthetic arrive-by is what makes transit minutes comparable
 * from one run to the next — a real "next Tuesday" would drift with the
 * timetable and with how close the run happens to fall to the weekend.
 */
export function resolveTransitDeparture(
  dayOfWeek: DayName,
  arriveBy: string,
  now: Date = new Date(),
): string {
  const earliest = addDays(sydneyToday(now), 2)

  let candidate = earliest
  for (let attempt = 0; attempt < 7; attempt += 1) {
    if (weekdayOf(candidate) === dayOfWeek) break
    candidate = addDays(candidate, 1)
  }

  const [hour, minute] = arriveBy.split(':').map(Number)
  const [year, month, day] = candidate.split('-').map(Number)
  // Probe with the *approximate* instant to pick the right side of a DST change.
  const probe = new Date(Date.UTC(year, month - 1, day, hour - 10, minute))

  return `${candidate}T${arriveBy}:00${sydneyUtcOffset(probe)}`
}

/** Sydney date + the first free letter suffix — `2026-08-24a`, then `b`, … (§4 step 3). */
export function allocateRunId(existingIds: readonly string[], now: Date = new Date()): string {
  const date = sydneyToday(now)
  const taken = new Set(existingIds)

  for (let index = 0; index < 26; index += 1) {
    const candidate = `${date}${String.fromCharCode(97 + index)}`
    if (!taken.has(candidate)) return candidate
  }

  throw new Error(`[run-id] all 26 suffixes for ${date} are taken — that cannot be right`)
}
