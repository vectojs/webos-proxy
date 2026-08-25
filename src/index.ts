/**
 * VectoJS WebOS — web fetch proxy.
 *
 * A text-mode fetch proxy for the WebOS Browser app: fetches a URL
 * server-side (so the browser sidesteps CORS), strips HTML to plain text,
 * and returns `{ title, text, truncated }` with permissive CORS headers.
 *
 * Security notes:
 * - Only `http:`/`https:` targets are allowed.
 * - A hostname blocklist rejects private/loopback/link-local/CLI-metadata
 *   hosts and IP literals (SSRF guard). It does NOT resolve DNS, so a public
 *   hostname that resolves to a private IP is not caught — keep this proxy
 *   demo-scoped, not a general-purpose open proxy.
 * - The upstream body is streamed and capped at `MAX_READ_BYTES` (the reader
 *   is cancelled once the ceiling is hit, so we never buffer more than that),
 *   and the content type is constrained to text/* and *html* so binary bodies
 *   are never forwarded.
 */

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 8000;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/** Blocklist for hosts that must never be proxied (SSRF guard). */
const BLOCKED_IPV4_PREFIX =
  /^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/;

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // IPv6 literals arrive bracketed from URL.hostname.
  if (h === "[::1]" || h === "[::]") return true;
  if (/^\[(fc|fd|fe[89ab])/.test(h)) return true; // ULA + link-local
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local"))
    return true;
  if (BLOCKED_IPV4_PREFIX.test(h)) return true;
  return false;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

/**
 * Outbound headers shaped like a real desktop-Chrome navigation typed into an
 * address bar (issue vectojs/webos#39). Strict sites (bilibili 风控, …)
 * reject requests that lack the header set every real browser sends, and had
 * been answering our bare `VectoJS-WebOS-Proxy` UA with 412 anti-bot pages.
 *
 * This is standard presentation — what any browser honestly announces about
 * itself — not deception beyond it: no cookie jar, no Referer (a fresh
 * navigation has neither), no forged history. `accept-encoding` stays unset
 * on purpose: Workers add gzip/br themselves and decompress transparently.
 *
 * Keep the Chrome major version consistent across `user-agent` and
 * `sec-ch-ua*`; mismatched versions are themselves a bot signal. Revisit the
 * pinned version every few months (current stable when written: 151).
 */
export function browserRequestHeaders(): Record<string, string> {
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.117 Safari/537.36",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua":
      '"Google Chrome";v="151", "Chromium";v="151", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    // Address-bar navigations are user-activated by definition.
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
}

/** Decode the common HTML entities — enough for a readable text-mode view. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)));
}

/**
 * Strip scripts/styles/nav/header/footer/forms/comments/tags from HTML into
 * readable plain text. Nav/header/footer/aside/form are removed whole — on a
 * Wikipedia-style page they are link farms that would otherwise crowd out the
 * article text before the output cap is reached.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").trim() : "";

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");

  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return { title, text };
}

/**
 * Read a response body up to `maxBytes`, cancelling the reader once the
 * ceiling is hit so we never buffer more than that regardless of the
 * upstream's true size.
 */
export async function readUpTo(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.length > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return json({ error: "missing ?url= parameter" }, 400);
    }

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return json({ error: "invalid url" }, 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return json({ error: "only http:// and https:// are allowed" }, 400);
    }
    if (isBlockedHost(parsed.hostname)) {
      return json({ error: "host is not allowed" }, 403);
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        redirect: "follow",
        headers: browserRequestHeaders(),
      });
    } catch {
      return json({ error: "fetch failed" }, 502);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("text") && !contentType.includes("html")) {
      return json({ error: `unsupported content type: ${contentType}` }, 415);
    }

    const { text: raw, truncated } = await readUpTo(
      upstream.body,
      MAX_READ_BYTES,
    );
    const { title, text } = htmlToText(raw);
    // The upstream HTTP status rides along (issue #39) so the app can tell a
    // real page from an anti-bot block: on 403/412-style answers the body is
    // the site's own challenge page and must never be shown as content.
    return json({
      url: upstream.url,
      status: upstream.status,
      title: title || parsed.hostname,
      text: text.slice(0, MAX_TEXT),
      truncated,
    });
  },
};
