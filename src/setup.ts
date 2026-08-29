import { PROFILE_DIR, warmUp } from "./browser.js";

/**
 * Interactive one-time setup. Kept in its own module so `index.ts` can invoke it
 * without pulling the MCP transport into a plain terminal run.
 */
export async function runSetup(): Promise<void> {
  const log = (s: string) => console.error(`  ${s}`);

  console.error("\nsydney-rental-data-pipeline setup");
  console.error("─".repeat(50));
  console.error("A Chrome window will open briefly so realestate.com.au can issue");
  console.error("its bot-protection token. Leave it alone; it closes on its own.\n");

  try {
    const { title } = await warmUp({ log });
    console.error("─".repeat(50));
    console.error("Setup complete.\n");
    console.error(`  page loaded: ${title}`);
    console.error(`  profile:     ${PROFILE_DIR}\n`);
    console.error("Now add the server to Claude Code:\n");
    console.error('  claude mcp add realestate -s user -- node "<this repo>/dist/cli.js" mcp\n');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("─".repeat(50));
    console.error("Setup failed.\n");
    if (/ProcessSingleton|already (in use|running)|has been closed|in use/i.test(msg)) {
      console.error("  The browser profile is locked by another process.");
      console.error("  Chrome allows only one process per profile directory.\n");
      console.error("  Quit Claude Code (or disconnect the realestate MCP server),");
      console.error("  then run setup again.\n");
    }
    console.error(`  ${msg}\n`);
    process.exitCode = 1;
  }
}
