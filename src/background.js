// Service worker: owns all cookie/storage operations so they run to completion even if the popup closes.
import {
  BUILTIN_SITES,
  siteForUrl,
  sitePermissionOrigins,
  cookieKey,
  isKept,
  cookieUrl,
  cookieToSetDetails,
  serializeCookie,
  findEmail,
  normalizeDomain,
} from "./sites.js";

const DEFAULT_SETTINGS = {
  autoSave: true, // snapshot the current session into the active profile before switching away
  swapLocalStorage: true, // also save/restore localStorage (from open tabs of the site)
  clearSiteData: true, // wipe localStorage / IndexedDB / Cache Storage / service workers of the site's origins on switch
};

// ---------- storage ----------

const store = {
  async get(key, fallback) {
    const r = await chrome.storage.local.get(key);
    return r[key] === undefined ? fallback : r[key];
  },
  set(key, value) {
    return chrome.storage.local.set({ [key]: value });
  },
  remove(key) {
    return chrome.storage.local.remove(key);
  },
};

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await store.get("settings", {})) };
}

/** Built-in sites (optionally overridden by the user) + custom sites. */
async function getSites() {
  const saved = await store.get("sites", {});
  const out = [];
  for (const b of BUILTIN_SITES) {
    if (saved[b.id]?.hidden) continue;
    out.push(saved[b.id] ? { ...b, ...saved[b.id], id: b.id, builtin: true } : b);
  }
  for (const s of Object.values(saved)) if (!s.builtin && !BUILTIN_SITES.some((b) => b.id === s.id)) out.push(s);
  return out;
}

async function getSite(siteId) {
  const s = (await getSites()).find((x) => x.id === siteId);
  if (!s) throw new Error(`Unknown site: ${siteId}`);
  return s;
}

const profKey = (siteId, id) => `profile:${siteId}:${id}`;

async function getIndex() {
  return store.get("profiles", {}); // { siteId: [{id,name,email,createdAt,updatedAt,cookieCount}] }
}

async function getActive() {
  return store.get("active", {}); // { "siteId|storeId": profileId }
}
const activeKey = (siteId, storeId) => `${siteId}|${storeId || "0"}`;

async function setActive(siteId, storeId, profileId) {
  const a = await getActive();
  if (profileId) a[activeKey(siteId, storeId)] = profileId;
  else delete a[activeKey(siteId, storeId)];
  await store.set("active", a);
}

async function writeProfile(siteId, profile) {
  const { cookies, localStorage, ...meta } = profile;
  await store.set(profKey(siteId, profile.id), { cookies, localStorage: localStorage || {} });
  const idx = await getIndex();
  const list = idx[siteId] || [];
  const i = list.findIndex((p) => p.id === profile.id);
  meta.cookieCount = cookies.length;
  if (i >= 0) list[i] = { ...list[i], ...meta };
  else list.push(meta);
  idx[siteId] = list;
  await store.set("profiles", idx);
  return meta;
}

async function readProfile(siteId, profileId) {
  const idx = await getIndex();
  const meta = (idx[siteId] || []).find((p) => p.id === profileId);
  if (!meta) throw new Error("Profile not found");
  const data = await store.get(profKey(siteId, profileId), { cookies: [], localStorage: {} });
  return { ...meta, ...data };
}

// ---------- serialization lock (no two switches interleave) ----------

let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// ---------- tabs / cookie stores ----------

async function storeIdForTab(tabId) {
  if (tabId == null) return "0";
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((s) => s.tabIds.includes(tabId))?.id ?? "0";
}

/** Open tabs that belong to the site and to the given cookie store. */
async function siteTabs(site, storeId) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: sitePermissionOrigins(site) });
  } catch {
    return [];
  }
  const stores = await chrome.cookies.getAllCookieStores();
  const inStore = new Set(stores.find((s) => s.id === storeId)?.tabIds || []);
  return tabs.filter((t) => inStore.has(t.id) && t.url && siteForUrl([site], t.url));
}

function tabOrigin(t) {
  try {
    return new URL(t.url).origin;
  } catch {
    return null;
  }
}

// ---------- cookies ----------

async function captureCookies(site, storeId, { includeKept = false } = {}) {
  const seen = new Map();
  for (const domain of site.domains) {
    const queries = [{ domain: normalizeDomain(domain), storeId }];
    // Also pick up partitioned (CHIPS) cookies where supported.
    queries.push({ domain: normalizeDomain(domain), storeId, partitionKey: {} });
    for (const q of queries) {
      let list = [];
      try {
        list = await chrome.cookies.getAll(q);
      } catch {
        continue; // partitionKey unsupported on this Chrome
      }
      for (const c of list) if (includeKept || !isKept(site, c.name)) seen.set(cookieKey(c), c);
    }
  }
  return [...seen.values()];
}

async function clearCookies(site, storeId) {
  const cookies = await captureCookies(site, storeId);
  await Promise.all(
    cookies.map((c) => {
      const d = { url: cookieUrl(c), name: c.name, storeId };
      if (c.partitionKey) d.partitionKey = c.partitionKey;
      return chrome.cookies.remove(d).catch(() => null);
    })
  );
  return cookies.length;
}

async function restoreCookies(cookies, storeId) {
  const now = Date.now() / 1000;
  const failed = [];
  for (const c of cookies) {
    if (!c.session && c.expirationDate && c.expirationDate < now) continue; // expired
    try {
      const r = await chrome.cookies.set(cookieToSetDetails(c, storeId));
      if (!r) failed.push(c.name);
    } catch (e) {
      failed.push(`${c.name} (${e.message})`);
    }
  }
  return failed;
}

// ---------- page storage (localStorage / sessionStorage) via open tabs ----------

async function captureLocalStorage(site, storeId) {
  const out = {};
  const tabs = await siteTabs(site, storeId);
  const byOrigin = new Map();
  for (const t of tabs) {
    const o = tabOrigin(t);
    if (o && !byOrigin.has(o) && !t.discarded) byOrigin.set(o, t);
  }
  for (const [origin, t] of byOrigin) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => {
          const o = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            o[k] = localStorage.getItem(k);
          }
          return o;
        },
      });
      if (r?.result) out[origin] = r.result;
    } catch {
      /* tab not scriptable (e.g. error page) */
    }
  }
  return out;
}

/** In each open tab of the site: clear sessionStorage, and replace localStorage with the snapshot (if any). */
async function applyPageStorage(site, storeId, snapshot, writeLocal) {
  const tabs = await siteTabs(site, storeId);
  const doneOrigins = new Set();
  for (const t of tabs) {
    if (t.discarded) continue;
    const origin = tabOrigin(t);
    const writeLS = writeLocal && !doneOrigins.has(origin);
    doneOrigins.add(origin);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: t.id },
        args: [writeLS ? snapshot?.[origin] || {} : null],
        func: (items) => {
          try {
            sessionStorage.clear();
          } catch {}
          if (items) {
            try {
              localStorage.clear();
              for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
            } catch {}
          }
        },
      });
    } catch {
      /* ignore */
    }
  }
}

async function clearSiteData(site) {
  const origins = [...new Set([...(site.origins || []), ...site.domains.map((d) => `https://${normalizeDomain(d)}`)])];
  try {
    await chrome.browsingData.remove(
      { origins },
      { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true }
    );
  } catch (e) {
    console.warn("browsingData.remove failed", e);
  }
}

async function reloadSiteTabs(site, storeId, openIfNone = false) {
  const tabs = await siteTabs(site, storeId);
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id, { bypassCache: true }).catch(() => {})));
  if (!tabs.length && openIfNone && storeId === "0") {
    await chrome.tabs.create({ url: site.origins?.[0] || `https://${site.domains[0]}` });
  }
  return tabs.length;
}

// ---------- identity ----------

async function detectEmail(site, storeId) {
  if (!site.whoami?.length) return null;
  const tabs = await siteTabs(site, storeId);
  for (const url of site.whoami) {
    const origin = new URL(url).origin;
    const tab = tabs.find((t) => tabOrigin(t) === origin && !t.discarded && t.status !== "unloaded");
    if (!tab) continue;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [url],
        func: async (u) => {
          try {
            const res = await fetch(u, { credentials: "include", headers: { accept: "application/json" } });
            if (!res.ok) return null;
            return await res.json();
          } catch {
            return null;
          }
        },
      });
      const email = findEmail(r?.result);
      if (email) return email;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ---------- high-level operations ----------

async function snapshot(site, storeId, settings) {
  const cookies = (await captureCookies(site, storeId)).map(serializeCookie);
  const localStorage = settings.swapLocalStorage ? await captureLocalStorage(site, storeId) : {};
  return { cookies, localStorage };
}

/** Save current session into the active profile, guarding against overwriting it with a different account. */
async function autoSaveActive(site, storeId, settings, exceptId) {
  if (!settings.autoSave) return null;
  const activeId = (await getActive())[activeKey(site.id, storeId)];
  if (!activeId || (exceptId && activeId === exceptId)) return null;
  const idx = await getIndex();
  const meta = (idx[site.id] || []).find((p) => p.id === activeId);
  if (!meta) return null;
  const snap = await snapshot(site, storeId, settings);
  if (!snap.cookies.length) return `Not auto-saving "${meta.name}": the site has no cookies (signed out?).`;
  const email = await detectEmail(site, storeId);
  if (email && meta.email && email.toLowerCase() !== meta.email.toLowerCase()) {
    return `Not auto-saving "${meta.name}": the current session is ${email}, not ${meta.email}. Use "Save current as new" first if you want to keep it.`;
  }
  await writeProfile(site.id, { ...meta, ...snap, email: meta.email || email, updatedAt: Date.now() });
  return null;
}

async function wipe(site, storeId, settings) {
  await clearCookies(site, storeId);
  if (settings.clearSiteData && storeId === "0") await clearSiteData(site);
}

const ops = {
  async state({ tabId, url }) {
    const sites = await getSites();
    const settings = await getSettings();
    const storeId = await storeIdForTab(tabId);
    const site = url ? siteForUrl(sites, url) : null;
    const idx = await getIndex();
    const active = await getActive();
    let hasPermission = true;
    if (site && !site.builtin) {
      hasPermission = await chrome.permissions.contains({ origins: sitePermissionOrigins(site) });
    }
    return {
      sites,
      settings,
      storeId,
      site,
      hasPermission,
      profiles: site ? idx[site.id] || [] : [],
      activeId: site ? active[activeKey(site.id, storeId)] || null : null,
      allProfiles: idx,
    };
  },

  async saveNew({ siteId, storeId, name }) {
    const site = await getSite(siteId);
    const settings = await getSettings();
    const snap = await snapshot(site, storeId, settings);
    if (!snap.cookies.length) throw new Error("No cookies found for this site. Sign in first.");
    const email = await detectEmail(site, storeId);
    const now = Date.now();
    const id = crypto.randomUUID();
    const meta = await writeProfile(site.id, {
      id,
      name: (name || "").trim() || email || `Account ${((await getIndex())[site.id]?.length || 0) + 1}`,
      email,
      createdAt: now,
      updatedAt: now,
      ...snap,
    });
    await setActive(site.id, storeId, id);
    await refreshBadges();
    return meta;
  },

  async overwrite({ siteId, storeId, profileId }) {
    const site = await getSite(siteId);
    const settings = await getSettings();
    const prev = await readProfile(siteId, profileId);
    const snap = await snapshot(site, storeId, settings);
    if (!snap.cookies.length) throw new Error("No cookies found for this site. Sign in first.");
    const email = await detectEmail(site, storeId);
    await writeProfile(siteId, { ...prev, ...snap, email: email || prev.email, updatedAt: Date.now() });
    await setActive(siteId, storeId, profileId);
    await refreshBadges();
    return true;
  },

  async switchTo({ siteId, storeId, profileId }) {
    const site = await getSite(siteId);
    const settings = await getSettings();
    await readProfile(siteId, profileId); // fail fast if it doesn't exist
    // Save the live session first (also when re-selecting the active profile, so rotated tokens aren't lost).
    const warning = await autoSaveActive(site, storeId, settings, null);
    const target = await readProfile(siteId, profileId);
    await wipe(site, storeId, settings);
    const failed = await restoreCookies(target.cookies, storeId);
    await applyPageStorage(site, storeId, target.localStorage, settings.swapLocalStorage);
    await setActive(siteId, storeId, profileId);
    const reloaded = await reloadSiteTabs(site, storeId, true);
    await refreshBadges();
    return { warning, failed, reloaded };
  },

  /** Sign out locally (keeps the server session alive in the saved profile) so you can sign in to another account. */
  async newLogin({ siteId, storeId }) {
    const site = await getSite(siteId);
    const settings = await getSettings();
    const warning = await autoSaveActive(site, storeId, settings, null);
    await wipe(site, storeId, settings);
    await applyPageStorage(site, storeId, null, false);
    await setActive(siteId, storeId, null);
    const reloaded = await reloadSiteTabs(site, storeId, true);
    await refreshBadges();
    return { warning, reloaded };
  },

  async rename({ siteId, profileId, name }) {
    const idx = await getIndex();
    const p = (idx[siteId] || []).find((x) => x.id === profileId);
    if (!p) throw new Error("Profile not found");
    p.name = String(name).trim() || p.name;
    await store.set("profiles", idx);
    await refreshBadges();
    return p;
  },

  async remove({ siteId, profileId }) {
    const idx = await getIndex();
    idx[siteId] = (idx[siteId] || []).filter((p) => p.id !== profileId);
    await store.set("profiles", idx);
    await store.remove(profKey(siteId, profileId));
    const a = await getActive();
    for (const k of Object.keys(a)) if (k.startsWith(siteId + "|") && a[k] === profileId) delete a[k];
    await store.set("active", a);
    await refreshBadges();
    return true;
  },

  async reorder({ siteId, ids }) {
    const idx = await getIndex();
    const list = idx[siteId] || [];
    idx[siteId] = ids.map((id) => list.find((p) => p.id === id)).filter(Boolean);
    for (const p of list) if (!ids.includes(p.id)) idx[siteId].push(p);
    await store.set("profiles", idx);
    return true;
  },

  async saveSite({ site }) {
    const saved = await store.get("sites", {});
    const clean = {
      id: site.id,
      name: String(site.name || site.id).trim(),
      builtin: !!BUILTIN_SITES.find((b) => b.id === site.id),
      domains: [...new Set((site.domains || []).map(normalizeDomain).filter(Boolean))],
      origins: [...new Set((site.origins || []).map((o) => o.trim()).filter(Boolean))],
      keep: (site.keep || []).map((k) => k.trim()).filter(Boolean),
      whoami: (site.whoami || []).map((k) => k.trim()).filter(Boolean),
    };
    if (!clean.domains.length) throw new Error("A site needs at least one cookie domain");
    for (const o of clean.origins) new URL(o); // validate
    saved[clean.id] = clean;
    await store.set("sites", saved);
    return clean;
  },

  async resetSite({ siteId }) {
    const saved = await store.get("sites", {});
    delete saved[siteId];
    await store.set("sites", saved);
    return true;
  },

  async deleteSite({ siteId }) {
    const saved = await store.get("sites", {});
    if (BUILTIN_SITES.some((b) => b.id === siteId)) saved[siteId] = { ...(saved[siteId] || {}), hidden: true };
    else delete saved[siteId];
    await store.set("sites", saved);
    const idx = await getIndex();
    for (const p of idx[siteId] || []) await store.remove(profKey(siteId, p.id));
    delete idx[siteId];
    await store.set("profiles", idx);
    return true;
  },

  async restoreBuiltins() {
    const saved = await store.get("sites", {});
    for (const b of BUILTIN_SITES) delete saved[b.id];
    await store.set("sites", saved);
    return true;
  },

  async saveSettings({ settings }) {
    const cur = await getSettings();
    const next = { ...cur };
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in settings) next[k] = !!settings[k];
    await store.set("settings", next);
    return next;
  },

  async exportAll() {
    const all = await chrome.storage.local.get(null);
    return { format: "site-account-switcher", version: 1, exportedAt: new Date().toISOString(), data: all };
  },

  async importAll({ payload }) {
    if (payload?.format !== "site-account-switcher" || typeof payload.data !== "object") {
      throw new Error("Not a Site Account Switcher export file");
    }
    const cur = await chrome.storage.local.get(null);
    const incoming = payload.data;
    // Merge: sites + profile index merged by id; profile blobs copied.
    const sites = { ...(cur.sites || {}), ...(incoming.sites || {}) };
    const idx = { ...(cur.profiles || {}) };
    for (const [siteId, list] of Object.entries(incoming.profiles || {})) {
      const mine = idx[siteId] || [];
      for (const p of list) {
        const i = mine.findIndex((x) => x.id === p.id);
        if (i >= 0) mine[i] = p;
        else mine.push(p);
      }
      idx[siteId] = mine;
    }
    const blobs = {};
    for (const [k, v] of Object.entries(incoming)) if (k.startsWith("profile:")) blobs[k] = v;
    await chrome.storage.local.set({ ...blobs, sites, profiles: idx });
    await refreshBadges();
    return { profiles: Object.keys(blobs).length };
  },
};

// ---------- toolbar badge: show which profile is active on this tab's site ----------

async function badgeForTab(tab) {
  if (!tab?.id || !tab.url) return;
  try {
    const sites = await getSites();
    const site = siteForUrl(sites, tab.url);
    let text = "";
    if (site) {
      const storeId = await storeIdForTab(tab.id);
      const activeId = (await getActive())[activeKey(site.id, storeId)];
      const meta = ((await getIndex())[site.id] || []).find((p) => p.id === activeId);
      if (meta) text = meta.name.replace(/@.*/, "").slice(0, 3);
    }
    await chrome.action.setBadgeText({ tabId: tab.id, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#3b5bdb" });
  } catch {
    /* tab gone */
  }
}

async function refreshBadges() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(badgeForTab));
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === "complete") badgeForTab(tab);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    badgeForTab(await chrome.tabs.get(tabId));
  } catch {}
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  refreshBadges();
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("src/help/help.html") });
});
chrome.runtime.onStartup.addListener(refreshBadges);

// ---------- messaging ----------

const MUTATING = new Set(["saveNew", "overwrite", "switchTo", "newLogin", "rename", "remove", "reorder", "importAll"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension pages.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const fn = ops[msg?.cmd];
  if (!fn) {
    sendResponse({ ok: false, error: `Unknown command ${msg?.cmd}` });
    return false;
  }
  const run = () => fn(msg.args || {});
  (MUTATING.has(msg.cmd) ? locked(run) : run())
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true; // async response
});

// Exposed for automated tests (service worker global).
globalThis.__ops = ops;
