// Must stay first: fills process.env from this package's `.env` (see src/env.ts).
import '../env.js'

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { IndexSchema, LedgerSchema } from 'sydney-rental-schema'
import { assertKnownFlags } from '../lib/args.js'
import { closeContext } from '../browser.js'
import { dataPath, readJsonFile, PACKAGE_ROOT } from '../lib/json-io.js'
import { getListing } from '../lib/listing-detail.js'
import { ReaCaptureSchema, flattenCapture } from '../lib/rea.js'
import { StageError, fail } from '../lib/stage-error.js'

/**
 * A whole run in one process, stopping where a human is needed.
 *
 *   node dist/cli.js run --capture=<path> [--resume] [--run-id=…]
 *
 * ## What this replaces
 *
 * Eight commands typed in order, from AGENT.md §4–10: capture, then resolve
 * every absence by hand through `get_listing`, then build, then the three
 * enrichers, then a replay to fold their answers into the run they were
 * measured after, then validate. Getting the order wrong is silent — a replay
 * skipped is a run committed without its walkability, and an absence unresolved
 * is a listing that drifts to `stale` for having moved out of a travel budget.
 *
 * ## The two gates stay human, and this does their legwork
 *
 * **Absence (AGENT.md §4d).** Every ledger listing that is `active` and absent
 * from this capture gets its page fetched, and the verdict written into the
 * capture's `gone` map. Then this **stops**: the table is for Errol to read,
 * because "page gone" and "leased" are the same evidence and a different word,
 * and because a listing this could not reach is left out of the map entirely
 * rather than guessed at. `--resume` goes on from there.
 *
 * **Commentary (AGENT.md §9c).** A run with no commentary is not ready to
 * commit. This does not stop for it — nothing downstream depends on it — but it
 * refuses to report the run as ready, and says which file to write it into.
 *
 * ## What it will not do without being told twice
 *
 * A real REA pass. `--capture` names one already taken; `--search` is the
 * explicit opt-in to going and getting one, and Errol is asked before that,
 * every time, as everywhere else in this repo.
 */

interface RunState {
  /** Absolute path to the capture this run is being built from. */
  capture: string
  /** Allocated by `build`; read back out of index.json rather than guessed. */
  runId: string | null
  /** Stage names already finished, so `--resume` starts where it stopped. */
  done: string[]
}

const STATE_PATH = path.join(PACKAGE_ROOT, 'scratch', 'run-state.json')

/** Every stage, in order. `run` walks this and skips what the state says is done. */
const ORDER = [
  'capture',
  'absence',
  'build',
  'enrich-walkability',
  'enrich-travel',
  'enrich-transit',
  'replay',
  'validate',
] as const

async function readState(): Promise<RunState | null> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as RunState
  } catch {
    return null
  }
}

/**
 * A dry run walks the whole thing and leaves nothing behind — including this.
 * Writing state would make the next real `run` think it was resuming a run that
 * never happened.
 */
async function writeState(state: RunState, dryRun: boolean): Promise<void> {
  if (dryRun) return
  await mkdir(path.dirname(STATE_PATH), { recursive: true })
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** `main` of one stage module, imported the same way the CLI imports them. */
async function stageMain(name: string): Promise<(argv: string[]) => Promise<void>> {
  const module = (await import(`./${name}.js`)) as { main: (argv: string[]) => Promise<void> }
  return module.main
}

function heading(text: string): void {
  console.log(`\n${'─'.repeat(74)}\n  ${text}\n${'─'.repeat(74)}`)
}

/**
 * What a fetched page says about a listing that stopped coming back.
 *
 * `leased` and `withdrawn` are the same evidence read two ways — the ad is no
 * longer offering the place — so only the one the page states outright is
 * proposed, and the gate prints the rest for a human to name. A page that could
 * not be reached produces **no** verdict: AGENT.md's rule is that an unchecked
 * absence is left out of the map, where two consecutive absences make it
 * `stale`, and a network failure is not evidence about a tenancy.
 */
type Verdict = 'leased' | 'unmatched'

const LEASED = /leased|under application|deposit taken|application approved/i

interface AbsenceRow {
  id: string
  address: string
  verdict: Verdict | null
  evidence: string
}

async function resolveAbsences(capturePath: string, dryRun: boolean): Promise<void> {
  const [ledger, raw] = await Promise.all([
    readJsonFile(dataPath('knowledge', 'listings.json'), LedgerSchema),
    readFile(capturePath, 'utf8'),
  ])
  const captureJson = JSON.parse(raw) as Record<string, unknown>
  const capture = ReaCaptureSchema.parse(captureJson)
  const returned = flattenCapture(capture).returnedIds

  const absent = Object.entries(ledger.listings).filter(
    ([id, entry]) => entry.status === 'active' && !returned.has(id),
  )
  // A verdict already in the capture is one already paid for. Re-running the
  // gate after a bot block fetches only what is still unanswered, which is what
  // makes a partial pass worth anything.
  const already = (captureJson.gone ?? {}) as Record<string, string>
  const todo = absent.filter(([id]) => !(id in already))

  console.log(`  ${Object.keys(ledger.listings).length} ledger listing(s), ${returned.size} returned by this capture`)
  console.log(`  ${absent.length} active listing(s) absent — each costs one page fetch`)
  if (absent.length !== todo.length) {
    console.log(`  ${absent.length - todo.length} already have a verdict in the capture — not re-fetched`)
  }

  if (todo.length === 0) {
    console.log(`\n  ${absent.length === 0 ? 'Nothing absent.' : 'Every absence already has a verdict.'}\n`)
    return
  }
  if (dryRun) {
    console.log(`\n  Dry run — would fetch ${todo.length} listing page(s) and write the gone map.\n`)
    return
  }

  const rows: AbsenceRow[] = []
  const gone: Record<string, Verdict> = {}

  /** Every CHECKPOINT rows, so a bot block costs the last few and not the pass. */
  const CHECKPOINT = 25
  const persist = async () => {
    captureJson.gone = { ...already, ...gone }
    await writeFile(capturePath, `${JSON.stringify(captureJson, null, 2)}\n`, 'utf8')
  }

  try {
    for (const [id, entry] of todo) {
      try {
        const detail = await getListing(entry.url ?? id)
        const price = detail.price ?? ''
        const verdict: Verdict = LEASED.test(price) ? 'leased' : 'unmatched'
        rows.push({ id, address: entry.address, verdict, evidence: price || 'page live' })
        gone[id] = verdict
      } catch (error) {
        // Not a verdict. A 404 and a dropped connection look the same from here,
        // and only one of them is evidence about the listing.
        rows.push({ id, address: entry.address, verdict: null, evidence: (error as Error).message.slice(0, 60) })
      }
      process.stdout.write(`\r  checked ${rows.length}/${todo.length}`)
      if (rows.length % CHECKPOINT === 0) await persist()
    }
  } finally {
    // Including on the way out of a bot block: what was checked is written down.
    await persist()
    console.log('')
  }

  console.log('')
  for (const row of rows) {
    const verdict = row.verdict ?? 'UNCHECKED'
    console.log(`  ${row.id.padEnd(11)} ${verdict.padEnd(10)} ${row.address.slice(0, 42).padEnd(44)} ${row.evidence}`)
  }

  const unchecked = rows.filter((row) => !row.verdict).length
  const leased = rows.filter((row) => row.verdict === 'leased').length
  console.log(
    `\n  ${leased} leased · ${rows.length - leased - unchecked} still listed but outside every search · ` +
      `${unchecked} unchecked`,
  )
  if (unchecked > 0) {
    console.log(
      `  The ${unchecked} unchecked are NOT in the gone map. Two consecutive absences make them\n` +
        '  stale on their own; write "withdrawn" beside one by hand if you know better.',
    )
  }
}

/** Whether transit enrichment can produce what it is for. */
function transitReady(): string | null {
  const router = process.env.REALESTATE_MCP_TRANSIT_ROUTER?.trim()
  if (router === 'tfnsw' && process.env.TFNSW_API_KEY?.trim()) return null
  return router === 'tfnsw'
    ? 'REALESTATE_MCP_TRANSIT_ROUTER=tfnsw but TFNSW_API_KEY is empty'
    : `transit router is "${router || 'unset'}", not tfnsw — only TfNSW answers in legs`
}

/**
 * Everything `run` reads, plus everything it forwards.
 *
 * The capture stage gets `argv.filter((a) => a.startsWith('--'))` — the whole
 * flag list, unfiltered — so rejecting a name this stage does not itself read
 * would reject the arguments it exists to pass on.
 */
const RUN_FLAGS = [
  // run's own
  'dry-run', 'resume', 'search', 'skip-absence', 'no-enrich', 'check-remote',
  'run-id', 'capture', 'photos', 'local-images', 'force',
  // forwarded to capture
  'out', 'core', 'probe-pages', 'arrive-by', 'only', 'searches',
] as const

export async function main(argv: string[]): Promise<void> {
  assertKnownFlags(argv, RUN_FLAGS, 'run')

  const DRY_RUN = argv.includes('--dry-run')
  const RESUME = argv.includes('--resume')
  const SEARCH = argv.includes('--search')
  const SKIP_ABSENCE = argv.includes('--skip-absence')
  const NO_ENRICH = argv.includes('--no-enrich')
  const RUN_ID_OVERRIDE = argv.find((a) => a.startsWith('--run-id='))?.slice(9)
  const CAPTURE_ARG = argv.find((a) => a.startsWith('--capture='))?.slice(10)
  // `--force` is here because `build` refuses a capture whose transit arrive-by
  // is not the one it computes, and that moment rolls forward every Monday — so a
  // `--resume` that crosses a weekend needs a way through that `run` can offer.
  const PASS_THROUGH = argv.filter(
    (a) => a.startsWith('--photos=') || a === '--local-images' || a === '--force',
  )

  const previous = RESUME ? await readState() : null
  if (RESUME && !previous) {
    fail(`--resume, but no run is in progress (${path.relative(PACKAGE_ROOT, STATE_PATH)} is absent)`)
  }

  // `--out` is `capture`'s own flag, and with `--search` it is also where the
  // rest of this run reads from — every stage after the capture needs the path,
  // not just the stage that writes it.
  const OUT = argv.find((a) => a.startsWith('--out='))?.slice(6)

  const capturePath = CAPTURE_ARG
    ? path.resolve(CAPTURE_ARG)
    : SEARCH && OUT
      ? path.resolve(OUT)
      : previous?.capture ?? null

  if (!capturePath) {
    fail(
      [
        'usage: node dist/cli.js run --capture=<path> [--run-id=…] [--resume]',
        '',
        '  --capture names a capture already taken. To go and take one — a real pass',
        '  against realestate.com.au, which Errol is asked about every time — pass',
        `  --search and --out=<path>${SEARCH ? '; --out is the one missing here' : ''}.`,
      ].join('\n'),
    )
  }

  // A dry run reads the capture at every stage; with --search there is not one
  // yet, and every stage after the skipped capture would fail on the same
  // missing file. Say so once, here.
  if (DRY_RUN && !existsSync(capturePath)) {
    fail(
      [
        `a dry run reads a capture, and ${path.basename(capturePath)} does not exist yet.`,
        '  --search --dry-run has nothing to walk: either drop --dry-run, or point',
        '  --capture at a capture you already have.',
      ].join('\n'),
    )
  }

  const state: RunState = previous ?? {
    capture: capturePath,
    runId: RUN_ID_OVERRIDE ?? null,
    done: [],
  }
  state.capture = capturePath
  if (RUN_ID_OVERRIDE) state.runId = RUN_ID_OVERRIDE

  const skipped: string[] = []

  for (const stage of ORDER) {
    if (state.done.includes(stage)) continue

    switch (stage) {
      case 'capture': {
        if (!SEARCH) {
          skipped.push('capture — started from a capture already taken')
          break
        }
        heading('capture — a real pass against realestate.com.au')
        if (!DRY_RUN) await (await stageMain('capture'))(argv.filter((a) => a.startsWith('--')))
        break
      }

      case 'absence': {
        if (SKIP_ABSENCE) {
          skipped.push('absence — --skip-absence; say so in the commentary (AGENT.md §4d)')
          break
        }
        heading('absence gate — which of the missing are actually gone')
        await resolveAbsences(state.capture, DRY_RUN)
        // The capture now carries proposed verdicts. Stop: they are a reading of
        // the evidence, and the reading is Errol's.
        state.done.push(stage)
        await writeState(state, DRY_RUN)
        if (!DRY_RUN) {
          console.log(
            [
              '',
              '  ── gate 1 of 2 ─────────────────────────────────────────────────────────',
              `  The gone map is written into ${path.basename(state.capture)}. Read the table above,`,
              '  correct any verdict you disagree with, then:',
              '',
              '      node dist/cli.js run --resume',
              '',
            ].join('\n'),
          )
          return
        }
        continue
      }

      case 'build': {
        heading('build — ledger, scores, photos, index')
        const args = [state.capture, ...PASS_THROUGH]
        if (state.runId) args.push(`--run-id=${state.runId}`)
        if (DRY_RUN) args.push('--dry-run')
        await (await stageMain('build'))(args)
        if (!DRY_RUN) {
          const index = await readJsonFile(dataPath('index.json'), IndexSchema)
          state.runId = index.current_run
        }
        break
      }

      case 'enrich-walkability':
      case 'enrich-travel': {
        if (NO_ENRICH) {
          skipped.push(`${stage} — --no-enrich`)
          break
        }
        heading(stage === 'enrich-travel' ? 'enrich travel — routed walk times' : 'enrich walk — the corner shop')
        await (await stageMain(stage))(DRY_RUN ? ['--dry-run'] : [])
        break
      }

      case 'enrich-transit': {
        const why = transitReady()
        if (NO_ENRICH || why) {
          skipped.push(`enrich-transit — ${NO_ENRICH ? '--no-enrich' : why}`)
          break
        }
        heading('enrich transit — what the commute is made of')
        await (await stageMain(stage))(DRY_RUN ? ['--dry-run'] : [])
        break
      }

      case 'replay': {
        // Enrichment writes the ledger, not the run — a routed minute is a fact
        // about a place, not about a moment (ITEM-3 §3.4). The replay is what
        // folds it into the run just built, and is why enrichment needed a
        // second command before this stage existed.
        if (NO_ENRICH) {
          skipped.push('replay — nothing was enriched, so the run already carries everything')
          break
        }
        heading('replay — fold the enrichment into the run')
        if (!DRY_RUN) {
          if (!state.runId) fail('no run id to replay — build did not report one')
          await (await stageMain('replay'))([state.capture, `--run-id=${state.runId}`])
        }
        break
      }

      case 'validate': {
        heading('validate — the gate before a commit')
        await (await stageMain('validate'))(argv.includes('--check-remote') ? ['--check-remote'] : [])
        break
      }
    }

    state.done.push(stage)
    await writeState(state, DRY_RUN)
  }

  // The browser is only open if `capture` or the absence gate opened it, and
  // Chrome holds an exclusive lock on the profile until this process lets go.
  await closeContext()

  heading(`run ${state.runId ?? '(dry run)'} — done`)
  for (const note of skipped) console.log(`  skipped   ${note}`)

  if (DRY_RUN) {
    console.log('\n  Dry run — nothing was written.\n')
    return
  }

  const run = state.runId
    ? JSON.parse(await readFile(dataPath('runs', state.runId, 'run.json'), 'utf8'))
    : null
  const commentary = String(run?.commentary ?? '').trim()

  console.log(`\n  wrote     data/runs/${state.runId}/run.json and the knowledge files`)

  if (!commentary) {
    console.log(
      [
        '',
        '  ── gate 2 of 2 ─────────────────────────────────────────────────────────',
        `  commentary is empty. Write it into data/runs/${state.runId}/run.json —`,
        '  what is new, what dropped in price, standouts, suburb observations',
        '  (AGENT.md §0 for the markdown subset) — before committing.',
        '',
      ].join('\n'),
    )
    throw new StageError(`run ${state.runId} is built but has no commentary, so it is not ready to commit`)
  }

  console.log('\n  Ready to commit. Both gates passed.\n')
}
