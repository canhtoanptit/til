import { describe, expect, it } from "vitest";
import { bookmarkletHref, readAddParam } from "./bookmarklet";

const TOKEN = "super-secret-app-token";

describe("bookmarkletHref", () => {
  it("builds a javascript: snippet that opens {origin}/?add= for the current page", () => {
    const href = bookmarkletHref("https://til.example.com");
    expect(href).toBe(
      "javascript:(function(){window.open('https://til.example.com/?add='+encodeURIComponent(location.href),'_blank');})();",
    );
  });

  it("uses only the origin, dropping any path, query or hash it was given", () => {
    expect(bookmarkletHref("https://til.example.com/settings?x=1#y")).toBe(
      bookmarkletHref("https://til.example.com"),
    );
  });

  it("keeps a non-default port", () => {
    expect(bookmarkletHref("http://localhost:5173/settings")).toContain(
      "'http://localhost:5173/?add='",
    );
  });

  it("never contains the app token or an Authorization header", () => {
    // The whole point of the contract: the snippet is pasted into a bookmarks
    // file, so it must carry no credential of any kind.
    const href = bookmarkletHref("https://til.example.com") ?? "";
    expect(href).not.toContain(TOKEN);
    expect(href.toLowerCase()).not.toContain("authorization");
    expect(href.toLowerCase()).not.toContain("bearer");
    expect(href.toLowerCase()).not.toContain("token");
    expect(href).not.toContain("localStorage");
  });

  it("encodes the captured url at click time rather than at build time", () => {
    // `encodeURIComponent(location.href)` must be evaluated in the page, so a url
    // with & or ? in it survives as one parameter.
    expect(bookmarkletHref("https://til.example.com")).toContain(
      "encodeURIComponent(location.href)",
    );
  });

  it("returns null for an origin it cannot safely interpolate", () => {
    expect(bookmarkletHref("not a url")).toBeNull();
    expect(bookmarkletHref("javascript:alert(1)")).toBeNull();
    expect(bookmarkletHref("file:///Users/me/app.html")).toBeNull();
  });
});

describe("readAddParam", () => {
  it("returns null when there is no add parameter", () => {
    expect(readAddParam("")).toBeNull();
    expect(readAddParam("?q=rust")).toBeNull();
  });

  it("returns null for a blank add parameter", () => {
    expect(readAddParam("?add=")).toBeNull();
    expect(readAddParam("?add=%20%20")).toBeNull();
  });

  it("reads an http(s) url and marks it submittable", () => {
    expect(readAddParam("?add=https%3A%2F%2Fjvns.ca%2Fatom.xml")).toEqual({
      url: "https://jvns.ca/atom.xml",
      autoSubmit: true,
    });
    expect(readAddParam("?add=http%3A%2F%2Fexample.com%2Fa")).toEqual({
      url: "http://example.com/a",
      autoSubmit: true,
    });
  });

  it("survives a url whose own query string was encoded by the bookmarklet", () => {
    const target = "https://example.com/post?id=7&ref=hn#top";
    expect(readAddParam(`?add=${encodeURIComponent(target)}`)).toEqual({
      url: target,
      autoSubmit: true,
    });
  });

  it("ignores other parameters alongside add", () => {
    expect(
      readAddParam("?utm_source=x&add=https%3A%2F%2Fa.example.com"),
    ).toEqual({ url: "https://a.example.com", autoSubmit: true });
  });

  it("pre-fills without submitting when the value is not an http(s) url", () => {
    expect(readAddParam("?add=jvns.ca")).toEqual({
      url: "jvns.ca",
      autoSubmit: false,
    });
    expect(readAddParam("?add=javascript%3Aalert(1)")).toEqual({
      url: "javascript:alert(1)",
      autoSubmit: false,
    });
  });

  it("accepts a search string with or without the leading ?", () => {
    expect(readAddParam("add=https%3A%2F%2Fa.example.com")).toEqual({
      url: "https://a.example.com",
      autoSubmit: true,
    });
  });
});
