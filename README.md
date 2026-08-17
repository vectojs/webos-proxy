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
  "title": "Example Domain",
  "text": "Example Domain\n\nThis domain is for use…"
}
```

## Security

- Only `http:`/`https:` targets are allowed.
- A hostname blocklist rejects private/loopback/link-local/CLI-metadata hosts
  (SSRF guard). It does **not** resolve DNS, so a public hostname resolving to
  a private IP is not caught — demo-scoped, not a general open proxy.
- Responses are capped at 256 KiB and constrained to text/* content types.

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
`proxy.vectojs.org` route on the `vectojs.org` zone. Requires the
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets.
