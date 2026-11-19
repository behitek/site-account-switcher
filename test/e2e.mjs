// End-to-end test: loads the unpacked extension into Chrome for Testing, points claude.ai / chatgpt.com /
// example.org at a local HTTPS mock (via --host-resolver-rules), and exercises the real switch flow.
// No real Claude/ChatGPT traffic is made.
import https from "node:https";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 18443;
const HOSTS = ["claude.ai", "chatgpt.com", "auth.openai.com", "example.org"];

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), ".cache/puppeteer/chrome");
  const v = fs.readdirSync(base).sort().pop();
  return path.join(base, v, "chrome-linux64/chrome");
}

// ---------- self-signed cert ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sas-e2e-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=test",
  "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"),
  "-addext", "subjectAltName=" + HOSTS.map((h) => "DNS:" + h).join(","),
], { stdio: "ignore" });

// ---------- mock server ----------
const tokens = new Map(); // token -> user
const parseCookies = (h = "") => Object.fromEntries(h.split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
const SESSION = { "claude.ai": "sessionKey", "chatgpt.com": "__Secure-next-auth.session-token", "example.org": "sid" };

const server = https.createServer({ key: fs.readFileSync(path.join(tmp, "k.pem")), cert: fs.readFileSync(path.join(tmp, "c.pem")) }, (req, res) => {
  const host = req.headers.host.split(":")[0];
  const url = new URL(req.url, `https://${host}`);
  const ck = parseCookies(req.headers.cookie);
  const sname = SESSION[host] || "sid";
  const user = tokens.get(ck[sname]) || null;
  const newToken = (u) => {
    const t = crypto.randomBytes(12).toString("hex");
    tokens.set(t, u);
    return t;
  };
  const cookieAttrs = "Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400";
  const domainAttr = host === "chatgpt.com" ? "" : `; Domain=.${host}`; // chatgpt session = host-only, claude = domain cookie

  if (url.pathname === "/login") {
    const u = url.searchParams.get("u");
    const set = [`${sname}=${newToken(u)}${domainAttr}; ${cookieAttrs}`, `pref=${u}; Path=/; Secure; Max-Age=86400`];
    if (!ck.cf_clearance) set.push(`cf_clearance=cf-${crypto.randomBytes(4).toString("hex")}; Domain=.${host}; ${cookieAttrs}`);
    res.writeHead(302, { "set-cookie": set, location: "/" });
    return res.end();
  }
  if (url.pathname === "/rotate") {
    // Invalidate the old token and issue a new one (like a session refresh).
    tokens.delete(ck[sname]);
    res.writeHead(302, { "set-cookie": [`${sname}=${newToken(user)}${domainAttr}; ${cookieAttrs}`], location: "/" });
    return res.end();
  }
  if (url.pathname === "/api/account" || url.pathname === "/api/auth/session") {
    if (!user) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "application/json" });
    const body = url.pathname === "/api/account" ? { account: { uuid: "x", email_address: `${user}@test.dev` } } : { user: { name: user, email: `${user}@test.dev` } };
    return res.end(JSON.stringify(body));
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${host}</title><div id="who">${user || "anonymous"}</div>
<script>
  if (${JSON.stringify(user)} && !localStorage.getItem("cachedUser")) localStorage.setItem("cachedUser", ${JSON.stringify(user)});
  document.title = "${host}:" + (${JSON.stringify(user)} || "anonymous");
</script>`);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---------- browser ----------
// Test copy of the extension: optional host permissions can't be granted headlessly, so the copy
// pre-grants example.org (used to test the custom-site flow).
const EXT = path.join(tmp, "ext");
fs.cpSync(ROOT, EXT, { recursive: true, filter: (s) => !/node_modules|\/test|\/dist|\.git/.test(s.slice(ROOT.length)) });
const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
mf.host_permissions.push("https://example.org/*", "https://*.example.org/*");
fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(mf, null, 2));

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${PORT}`).join(", ")}`,
    "--ignore-certificate-errors",
    "--no-first-run",
  ],
});

let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log("  ✔", name);
  } catch (e) {
    failures++;
    console.log("  ✘", name, "\n     ", e.message);
  }
};

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("src/background.js"));
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  const op = (name, args) => sw.evaluate((n, a) => globalThis.__ops[n](a), name, args);
  const cookiesOf = (domain) => sw.evaluate((d) => chrome.cookies.getAll({ domain: d }), domain);

  const claude = await browser.newPage();
  await claude.goto("https://claude.ai/login?u=alice");
  const gpt = await browser.newPage();
  await gpt.goto("https://chatgpt.com/login?u=carol");
  const other = await browser.newPage();
  await other.goto("https://example.org/login?u=dave");

  const who = (p) => p.$eval("#who", (e) => e.textContent);
  const waitWho = (p, name) => p.waitForFunction((n) => document.querySelector("#who")?.textContent === n, { timeout: 8000 }, name);
  const ls = (p) => p.evaluate(() => localStorage.getItem("cachedUser"));

  console.log("Claude flow");
  assert.equal(await who(claude), "alice");
  const cf0 = (await cookiesOf("claude.ai")).find((c) => c.name === "cf_clearance").value;

  let alice, bob;
  await step("save alice (email auto-detected)", async () => {
    alice = await op("saveNew", { siteId: "claude", storeId: "0", name: "" });
    assert.equal(alice.email, "alice@test.dev");
    assert.equal(alice.name, "alice@test.dev");
  });

  await step("sign in another -> claude is signed out, other sites untouched", async () => {
    await op("newLogin", { siteId: "claude", storeId: "0" });
    await waitWho(claude, "anonymous");
    assert.equal(await ls(claude), null, "localStorage cleared");
    await gpt.reload();
    assert.equal(await who(gpt), "carol");
    await other.reload();
    assert.equal(await who(other), "dave");
    const cf = (await cookiesOf("claude.ai")).find((c) => c.name === "cf_clearance");
    assert.equal(cf?.value, cf0, "cf_clearance kept");
  });

  await step("log in bob and save as 'Bob'", async () => {
    await claude.goto("https://claude.ai/login?u=bob");
    assert.equal(await who(claude), "bob");
    bob = await op("saveNew", { siteId: "claude", storeId: "0", name: "Bob" });
    assert.equal(bob.email, "bob@test.dev");
  });

  await step("switch to alice -> page + localStorage are alice; chatgpt still carol", async () => {
    const r = await op("switchTo", { siteId: "claude", storeId: "0", profileId: alice.id });
    assert.equal(r.warning, null);
    assert.deepEqual(r.failed, []);
    await waitWho(claude, "alice");
    assert.equal(await ls(claude), "alice");
    await gpt.reload();
    assert.equal(await who(gpt), "carol");
  });

  await step("switch back to bob", async () => {
    await op("switchTo", { siteId: "claude", storeId: "0", profileId: bob.id });
    await waitWho(claude, "bob");
    assert.equal(await ls(claude), "bob");
  });

  await step("auto-save keeps rotated session tokens", async () => {
    await claude.goto("https://claude.ai/rotate"); // old bob token is now invalid server-side
    assert.equal(await who(claude), "bob");
    await op("switchTo", { siteId: "claude", storeId: "0", profileId: alice.id });
    await waitWho(claude, "alice");
    await op("switchTo", { siteId: "claude", storeId: "0", profileId: bob.id });
    await waitWho(claude, "bob");
  });

  await step("auto-save refuses to overwrite a profile with a different account", async () => {
    // Active profile is Bob, but user manually logs in as eve in the tab.
    await claude.goto("https://claude.ai/login?u=eve");
    assert.equal(await who(claude), "eve");
    const r = await op("switchTo", { siteId: "claude", storeId: "0", profileId: alice.id });
    assert.match(r.warning || "", /eve@test\.dev/);
    await waitWho(claude, "alice");
    await op("switchTo", { siteId: "claude", storeId: "0", profileId: bob.id });
    await waitWho(claude, "bob"); // Bob profile was not clobbered by eve
  });

  console.log("ChatGPT flow (host-only + multi-domain)");
  let carol, frank;
  await step("save carol, sign in frank, switch both ways", async () => {
    carol = await op("saveNew", { siteId: "chatgpt", storeId: "0", name: "Carol" });
    assert.equal(carol.email, "carol@test.dev");
    await op("newLogin", { siteId: "chatgpt", storeId: "0" });
    await waitWho(gpt, "anonymous");
    await gpt.goto("https://chatgpt.com/login?u=frank");
    frank = await op("saveNew", { siteId: "chatgpt", storeId: "0", name: "Frank" });
    await op("switchTo", { siteId: "chatgpt", storeId: "0", profileId: carol.id });
    await waitWho(gpt, "carol");
    await claude.reload();
    assert.equal(await who(claude), "bob", "claude untouched by chatgpt switch");
    await op("switchTo", { siteId: "chatgpt", storeId: "0", profileId: frank.id });
    await waitWho(gpt, "frank");
  });

  await step("state() reports the active profile per site", async () => {
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://claude.ai/*" }))[0].id);
    const s = await op("state", { tabId, url: "https://claude.ai/" });
    assert.equal(s.site.id, "claude");
    assert.equal(s.activeId, bob.id);
    assert.equal(s.profiles.length, 2);
  });

  await step("custom site (example.org) can be added and switched", async () => {
    // Optional host permission is required for custom sites; grant it here as the popup would.
    const site = { id: "custom-example-org", name: "example.org", domains: ["example.org"], origins: ["https://example.org"] };
    await op("saveSite", { site });
    const d1 = await op("saveNew", { siteId: site.id, storeId: "0", name: "Dave" });
    await op("newLogin", { siteId: site.id, storeId: "0" });
    await other.goto("https://example.org/login?u=gina");
    await op("saveNew", { siteId: site.id, storeId: "0", name: "Gina" });
    await op("switchTo", { siteId: site.id, storeId: "0", profileId: d1.id });
    await other.reload();
    assert.equal(await who(other), "dave");
  });

  await step("popup renders profiles for the current tab", async () => {
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://claude.ai/*" }))[0].id);
    const popup = await browser.newPage();
    await popup.setViewport({ width: 340, height: 420 });
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${tabId}`);
    await popup.waitForSelector(".profile");
    const names = await popup.$$eval(".profile .name", (els) => els.map((e) => e.textContent));
    assert.deepEqual(names, ["alice@test.dev", "Bob"]);
    const active = await popup.$eval(".profile.active .name", (e) => e.textContent);
    assert.equal(active, "Bob");
    if (process.env.SHOT) await popup.screenshot({ path: process.env.SHOT });
    // Click alice in the popup -> claude tab switches.
    await popup.click(".profile:not(.active) .switch");
    await waitWho(claude, "alice");
    await popup.close();
  });

  await step("help page opened on install and renders", async () => {
    const opened = (await browser.pages()).some((p) => p.url().endsWith("/src/help/help.html"));
    assert.ok(opened, "help tab opened on first install");
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${extId}/src/help/help.html`);
    const h = await p.$eval("h1", (e) => e.textContent);
    assert.match(h, /How to use/);
    assert.equal(await p.$$eval("section", (s) => s.length), 6);
    if (process.env.SHOT_HELP) await p.screenshot({ path: process.env.SHOT_HELP, fullPage: true });
    await p.close();
  });

  await step("options page renders", async () => {
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${extId}/src/options/options.html`);
    await p.waitForSelector(".site-card");
    const titles = await p.$$eval(".site-card .title", (els) => els.map((e) => e.textContent));
    assert.deepEqual(titles, ["Claude", "ChatGPT", "example.org"]);
    if (process.env.SHOT_OPTIONS) await p.screenshot({ path: process.env.SHOT_OPTIONS, fullPage: true });
    await p.close();
  });
} finally {
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) failed` : "\nAll e2e steps passed");
process.exit(failures ? 1 : 0);
