import { describe, expect, it } from "vitest";
import { ExtractionError, UnsafeUrlError } from "@til/core";
import { fetchPage, MAX_FETCH_BYTES } from "./fetch-page.js";

function reply(
  body: string | Uint8Array,
  init: { status?: number; headers?: Record<string, string>; url?: string } = {},
): typeof fetch {
  return (async () => {
    const response = new Response(body as BodyInit, {
      status: init.status ?? 200,
      headers: init.headers ?? { "content-type": "text/html; charset=utf-8" },
    });
    // `Response.url` is read-only and empty for a constructed response, so the
    // redirect target a real fetch would report has to be defined onto it.
    Object.defineProperty(response, "url", {
      value: init.url ?? "https://example.test/page",
    });
    return response;
  }) as unknown as typeof fetch;
}

describe("fetchPage", () => {
  it("returns decoded html and the final url for an html response", async () => {
    const out = await fetchPage(
      "https://example.test/page",
      reply("<html><body>hi</body></html>"),
    );
    expect(out.html).toBe("<html><body>hi</body></html>");
    expect(out.finalUrl).toBe("https://example.test/page");
    expect(out.contentType).toBe("article");
    expect(out.bytes).toBeUndefined();
  });

  it("reports the redirected url, not the requested one", async () => {
    const out = await fetchPage(
      "https://example.test/short",
      reply("<html>x</html>", { url: "https://elsewhere.test/full" }),
    );
    expect(out.finalUrl).toBe("https://elsewhere.test/full");
  });

  it("re-runs the SSRF check on the redirect target", async () => {
    // The whole point: the requested host was safe, the one we landed on is not.
    await expect(
      fetchPage(
        "https://example.test/redirect",
        reply("<html>x</html>", { url: "http://169.254.169.254/latest/meta-data" }),
      ),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("treats text/plain as an article", async () => {
    const out = await fetchPage(
      "https://example.test/readme.txt",
      reply("plain words", { headers: { "content-type": "text/plain" } }),
    );
    expect(out.contentType).toBe("article");
    expect(out.html).toBe("plain words");
  });

  it("returns bytes, not text, for an application/pdf response", async () => {
    // A real PDF starts %PDF-; decoding those bytes as UTF-8 is what we avoid.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);
    const out = await fetchPage(
      "https://example.test/paper",
      reply(pdf, { headers: { "content-type": "application/pdf" } }),
    );
    expect(out.contentType).toBe("pdf");
    expect(out.html).toBe("");
    expect(Array.from(out.bytes ?? [])).toEqual(Array.from(pdf));
  });

  it("promotes an extensionless url the server serves as a pdf", async () => {
    // arxiv.org/pdf/2401.00001 — the URL guess said article, the header says pdf.
    const out = await fetchPage(
      "https://arxiv.test/pdf/2401.00001",
      reply(new Uint8Array([0x25, 0x50]), {
        headers: { "content-type": "application/pdf; charset=binary" },
      }),
    );
    expect(out.contentType).toBe("pdf");
  });

  it("demotes a .pdf url the server answers with html", async () => {
    // A landing page or a consent wall behind a .pdf link is an article, and the
    // header is the only thing that knows.
    const out = await fetchPage(
      "https://example.test/paper.pdf",
      reply("<html><body>Sign in to download</body></html>"),
    );
    expect(out.contentType).toBe("article");
    expect(out.html).toContain("Sign in");
  });

  it("still rejects a content-type it cannot read at all", async () => {
    await expect(
      fetchPage(
        "https://example.test/pic",
        reply("binary", { headers: { "content-type": "image/png" } }),
      ),
    ).rejects.toThrow(/Unsupported content-type: image\/png/);
  });

  it("throws on a non-2xx response", async () => {
    await expect(
      fetchPage("https://example.test/gone", reply("nope", { status: 404 })),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects a declared content-length over the cap without reading the body", async () => {
    await expect(
      fetchPage(
        "https://example.test/big",
        reply("x", {
          headers: {
            "content-type": "text/html",
            "content-length": String(MAX_FETCH_BYTES + 1),
          },
        }),
      ),
    ).rejects.toThrow(/exceeds/);
  });

  it("caps a body that lies about its length", async () => {
    // A content-length header is a claim; the streaming cap is what actually holds.
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_FETCH_BYTES + chunk.byteLength) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = (async () => {
      const response = new Response(stream, {
        headers: { "content-type": "text/html", "content-length": "10" },
      });
      Object.defineProperty(response, "url", { value: "https://example.test/lie" });
      return response;
    }) as unknown as typeof fetch;

    await expect(fetchPage("https://example.test/lie", fetchImpl)).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });
});
