#!/usr/bin/env node
// Must stay first: fills process.env from `.env` before anything below reads it.
// See src/env.ts.
import "./env.js";

import { StageError } from "./lib/stage-error.js";

/**
 * The pipeline's one entry point: `node dist/cli.js <command> …`.
 *
 * Every data-producing step is a module under `src/stages/` exporting
 * `main(argv)`, and this dispatches to it. Until PHASE2.md Step 3 they were
 * scripts under `scripts/` that ran at module scope and read `process.argv`
 * themselves, and this file re-launched them through tsx with a spliced argv —
 * compiling TypeScript on every invocation to run code this package had
 * already built.
 *
 * The imports are dynamic, and deliberately so: a stage's module scope pulls in
 * what it needs — patchright for `capture`, sharp for `build` — and a static
 * import would pay for all of it on `--help`.
 *
 * A stage signals failure by throwing (`lib/stage-error.ts`), never by exiting,
 * so that `run` can compose them and say which one stopped. The printing and
 * the exit code happen here, in the one place.
 */

const ENRICH: Record<string, string> = {
  walk: "enrich-walkability",
  travel: "enrich-travel",
  transit: "enrich-transit",
};

const CHECKS: Record<string, string> = {
  scoring: "check-scoring.ts",
  walk: "check-walkability.ts",
  searches: "check-searches.ts",
  transit: "check-transit.ts",
  ledger: "check-ledger.ts",
  shares: "check-shares.ts",
  r2: "check-r2.ts",
};

/** What `check` runs with no names: everything that needs no argument and no network. */
const DEFAULT_CHECKS = ["scoring", "walk", "searches", "transit", "ledger"];

const AUDITS: Record<string, string> = {
  capture: "audit-capture",
  postcodes: "audit-postcodes",
};

const USAGE = `sydney-rental-data-pipeline — writes ../SydneyRealEstateFindings/data/

usage: node dist/cli.js <command> [args]

  setup                          warm the Chrome profile once (opens a window briefly)
  capture [--out=…] [--only=…]   search realestate.com.au per data/config — ASK ERROL FIRST.
                                 Holds the Chrome profile: no MCP server may be running.
  build <capture> [--run-id=…]   map a capture into a run: ledger, scores, photos, index
  replay <capture> --run-id=…    rebuild a committed run from its capture (byte-identical
                                 when nothing changed — this is the migration's proof)
  envelope --stage=…             derive the search envelope (findings repo, ENVELOPE.md)
  enrich walk|travel|transit     add walkability / travel / transit legs to the ledger
  check [name …]                 self-checks. Default: ${DEFAULT_CHECKS.join(" ")}.
                                 Also: shares <capture>, r2
  validate [--check-remote]      validate the findings repo's data/ (the gate before a commit)
  audit capture <file> | postcodes
  reset [--confirm]              destroy runs, photos and knowledge — dry run without --confirm
  mcp                            serve the MCP adapter over stdio: search_listings,
                                 get_listing, get_listing_photos, resolve_location
  run --capture=<path>           the whole run in one process: absence gate → build →
                                 enrich → replay → validate. Stops at the two human
                                 gates (AGENT.md §4d, §9c). --resume goes on from
                                 the first. Add --search to take a fresh capture
                                 — ASK ERROL FIRST.

Paths given to a script (a capture, --out, --cache) resolve against the current
directory, so prefer absolute ones. Every npm script in package.json is an alias
for one of these; \`npm run replay:run -- <capture> --run-id=…\` is \`replay\`.

The findings repo is found as ../SydneyRealEstateFindings, or \$FINDINGS_DIR.
Keys live in .env beside package.json (copy .env.example).
`;

function usage(exitCode: number, message?: string): never {
  if (message) console.error(`${message}\n`);
  (exitCode === 0 ? console.log : console.error)(USAGE);
  process.exit(exitCode);
}

/** Run one of the stage modules, with the argv it expects. */
async function runStage(name: string, argv: string[]): Promise<void> {
  const stage = (await import(`./stages/${name}.js`)) as {
    main: (argv: string[]) => Promise<void>;
  };
  await stage.main(argv);
}

/**
 * The seven checks are still scripts, and still run through tsx — PHASE2.md
 * Step 6 turns them into a `node --test` suite, which is where the tsx
 * dependency finally goes.
 */
async function runCheck(file: string, rest: string[]): Promise<void> {
  const { join, dirname } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", file);
  process.argv = [process.argv[0], script, ...rest];
  const { tsImport } = await import("tsx/esm/api");
  await tsImport(pathToFileURL(script).href, import.meta.url);
}

function pick(table: Record<string, string>, key: string | undefined, what: string): string {
  if (key && table[key]) return table[key];
  usage(2, `${what}: expected one of ${Object.keys(table).join(", ")}${key ? `, got "${key}"` : ""}`);
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage(0);
      break;

    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      break;
    }

    case "mcp":
      await import("./mcp.js");
      break;

    case "capture":
      await runStage("capture", rest);
      break;

    case "build":
      await runStage("build", rest);
      break;

    case "replay":
      await runStage("replay", rest);
      break;

    case "envelope":
      await runStage("envelope", rest);
      break;

    case "enrich":
      await runStage(pick(ENRICH, rest[0], "enrich"), rest.slice(1));
      break;

    case "check": {
      const names = rest.length ? [rest[0]] : DEFAULT_CHECKS;
      // `check shares <capture>` passes the capture on; the rest take nothing.
      for (const name of names) await runCheck(pick(CHECKS, name, "check"), rest.slice(1));
      break;
    }

    case "validate":
      await runStage("validate", rest);
      break;

    case "audit":
      await runStage(pick(AUDITS, rest[0], "audit"), rest.slice(1));
      break;

    case "reset":
      await runStage("reset", rest);
      break;

    case "run":
      await runStage("run", rest);
      break;

    default:
      usage(2, `unknown command "${command}"`);
  }
} catch (error) {
  // A stage that has already printed its own report wants the exit code and
  // nothing else — `validate` prints a problem list under its own heading.
  if (!(error instanceof StageError && error.reported)) {
    console.error(`\n✖ ${(error as Error).message}\n`);
  }
  process.exit(1);
}
