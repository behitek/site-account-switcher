import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_SITES,
  hostMatches,
  siteForUrl,
  cookieToSetDetails,
  isKept,
  findEmail,
  guessSiteFromUrl,
  sitePermissionOrigins,
  normalizeDomain,
} from "../src/sites.js";

test("hostMatches covers subdomains but not lookalikes", () => {
  assert.ok(hostMatches("claude.ai", "claude.ai"));
  assert.ok(hostMatches("www.claude.ai", ".claude.ai"));
  assert.ok(!hostMatches("notclaude.ai", "claude.ai"));
  assert.ok(!hostMatches("claude.ai.evil.com", "claude.ai"));
});

test("siteForUrl maps URLs to the right built-in site", () => {
  assert.equal(siteForUrl(BUILTIN_SITES, "https://claude.ai/new").id, "claude");
  assert.equal(siteForUrl(BUILTIN_SITES, "https://chatgpt.com/c/123").id, "chatgpt");
  assert.equal(siteForUrl(BUILTIN_SITES, "https://auth.openai.com/log-in").id, "chatgpt");
  assert.equal(siteForUrl(BUILTIN_SITES, "https://platform.openai.com/"), null);
  assert.equal(siteForUrl(BUILTIN_SITES, "https://google.com/"), null);
  assert.equal(siteForUrl(BUILTIN_SITES, "chrome://extensions"), null);
});

test("cookieToSetDetails: domain cookie keeps domain, host-only and __Host- drop it", () => {
  const base = { path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 2e9 };
  const dom = cookieToSetDetails({ ...base, name: "sessionKey", value: "v", domain: ".claude.ai", hostOnly: false }, "0");
  assert.equal(dom.url, "https://claude.ai/");
  assert.equal(dom.domain, ".claude.ai");
  assert.equal(dom.expirationDate, 2e9);
  assert.equal(dom.sameSite, "lax");

  const host = cookieToSetDetails({ ...base, name: "x", value: "v", domain: "chatgpt.com", hostOnly: true }, "0");
  assert.equal(host.domain, undefined);
  assert.equal(host.url, "https://chatgpt.com/");

  const hostPref = cookieToSetDetails(
    { ...base, name: "__Host-next-auth.csrf-token", value: "v", domain: "chatgpt.com", hostOnly: false },
    "1"
  );
  assert.equal(hostPref.domain, undefined);
  assert.equal(hostPref.storeId, "1");

  const sess = cookieToSetDetails({ ...base, name: "s", value: "v", domain: "a.com", hostOnly: true, session: true, sameSite: "unspecified" }, "0");
  assert.equal(sess.expirationDate, undefined);
  assert.equal(sess.sameSite, undefined);
});

test("keep list protects Cloudflare cookies", () => {
  const claude = BUILTIN_SITES.find((s) => s.id === "claude");
  assert.ok(isKept(claude, "cf_clearance"));
  assert.ok(isKept(claude, "__cf_bm"));
  assert.ok(!isKept(claude, "sessionKey"));
});

test("findEmail digs through nested JSON", () => {
  assert.equal(findEmail({ user: { id: 1, email: "a@b.co" } }), "a@b.co");
  assert.equal(findEmail({ account: { email_address: "x@y.io", memberships: [] } }), "x@y.io");
  assert.equal(findEmail({ list: [{ foo: "bar" }, { contact: "z@q.dev" }] }), "z@q.dev");
  assert.equal(findEmail({ nope: "not an email" }), null);
  assert.equal(findEmail(null), null);
});

test("guessSiteFromUrl + permissions", () => {
  const s = guessSiteFromUrl("https://www.example.com/path");
  assert.deepEqual(s.domains, ["example.com"]);
  assert.ok(s.origins.includes("https://www.example.com"));
  assert.ok(s.origins.includes("https://example.com"));
  const perms = sitePermissionOrigins(s);
  assert.ok(perms.includes("*://example.com/*"));
  assert.ok(perms.includes("*://*.example.com/*"));
});

test("normalizeDomain", () => {
  assert.equal(normalizeDomain(" https://Claude.ai/foo "), "claude.ai");
  assert.equal(normalizeDomain(".chatgpt.com"), "chatgpt.com");
  assert.equal(normalizeDomain("localhost:8443"), "localhost");
});
