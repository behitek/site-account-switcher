// Site definitions and pure helpers (no chrome.* calls here, so this file is unit-testable in Node).

/**
 * A "site" is a group of cookie domains that make up one login.
 * - domains:  cookie domains to swap. A domain also covers its subdomains
 *             ("chatgpt.com" covers ".chatgpt.com", "chatgpt.com", "ab.chatgpt.com").
 * - origins:  origins whose localStorage / IndexedDB / cache are cleared on switch.
 * - keep:     cookie names (regex sources) left untouched: anti-bot cookies tied to this browser, not to the account.
 * - whoami:   same-origin endpoints that reveal the signed-in email (best effort, used to label profiles).
 */
export const BUILTIN_SITES = [
  {
    id: "claude",
    name: "Claude",
    builtin: true,
    domains: ["claude.ai"],
    origins: ["https://claude.ai"],
    keep: ["^cf_clearance$", "^__cf_bm$", "^_cfuvid$"],
    whoami: ["https://claude.ai/api/account", "https://claude.ai/api/bootstrap"],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    builtin: true,
    domains: ["chatgpt.com", "auth.openai.com"],
    origins: ["https://chatgpt.com", "https://auth.openai.com"],
    keep: ["^cf_clearance$", "^__cf_bm$", "^_cfuvid$"],
    whoami: ["https://chatgpt.com/api/auth/session"],
  },
];

export function normalizeDomain(d) {
  return String(d || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^\.+/, "");
}

/** True if `host` equals `domain` or is a subdomain of it. */
export function hostMatches(host, domain) {
  host = normalizeDomain(host);
  domain = normalizeDomain(domain);
  return host === domain || host.endsWith("." + domain);
}

/** Find the site whose domains cover the given URL. */
export function siteForUrl(sites, url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  // Prefer the most specific (longest) matching domain.
  let best = null;
  let bestLen = -1;
  for (const s of sites) {
    for (const d of s.domains) {
      if (hostMatches(host, d) && d.length > bestLen) {
        best = s;
        bestLen = d.length;
      }
    }
  }
  return best;
}

/** Guess a cookie domain for a new custom site from a URL (strips "www."). */
export function guessSiteFromUrl(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  return {
    id: "custom-" + host.replace(/[^a-z0-9]+/gi, "-"),
    name: host,
    builtin: false,
    domains: [host],
    origins: [u.origin, ...(u.hostname !== host ? [`${u.protocol}//${host}`] : [])],
    keep: [],
    whoami: [],
  };
}

/** Host-permission match patterns for a site. */
export function sitePermissionOrigins(site) {
  const out = [];
  for (const d of site.domains) {
    const n = normalizeDomain(d);
    out.push(`*://${n}/*`, `*://*.${n}/*`);
  }
  for (const o of site.origins || []) out.push(`${new URL(o).origin}/*`);
  return [...new Set(out)];
}

export function cookieKey(c) {
  return `${c.storeId || ""}|${c.domain}|${c.path}|${c.name}|${c.partitionKey ? JSON.stringify(c.partitionKey) : ""}`;
}

export function isKept(site, cookieName) {
  return (site.keep || []).some((re) => {
    try {
      return new RegExp(re).test(cookieName);
    } catch {
      return false;
    }
  });
}

/** URL that chrome.cookies.remove / set need to address a cookie. */
export function cookieUrl(c) {
  const host = c.domain.replace(/^\./, "");
  return `http${c.secure ? "s" : ""}://${host}${c.path || "/"}`;
}

/** Convert a chrome.cookies.Cookie into chrome.cookies.set() details. */
export function cookieToSetDetails(c, storeId) {
  const d = {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    storeId,
  };
  // Host-only cookies (and __Host- cookies) must be set without a domain attribute.
  if (!c.hostOnly && !c.name.startsWith("__Host-")) d.domain = c.domain;
  if (c.sameSite && c.sameSite !== "unspecified") d.sameSite = c.sameSite;
  if (!c.session && c.expirationDate) d.expirationDate = c.expirationDate;
  if (c.partitionKey) d.partitionKey = c.partitionKey;
  return d;
}

/** Strip runtime-only fields so a cookie can be stored compactly. */
export function serializeCookie(c) {
  const o = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    hostOnly: c.hostOnly,
    session: c.session,
    sameSite: c.sameSite,
  };
  if (c.expirationDate) o.expirationDate = c.expirationDate;
  if (c.partitionKey) o.partitionKey = c.partitionKey;
  return o;
}

/** Recursively find the first string that looks like an email address. */
export function findEmail(obj, depth = 0) {
  if (depth > 6 || obj == null) return null;
  if (typeof obj === "string") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(obj) ? obj : null;
  if (typeof obj !== "object") return null;
  // Check likely keys first.
  for (const k of ["email", "email_address", "emailAddress"]) {
    if (typeof obj[k] === "string" && findEmail(obj[k])) return obj[k];
  }
  for (const v of Object.values(obj)) {
    const r = findEmail(v, depth + 1);
    if (r) return r;
  }
  return null;
}
