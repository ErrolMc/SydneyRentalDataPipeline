import { PROFILE_DIR, warmUp } from "./browser.js";

/**
 * Interactive one-time setup. Kept in its own module so `index.ts` can invoke it
 * without pulling the MCP transport into a plain terminal run.
 */
export async function runSetup(): Promise<void> {
  const log = (s: string) => console.error(`  ${s}`);

  console.error("\nrealestate-mcp setup");
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
    console.error("  claude mcp add realestate -- npx -y realestate-mcp\n");
  } catch (e) {
    console.error("─".repeat(50));
    console.error("Setup failed.\n");
    console.error(`  ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
