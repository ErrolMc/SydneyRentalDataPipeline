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

/**
 * The suites under `test/`, run by `node --test` out of `dist-test/`.
 * `shares`, `studios` and `r2` are not among them: two take a capture path and
 * the third talks to R2, and none belongs in a runner invoked with no arguments.
 */
const SUITES: Record<string, string> = {
  args: "args",
  scoring: "scoring",
  walk: "walkability",
  searches: "searches",
  transit: "transit",
  ledger: "ledger",
  suburbs: "suburbs",
  cache: "cache",
  studio: "studio",
  capture: "capture",
  warnings: "warnings",
};

/** The three that stayed commands, because of an argument and a network. */
const CHECK_STAGES: Record<string, string> = {
  shares: "check-shares",
  studios: "check-studios",
  r2: "check-r2",
};

/** What `check` runs with no names: everything that needs no argument and no network. */
const DEFAULT_CHECKS = Object.keys(SUITES);

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
  check [name]                   node --test over test/. Default: ${DEFAULT_CHECKS.join(" ")}.
                                 Also: shares <capture>, studios <capture>, r2 —
                                 an argument and a network, so they are commands,
                                 not suites.
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
 * Run test suites in a child `node --test`. Its reporter writes the pass/fail
 * summary itself, so a failure here wants the exit code and nothing added to it.
 */
async function runSuites(names: string[]): Promise<void> {
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { existsSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Names are keys of SUITES. Checked rather than assumed, because the failure
  // is otherwise indistinguishable from an unbuilt tree: `SUITES[unknown]` is
  // undefined, which builds "undefined.test.js", which is reliably missing.
  const unknown = names.filter((name) => SUITES[name] == null);
  if (unknown.length > 0) {
    throw new StageError(
      `unknown suite(s): ${unknown.join(", ")} — expected ${Object.keys(SUITES).join(", ")}`,
    );
  }

  const files = names.map((name) => join(root, "dist-test", "test", `${SUITES[name]}.test.js`));

  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new StageError("the test suites are not built — run `npm run build`");
  }

  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  if (result.status !== 0) throw new StageError("", true);
}

/**
 * The validated *key*, for a caller that resolves the table itself.
 *
 * `runSuites` re-reads `SUITES` to build a filename, so handing it a value made
 * `check walk` look up `SUITES["walkability"]`, find nothing, and report the
 * suites as unbuilt — a message about the build for what is really a name.
 * `walk -> walkability` is the only entry whose key and value differ, which is
 * why nine of the ten names worked and hid it.
 */
function pickKey(table: Record<string, string>, key: string | undefined, what: string): string {
  if (key && table[key]) return key;
  usage(2, `${what}: expected one of ${Object.keys(table).join(", ")}${key ? `, got "${key}"` : ""}`);
}

/** The validated value — what `enrich` and `audit` want, being module names. */
function pick(table: Record<string, string>, key: string | undefined, what: string): string {
  return table[pickKey(table, key, what)];
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
      const name = rest[0];
      // `check shares|studios <capture>` and `check r2` are commands; the rest are suites.
      if (name && CHECK_STAGES[name]) {
        await runStage(CHECK_STAGES[name], rest.slice(1));
      } else if (name) {
        await runSuites([pickKey(SUITES, name, "check")]);
      } else {
        await runSuites(DEFAULT_CHECKS);
      }
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
