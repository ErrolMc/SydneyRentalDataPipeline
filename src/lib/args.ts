import { fail } from './stage-error.js'

/**
 * Flags that are not flags, and numbers that are not numbers.
 *
 * Both failures used to be silent and both cost a live pass against
 * realestate.com.au to discover:
 *
 *   - A mistyped flag name was simply not read. `--photo=8`, `--check-remot`,
 *     `--skip-absense` all fell through to defaults and exited 0, so the run did
 *     something other than what was asked and said nothing about it.
 *   - A mistyped `--photos` *value* was worse. `Number("8x")` is `NaN`,
 *     `slice(0, NaN)` is empty, and the run downloaded **zero** photos with
 *     `failed: 0`, no warning, and a green `validate`.
 *
 * Neither is recoverable after the fact: the capture is a real pass against a
 * bot-protected site, so being told at the end is being told too late. Both are
 * therefore checked before a stage does any work.
 */

/** Everything `capture` reads. */
export const CAPTURE_FLAGS = ['out', 'core', 'probe-pages', 'arrive-by', 'only', 'searches'] as const

/** Everything `reset` reads. */
export const RESET_FLAGS = ['confirm', 'run'] as const

/** Everything `build` reads. */
export const BUILD_FLAGS = ['dry-run', 'run-id', 'local-images', 'force', 'photos'] as const

/**
 * Everything `run` reads, plus everything it forwards.
 *
 * `run` is the only stage a person types directly, so it has to accept the
 * flags of the stages it drives — but it must then hand each stage only the
 * flags that stage reads. Forwarding its whole list made `capture` reject
 * `--search` and `--photos`, which are `run`'s own. Use `forwardFlags`.
 */
export const RUN_FLAGS = [
  'dry-run', 'resume', 'search', 'skip-absence', 'no-enrich', 'check-remote',
  'run-id', 'capture', 'photos', 'local-images', 'force',
  ...CAPTURE_FLAGS,
] as const

/** The name out of `--name` or `--name=value`. Anything else is not a flag. */
function flagName(token: string): string | null {
  if (!token.startsWith('--')) return null
  const body = token.slice(2)
  const eq = body.indexOf('=')
  return eq === -1 ? body : body.slice(0, eq)
}

/**
 * A cheap "did you mean", because these are typos rather than wrong guesses —
 * the name is nearly right and the useful answer is the one character that is
 * off. One edit apart, or one being a prefix of the other, covers `--photo` for
 * `--photos` and `--check-remot` for `--check-remote`.
 */
function nearest(name: string, known: readonly string[]): string | null {
  const close = known.filter(
    (candidate) =>
      candidate.startsWith(name) || name.startsWith(candidate) || editDistance(name, candidate) <= 2,
  )
  return close.length > 0 ? close[0] : null
}

function editDistance(a: string, b: string): number {
  // Only ever called on flag names, so the quadratic table is a few hundred cells.
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return rows[a.length][b.length]
}

/**
 * Refuses any `--flag` the stage does not read.
 *
 * `known` is what this stage reads. A stage that drives others accepts their
 * flags too (`RUN_FLAGS`), but must hand each one only what it reads —
 * `forwardFlags` does that. Forwarding the lot is what made `capture` refuse
 * `--search` and `--photos`, which are `run`'s own and which capture had until
 * then been silently ignoring.
 */
export function assertKnownFlags(
  argv: readonly string[],
  known: readonly string[],
  what: string,
): void {
  const allowed = new Set(known)
  const unknown = argv
    .map(flagName)
    .filter((name): name is string => name !== null && !allowed.has(name))

  if (unknown.length === 0) return

  fail(
    [
      `${what}: unknown flag(s) ${unknown.map((n) => `--${n}`).join(', ')}`,
      ...unknown.flatMap((name) => {
        const guess = nearest(name, known)
        return guess ? [`    --${name} — did you mean --${guess}?`] : []
      }),
      '',
      `  known flags: ${[...known].sort().map((n) => `--${n}`).join(', ')}`,
      '  An unread flag would otherwise fall through to a default and exit 0,',
      '  which on a live capture is discovered far too late.',
    ].join('\n'),
  )
}

/**
 * The subset of `argv` a downstream stage actually reads.
 *
 * The counterpart to `assertKnownFlags`: once a stage refuses flags it does not
 * know, whatever drives it must stop passing them. Positional arguments are
 * dropped — every caller supplies those itself.
 */
export function forwardFlags(argv: readonly string[], known: readonly string[]): string[] {
  const allowed = new Set(known)
  return argv.filter((token) => {
    const name = flagName(token)
    return name !== null && allowed.has(name)
  })
}

/**
 * A `--name=<n>` that is a whole number, or a refusal.
 *
 * `Number()` alone turns `8x` into `NaN`, and every downstream use of it —
 * `slice(0, NaN)`, `Math.max(0, NaN - x)` — degrades to zero rather than
 * throwing, so the run completes, validates and commits having quietly done
 * nothing.
 */
export function numericFlag(
  argv: readonly string[],
  name: string,
  fallback: number,
): number {
  const prefix = `--${name}=`
  const raw = argv.find((token) => token.startsWith(prefix))?.slice(prefix.length)
  if (raw === undefined) return fallback

  const value = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(value) || value < 0) {
    fail(
      `--${name}=${raw} is not a whole number — it would read as ${
        Number.isNaN(value) ? 'NaN' : String(value)
      } and silently do nothing.`,
    )
  }
  return value
}
