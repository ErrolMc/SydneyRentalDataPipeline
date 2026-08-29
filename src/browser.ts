import { chromium, type BrowserContext, type Page } from "patchright";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * realestate.com.au sits behind Kasada. Everything about this module exists to
 * work within that constraint:
 *
 *  - Real installed Chrome (`channel: "chrome"`), never bundled Chromium — the
 *    bundled build is fingerprinted and 429s.
 *  - A persistent profile, because the Kasada token is minted once and reused.
 *  - The token can only be minted by a HEADED run (see `warmUp`). Once the
 *    profile is warm, headless works indefinitely.
 *
 * Do not set a custom userAgent or extra headers here. Patchright's evasions are
 * undone by that kind of tampering, and the request starts getting challenged.
 */

export const PROFILE_DIR =
  process.env.REALESTATE_MCP_PROFILE ?? join(homedir(), ".realestate-mcp", "profile");

const CHANNEL = process.env.REALESTATE_MCP_CHANNEL ?? "chrome";
const NAV_TIMEOUT = Number(process.env.REALESTATE_MCP_TIMEOUT ?? 60_000);

/** Thrown when the profile has no valid Kasada token. Recoverable via `setup`. */
export class NotWarmError extends Error {
  constructor(detail: string) {
    super(
      `Blocked by realestate.com.au bot protection (${detail}).\n` +
        `The browser profile needs a one-time interactive warm-up.\n` +
        `Run:  node dist/cli.js setup   (in the pipeline repo)\n` +
        `(opens a Chrome window briefly, then closes it)`,
    );
    this.name = "NotWarmError";
  }
}

const contextOptions = {
  channel: CHANNEL,
  locale: "en-AU",
  timezoneId: "Australia/Sydney",
  viewport: { width: 1440, height: 900 },
} as const;

/**
 * Chrome takes an exclusive lock on its user-data-dir, so a long-lived context
 * would stop `setup` (a separate process) from ever warming the profile while
 * the MCP server is running — and would keep serving the cookies it loaded at
 * startup. We therefore drop the context after a short idle period.
 */
const IDLE_MS = Number(process.env.REALESTATE_MCP_IDLE ?? 30_000);

let shared: BrowserContext | null = null;
let inFlight = 0;
let idleTimer: NodeJS.Timeout | null = null;

async function launch(headless: boolean): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, { ...contextOptions, headless });
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (inFlight === 0) void closeContext();
  }, IDLE_MS);
  idleTimer.unref?.();
}

/** Lazily open (and reuse) the headless context used to serve tool calls. */
export async function getContext(): Promise<BrowserContext> {
  if (shared) return shared;
  try {
    shared = await launch(true);
  } catch (e) {
    const msg = (e as Error).message;
    if (/ProcessSingleton|already (in use|running)|has been closed/i.test(msg)) {
      throw new Error(
        `Could not open the browser profile at ${PROFILE_DIR} — another process ` +
          `is using it.\nThis usually means a 'setup' run is still open, or a ` +
          `stray Chrome is holding it. Close it and try again.\n\nUnderlying: ${msg}`,
      );
    }
    throw e;
  }
  shared.on("close", () => {
    shared = null;
  });
  return shared;
}

export async function closeContext(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!shared) return;
  const ctx = shared;
  shared = null;
  try {
    await ctx.close();
  } catch {
    /* already gone */
  }
}

/**
 * A page is "blocked" when Kasada served its challenge shim instead of content.
 * The tell is a tiny body with no real <title>; the status is 429.
 */
function looksBlocked(title: string, html: string): boolean {
  if (html.length < 5_000) return true;
  if (!title.trim()) return true;
  return /^Access Denied|Pardon Our Interruption/i.test(title);
}

export interface FetchedPage {
  html: string;
  title: string;
  url: string;
  status: number | null;
}

/**
 * Navigate to `url` in the warm headless context and return the settled HTML.
 * Throws {@link NotWarmError} when the profile is cold.
 */
async function fetchOnce(url: string, settleMs: number): Promise<FetchedPage> {
  const ctx = await getContext();
  const page: Page = await ctx.newPage();
  let status: number | null = null;

  page.on("response", (r) => {
    if (r.request().resourceType() === "document" && r.url().startsWith(url.split("?")[0])) {
      status = r.status();
    }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    // REA holds an analytics socket open, so `load` may never fire. Settle on a timer.
    await page.waitForTimeout(settleMs);

    const [title, html] = await Promise.all([page.title(), page.content()]);
    if (looksBlocked(title, html)) {
      throw new NotWarmError(`HTTP ${status ?? "?"}, ${html.length} byte body`);
    }
    return { html, title, url: page.url(), status };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function fetchPage(url: string, settleMs = 4_000): Promise<FetchedPage> {
  inFlight++;
  try {
    try {
      return await fetchOnce(url, settleMs);
    } catch (e) {
      if (!(e instanceof NotWarmError)) throw e;
      // The profile may have been warmed by a `setup` run after this context was
      // opened. A live Chrome won't pick up cookies written underneath it, so
      // drop the context and retry once against the on-disk profile.
      await closeContext();
      return await fetchOnce(url, settleMs);
    }
  } finally {
    inFlight--;
    scheduleIdleClose();
  }
}

/**
 * One-time interactive warm-up. Opens a visible Chrome window, loads the
 * homepage so Kasada issues its challenge, waits for the challenge to resolve,
 * and verifies a real search page renders. The token persists in PROFILE_DIR.
 */
export async function warmUp(opts: { headless?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  // Close any headless context first — one profile dir, one Chrome process.
  await closeContext();

  log(`profile: ${PROFILE_DIR}`);
  log("opening Chrome...");
  const ctx = await launch(opts.headless ?? false);
  try {
    const page = await ctx.newPage();

    log("loading homepage (solving bot challenge)...");
    await page.goto("https://www.realestate.com.au/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(8_000);

    log("verifying with a real search...");
    await page.goto("https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(6_000);

    const [title, html] = await Promise.all([page.title(), page.content()]);
    if (looksBlocked(title, html)) {
      throw new Error(
        `Warm-up failed — still blocked (${html.length} byte body).\n` +
          `Try again in a few minutes, or from a different network. Repeated ` +
          `rapid requests raise your Kasada score and take a while to decay.`,
      );
    }
    log(`verified: ${title}`);
    return { title, bytes: html.length };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Cheap check: does the profile currently hold a working token? */
export async function isWarm(): Promise<boolean> {
  try {
    await fetchPage("https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1", 3_000);
    return true;
  } catch {
    return false;
  }
}
