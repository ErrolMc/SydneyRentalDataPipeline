/**
 * REA serves listing media from i2.au.reastatic.net, which is NOT behind Kasada
 * — plain HTTPS works, no browser needed. URLs carry a `{size}` placeholder, so
 * we pick the resolution at the CDN rather than downscaling locally.
 *
 * Vision cost is roughly (width x height) / 750 tokens, so size selection is the
 * main lever on how much context a call burns:
 *   320x240  ~100 tokens    480x360  ~230 tokens
 *   640x480  ~410 tokens    800x600  ~640 tokens
 */

export const IMAGE_SIZES = ["320x240", "480x360", "640x480", "800x600", "1024x768"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export interface FetchedImage {
  data: string; // base64, no data: prefix — MCP wants the raw payload
  mimeType: string;
  bytes: number;
  url: string;
}

/** Swap the `{size}` placeholder; leave already-concrete URLs alone. */
export function sizedUrl(templatedOrConcrete: string, size: ImageSize): string {
  if (templatedOrConcrete.includes("{size}")) {
    return templatedOrConcrete.replace("{size}", size);
  }
  // Already rendered at some size by the parser — rewrite that segment.
  return templatedOrConcrete.replace(
    /\/\d{2,4}x\d{2,4}\//,
    `/${size}/`,
  );
}

async function fetchOne(url: string): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "image/avif,image/webp,image/jpeg,image/png,*/*",
        Referer: "https://www.realestate.com.au/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return {
      data: buf.toString("base64"),
      mimeType: res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg",
      bytes: buf.length,
      url,
    };
  } catch {
    return null;
  }
}

/** Fetch up to `limit` images concurrently, preserving input order. */
export async function fetchImages(
  urls: string[],
  size: ImageSize,
  limit: number,
): Promise<FetchedImage[]> {
  const picked = urls.slice(0, limit).map((u) => sizedUrl(u, size));
  const results = await Promise.all(picked.map(fetchOne));
  return results.filter((r): r is FetchedImage => r !== null);
}
