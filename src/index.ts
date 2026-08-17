/**
 * VectoJS WebOS — web fetch proxy.
 *
 * A text-mode fetch proxy for the WebOS Browser app: fetches a URL
 * server-side (so the browser sidesteps CORS), strips HTML to plain text,
 * and returns `{ title, text }` with permissive CORS headers.
 *
 * Security notes:
 * - Only `http:`/`https:` targets are allowed.
 * - A hostname blocklist rejects private/loopback/link-local/CLI-metadata
 *   hosts and IP literals (SSRF guard). It does NOT resolve DNS, so a public
 *   hostname that resolves to a private IP is not caught — keep this proxy
 *   demo-scoped, not a general-purpose open proxy.
 * - Responses are capped and the content type is constrained to text/html
 *   and text/* so binary bodies are never forwarded.
 */

const MAX_BYTES = 256 * 1024;
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

function isBlockedHost(hostname: string): boolean {
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

/** Decode the common HTML entities — enough for a readable text-mode view. */
function decodeEntities(s: string): string {
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

/** Strip scripts/styles/comments/tags from HTML into readable plain text. */
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").trim() : "";

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
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
        headers: {
          "user-agent": "VectoJS-WebOS-Proxy/0.1 (+https://webos.vectojs.org)",
          accept: "text/html, text/plain;q=0.9, */*;q=0.5",
        },
      });
    } catch {
      return json({ error: "fetch failed" }, 502);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("text") && !contentType.includes("html")) {
      return json({ error: `unsupported content type: ${contentType}` }, 415);
    }

    const raw = await upstream.text();
    if (raw.length > MAX_BYTES) {
      return json({ error: "response too large" }, 413);
    }

    const { title, text } = htmlToText(raw);
    return json({
      url: upstream.url,
      title: title || parsed.hostname,
      text: text.slice(0, MAX_TEXT),
    });
  },
};
