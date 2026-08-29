#!/usr/bin/env node
// Must stay first: fills process.env from `.env` before anything below reads it.
// See src/env.ts.
import "./env.js";

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The pipeline's one entry point: `node dist/cli.js <command> …`.
 *
 * Every data-producing step is still a script under `scripts/` (moved in from
 * the findings repo in MIGRATION.md Phase 1, unchanged). They run at module
 * scope and read `process.argv` themselves, exactly as `tsx scripts/x.ts …`
 * ran them — so this file does not import them at build time. It sets
 * `process.argv` to what the script expects and imports it through tsx, which
 * compiles the TypeScript on the fly and resolves the scripts' extensionless
 * and cross-repo imports the way `npm run <script>` always has. The npm
 * scripts remain as aliases; this is the same thing with a table of contents.
 *
 * `mcp` and `setup` are this package's own code and are imported compiled.
 * `mcp` must be a dynamic import: a static one would connect the server on
 * every invocation.
 *
 * Phase 2 (MIGRATION.md) folds the scripts into `src/lib/` with exported
 * entry points, at which point the tsx hop goes away.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENRICH: Record<string, string> = {
  walk: "enrich-walkability.ts",
  travel: "enrich-travel.ts",
  transit: "enrich-transit.ts",
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
  capture: "audit-capture.ts",
  postcodes: "audit-postcodes.ts",
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
  run                            Phase 2 (MIGRATION.md): capture → build → validate in one
                                 process. Until then, run them in turn per AGENT.md.

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

/**
 * Run one of the moved scripts in this process, with the argv it expects.
 * The import is scoped to tsx; nothing else in this process is affected.
 */
async function runScript(file: string, rest: string[]): Promise<void> {
  const script = join(PACKAGE_ROOT, "scripts", file);
  process.argv = [process.argv[0], script, ...rest];
  const { tsImport } = await import("tsx/esm/api");
  await tsImport(pathToFileURL(script).href, import.meta.url);
}

function pick(table: Record<string, string>, key: string | undefined, what: string): string {
  if (key && table[key]) return table[key];
  usage(2, `${what}: expected one of ${Object.keys(table).join(", ")}${key ? `, got "${key}"` : ""}`);
}

const [command, ...rest] = process.argv.slice(2);

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
    await runScript("capture-run.ts", rest);
    break;

  case "build":
    await runScript("build-run.ts", rest);
    break;

  case "replay":
    await runScript("replay-run.ts", rest);
    break;

  case "envelope":
    await runScript("build-envelope.ts", rest);
    break;

  case "enrich":
    await runScript(pick(ENRICH, rest[0], "enrich"), rest.slice(1));
    break;

  case "check": {
    const names = rest.length ? [rest[0]] : DEFAULT_CHECKS;
    // `check shares <capture>` passes the capture on; the rest take nothing.
    for (const name of names) await runScript(pick(CHECKS, name, "check"), rest.slice(1));
    break;
  }

  case "validate":
    await runScript("validate-data.ts", rest);
    break;

  case "audit":
    await runScript(pick(AUDITS, rest[0], "audit"), rest.slice(1));
    break;

  case "reset":
    await runScript("reset-data.ts", rest);
    break;

  case "run":
    usage(2, "`run` is Phase 2 (MIGRATION.md). For now: capture, then build, then validate.");
    break;

  default:
    usage(2, `unknown command "${command}"`);
}
