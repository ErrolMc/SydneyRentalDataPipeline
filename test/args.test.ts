import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import { assertKnownFlags, numericFlag } from '../src/lib/args.js'

test('args', async (t) => {
  /** See the note in the other suites: recorded now, asserted as subtests below. */
  const recorded: Array<[string, () => void]> = []
  function check(label: string, ok: boolean, detail = '') {
    console.log(`  ${ok ? ' ok ' : 'FAIL'}   ${label}${detail ? `  →  ${detail}` : ''}`)
    recorded.push([label, () => assert.ok(ok, `${label}${detail ? ` — ${detail}` : ''}`)])
  }

  const threw = (fn: () => unknown): string | null => {
    try {
      fn()
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  /**
   * The real invocations, verbatim.
   *
   * This is the half that matters. Rejecting unknown flags is only safe if the
   * commands actually used still pass, and `run` forwards its entire flag list
   * to `capture` — so a flag `run` never reads itself must still be accepted.
   * These are the exact shapes RUN-BOTH.md tells an operator to type.
   */
  const RUN_FLAGS = [
    'dry-run', 'resume', 'search', 'skip-absence', 'no-enrich', 'check-remote',
    'run-id', 'capture', 'photos', 'local-images', 'force',
    'out', 'core', 'probe-pages', 'arrive-by', 'only', 'searches',
  ]
  const BUILD_FLAGS = ['dry-run', 'run-id', 'local-images', 'force', 'photos']
  const CAPTURE_FLAGS = ['out', 'core', 'probe-pages', 'arrive-by', 'only', 'searches']

  console.log('\nthe real invocations still pass\n')

  const walkCapture = [
    '--search',
    '--out=/x/captures/2026-09-03-walk15.json',
    '--searches=office-walk-15',
    '--core=Barangaroo NSW 2000,Sydney NSW 2000',
    '--photos=8',
  ]
  check('run --search, the walk capture', threw(() => assertKnownFlags(walkCapture, RUN_FLAGS, 'run')) === null)

  const transitCapture = [
    '--search',
    '--out=/x/captures/2026-09-03-transit25.json',
    '--searches=train-25',
    '--arrive-by=2026-09-08T09:00:00+10:00',
    '--core=Redfern NSW 2016',
    '--photos=8',
  ]
  check(
    'run --search, the transit capture with --arrive-by',
    threw(() => assertKnownFlags(transitCapture, RUN_FLAGS, 'run')) === null,
  )
  check(
    'run --resume --photos=8',
    threw(() => assertKnownFlags(['--resume', '--photos=8'], RUN_FLAGS, 'run')) === null,
  )
  check(
    'run --resume --skip-absence --photos=8',
    threw(() => assertKnownFlags(['--resume', '--skip-absence', '--photos=8'], RUN_FLAGS, 'run')) === null,
  )
  check(
    'run --resume --photos=8 --check-remote',
    threw(() => assertKnownFlags(['--resume', '--photos=8', '--check-remote'], RUN_FLAGS, 'run')) === null,
  )
  check(
    'run --resume --force, for the Monday boundary',
    threw(() => assertKnownFlags(['--resume', '--force', '--photos=8'], RUN_FLAGS, 'run')) === null,
  )
  check(
    'capture accepts what run forwards to it',
    threw(() => assertKnownFlags(walkCapture.filter((a) => a !== '--search' && a !== '--photos=8'), CAPTURE_FLAGS, 'capture')) === null,
  )
  check(
    'build --dry-run --photos=8',
    threw(() => assertKnownFlags(['--dry-run', '--photos=8'], BUILD_FLAGS, 'build')) === null,
  )
  check(
    'a positional path is not a flag',
    threw(() => assertKnownFlags(['/x/capture.json', '--photos=8'], BUILD_FLAGS, 'build')) === null,
  )

  console.log('\ntypos are refused, and named\n')

  const photoTypo = threw(() => assertKnownFlags(['--photo=8'], BUILD_FLAGS, 'build'))
  check('--photo is rejected', photoTypo !== null)
  check('and suggests --photos', (photoTypo ?? '').includes('did you mean --photos'), photoTypo ?? '')

  const remoteTypo = threw(() => assertKnownFlags(['--resume', '--check-remot'], RUN_FLAGS, 'run'))
  check('--check-remot is rejected', remoteTypo !== null)
  check(
    'and suggests --check-remote',
    (remoteTypo ?? '').includes('did you mean --check-remote'),
    remoteTypo ?? '',
  )

  const absenceTypo = threw(() => assertKnownFlags(['--skip-absense'], RUN_FLAGS, 'run'))
  check('--skip-absense is rejected', absenceTypo !== null)

  console.log('\n--photos values\n')

  check('a plain number is taken', numericFlag(['--photos=8'], 'photos', 1) === 8, 'expect 8')
  check('absent falls back', numericFlag([], 'photos', 1) === 1, 'expect 1')
  check('zero is allowed', numericFlag(['--photos=0'], 'photos', 1) === 0, 'expect 0')

  // The silent one: Number("8x") is NaN, slice(0, NaN) is empty, and the run
  // downloads nothing with failed: 0 and a green validate.
  const bad = threw(() => numericFlag(['--photos=8x'], 'photos', 1))
  check('8x is refused rather than read as NaN', bad !== null)
  check('and the message says so', (bad ?? '').includes('NaN'), bad ?? '')
  check('a negative count is refused', threw(() => numericFlag(['--photos=-1'], 'photos', 1)) !== null)
  check('a fraction is refused', threw(() => numericFlag(['--photos=2.5'], 'photos', 1)) !== null)
  check('an empty value is refused', threw(() => numericFlag(['--photos='], 'photos', 1)) !== null)

  console.log('\n(assertions below)\n')

  for (const [label, assertion] of recorded) await t.test(label, assertion)
})
