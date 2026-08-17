import { describe, expect, test } from "bun:test";
import {
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
