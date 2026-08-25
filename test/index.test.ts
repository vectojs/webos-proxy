import { describe, expect, test } from "bun:test";
import worker, {
  browserRequestHeaders,
  decodeEntities,
  htmlToText,
  isBlockedHost,
  readUpTo,
} from "../src/index";

describe("htmlToText", () => {
  test("extracts title and body text, decoding entities", () => {
    const { title, text } = htmlToText(
      "<html><head><title>Example &amp; Test</title><style>.x{}</style><script>var a=1;</script></head><body><h1>Hello</h1><p>World &amp; more</p><div>line1</div><div>line2</div></body></html>",
    );
    expect(title).toBe("Example & Test");
    expect(text).toBe("Hello\nWorld & more\nline1\nline2");
  });

  test("strips nav/header/footer/aside/form whole", () => {
    const { text } = htmlToText(
      "<body><header>Site</header><nav>Menu links</nav><p>Article body</p><footer>Foot</footer></body>",
    );
    expect(text).toBe("Article body");
  });

  test("drops comments and collapses whitespace", () => {
    const { text } = htmlToText("<body><!-- hidden --><p>  a   b  </p></body>");
    expect(text).toBe("a b");
  });
});

describe("decodeEntities", () => {
  test("decodes common named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt; c &#39;x&#39;")).toBe(
      "a & b < c 'x'",
    );
  });
});

describe("isBlockedHost", () => {
  test("blocks private, loopback, link-local and metadata hosts", () => {
    const blocked = [
      "localhost",
      "10.0.0.5",
      "127.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.0.1",
      "100.64.0.1",
      "[::1]",
      "[fc00::1]",
      "[fe80::1]",
      "foo.local",
      "sub.localhost",
    ];
    for (const h of blocked) expect(isBlockedHost(h), h).toBe(true);
  });

  test("allows public hosts", () => {
    const allowed = ["example.com", "11.0.0.1", "172.32.0.1", "100.63.0.1"];
    for (const h of allowed) expect(isBlockedHost(h), h).toBe(false);
  });
});

describe("browserRequestHeaders", () => {
  test("shapes a credible Chrome navigation request", () => {
    const h = browserRequestHeaders();
    expect(h["user-agent"]!.startsWith("Mozilla/5.0")).toBe(true);
    expect(h["user-agent"]).toContain("Chrome/");
    expect(h["accept"]!.startsWith("text/html")).toBe(true);
    expect(h["accept-language"]).toContain("en");
    // Address-bar navigation shape: user-activated top-level document load.
    expect(h["sec-fetch-dest"]).toBe("document");
    expect(h["sec-fetch-mode"]).toBe("navigate");
    expect(h["sec-fetch-site"]).toBe("none");
    expect(h["sec-fetch-user"]).toBe("?1");
    expect(h["upgrade-insecure-requests"]).toBe("1");
  });

  test("keeps client-hint versions consistent with the user agent", () => {
    const h = browserRequestHeaders();
    const major = /Chrome\/(\d+)/.exec(h["user-agent"]!)?.[1];
    expect(major).toBeTruthy();
    expect(h["sec-ch-ua"]).toContain(`v="${major}"`);
    expect(h["sec-ch-ua-mobile"]).toBe("?0");
    expect(h["sec-ch-ua-platform"]).toBe('"Windows"');
  });

  test("sends no cookie or referer (no jar, fresh navigation)", () => {
    const keys = Object.keys(browserRequestHeaders());
    expect(keys).not.toContain("cookie");
    expect(keys).not.toContain("referer");
  });
});

describe("fetch handler", () => {
  test("passes the upstream status through for blocked pages", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html><body>由于触发安全风控策略</body></html>", {
        status: 412,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    try {
      const res = await worker.fetch(
        new Request("https://proxy.example/?url=https%3A%2F%2Fexample.com"),
      );
      const body = (await res.json()) as { status?: number; text?: string };
      expect(body.status).toBe(412);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports status 200 on a normal page", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html><title>t</title><body>hello</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    try {
      const res = await worker.fetch(
        new Request("https://proxy.example/?url=https%3A%2F%2Fexample.com"),
      );
      const body = (await res.json()) as { status?: number };
      expect(body.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("readUpTo", () => {
  test("reads the full body under the cap", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello world"));
        c.close();
      },
    });
    const { text, truncated } = await readUpTo(body, 1024);
    expect(text).toBe("hello world");
    expect(truncated).toBe(false);
  });

  test("truncates at the cap and reports it", async () => {
    const big = "a".repeat(100);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const { text, truncated } = await readUpTo(body, 10);
    expect(text.length).toBe(10);
    expect(truncated).toBe(true);
  });

  test("handles a null body", async () => {
    const { text, truncated } = await readUpTo(null, 10);
    expect(text).toBe("");
    expect(truncated).toBe(false);
  });
});
