import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fills `process.env` from a `.env` beside `package.json`, if one is there.
 *
 * Imported for its side effect alone, and it has to stay the **first** import
 * in `index.ts`. `browser.ts` and `distance.ts` read `process.env` at module
 * scope, and ESM evaluates every import before the importing module's own body
 * runs — so a loader that arrives after those modules arrives after they have
 * already taken their values, and silently does nothing for them.
 *
 * The path is resolved from this module rather than from the working
 * directory. The server is always a child process — Claude Code spawns it, and
 * so does the findings repo's pipeline — and neither sets the cwd to this
 * package, so a cwd-relative `.env` would be somebody else's file or no file.
 *
 * **What is already in the environment wins.** `process.loadEnvFile` fills
 * gaps and does not override, so the `env` block of an MCP entry in
 * `~/.claude.json` still beats this file. That makes `.env` the place for a
 * key you would rather not write into a config file that also holds unrelated
 * settings — `TFNSW_API_KEY`, in particular, which is the difference between
 * transit answering in legs from Transport for NSW and falling back to a bare
 * Google duration.
 */
const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

if (existsSync(ENV_PATH)) {
  if (typeof process.loadEnvFile !== "function") {
    // Reading a `.env` needs Node 20.12. Older 20.x still runs the server fine,
    // so say what is being ignored rather than refusing to start.
    console.error(
      `[realestate-mcp] ${ENV_PATH} needs Node 20.12 or newer to be read; ` +
        `this is ${process.version}, so its variables are being ignored.`,
    );
  } else {
    try {
      process.loadEnvFile(ENV_PATH);
    } catch (e) {
      // Present but unreadable is worth a line on stderr: the file exists, so
      // somebody meant it to be used, and a missing key here shows up much
      // later as a quietly worse answer rather than as a failure.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[realestate-mcp] could not read ${ENV_PATH}: ${message}`);
    }
  }
}
