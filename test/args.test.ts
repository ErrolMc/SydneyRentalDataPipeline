import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../src/env.js'

import {
  BUILD_FLAGS,
  CAPTURE_FLAGS,
  RUN_FLAGS,
  assertKnownFlags,
  forwardFlags,
  numericFlag,
} from '../src/lib/args.js'

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
   * commands actually used still pass. `run` accepts capture's flags as well as
   * its own, and forwards each stage only what that stage reads. These are the
   * exact shapes RUN-BOTH.md tells an operator to type.
   */
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
  /**
   * The one that matters, and the one an earlier version of this file got wrong
   * by hand-filtering the list before asserting on it — which tested the
   * assumption instead of the call. `run` really does hand these to `capture`,
   * so the forwarding is part of what is under test. Getting this wrong stopped
   * run 2's capture dead at the first line.
   */
  for (const [label, invocation] of [
    ['walk', walkCapture],
    ['transit', transitCapture],
  ] as const) {
    const forwarded = forwardFlags(invocation, CAPTURE_FLAGS)
    check(
      `capture accepts exactly what run forwards it (${label})`,
      threw(() => assertKnownFlags(forwarded, CAPTURE_FLAGS, 'capture')) === null,
      forwarded.join(' '),
    )
    check(
      `and run's own flags are not forwarded (${label})`,
      !forwarded.includes('--search') && !forwarded.some((f) => f.startsWith('--photos=')),
      forwarded.join(' '),
    )
  }
  check(
    'the capture still receives the arguments it needs',
    forwardFlags(transitCapture, CAPTURE_FLAGS).some((f) => f.startsWith('--out=')) &&
      forwardFlags(transitCapture, CAPTURE_FLAGS).some((f) => f.startsWith('--core=')) &&
      forwardFlags(transitCapture, CAPTURE_FLAGS).some((f) => f.startsWith('--arrive-by=')) &&
      forwardFlags(transitCapture, CAPTURE_FLAGS).some((f) => f.startsWith('--searches=')),
    forwardFlags(transitCapture, CAPTURE_FLAGS).join(' '),
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
