# webos-proxy

Text-mode web fetch proxy for the [VectoJS WebOS](https://webos.vectojs.org)
Browser app. A Cloudflare Worker that fetches a URL server-side, strips HTML
to plain text, and returns `{ title, text }` with permissive CORS.

## Usage

```
GET https://proxy.vectojs.org/?url=<encoded-url>
```

Response:

```json
{
  "url": "https://example.com/",
  "status": 200,
  "title": "Example Domain",
  "text": "Example Domain\n\nThis domain is for use…",
  "truncated": false
}
```

`status` mirrors the upstream site's HTTP status (after redirects), so clients
can tell a real page from an anti-bot block: on 403/412-style answers the body
is the site's own challenge page and must not be shown as content.

Accepted limitation (issue #39): this Worker always answers with its own HTTP
200 and does not judge the stripped body — telling a challenge page from real
content would require sniffing page markup, which is unreliable by design.
Detection is therefore the client's job via the relayed `status`; a client
that ignores it renders the challenge text as ordinary content.

## Security

- Only `http:`/`https:` targets are allowed.
- A hostname blocklist rejects private/loopback/link-local/CLI-metadata hosts
  (SSRF guard). It does **not** resolve DNS, so a public hostname resolving to
  a private IP is not caught — demo-scoped, not a general open proxy.
- The upstream body is streamed and capped at 2 MiB (the reader is cancelled at
  the ceiling, so memory never exceeds it); text output is capped at 8000 chars
  and `truncated: true` flags a page that hit the ceiling. Content is
  constrained to text/* and _html_ types, and nav/header/footer/aside/form
  blocks are dropped before extraction so article text is not crowded out.
- Outbound requests carry a browser-grade Chrome navigation header set
  (UA + Accept + Accept-Language + Sec-Fetch-\*/Sec-CH-UA\*). That is normal
  browser presentation, nothing more: no cookies are stored or sent and no
  Referer is forged.

## Develop

```bash
bun install
bun run dev        # local: http://localhost:8787
bun run check      # tsc --noEmit
bun run lint       # oxlint
bun run deploy     # wrangler deploy (route: proxy.vectojs.org)
```

## Deploy

Push to `main` → CI runs `verify` then `deploy` (wrangler) to the
`webos-proxy` worker. Requires the `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` repo secrets (org-level).

The `proxy.vectojs.org` hostname is a **Workers custom domain** attached
one-time to the `webos-proxy` service (the token lacks Zone Workers Routes
scope, so a zone `route` in `wrangler.toml` is not used). The attachment
auto-created the proxied DNS record on the `vectojs.org` zone. To re-attach
(or move) it:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"proxy.vectojs.org","service":"webos-proxy","environment":"production","zone_id":"e221cc18a57003bb6bef3d34605ffb1e"}'
```
