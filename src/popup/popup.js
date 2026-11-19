import { guessSiteFromUrl, sitePermissionOrigins } from "../sites.js";

const $ = (s, el = document) => el.querySelector(s);
const main = $("#main");
let tab = null;
let state = null;

async function call(cmd, args) {
  const r = await chrome.runtime.sendMessage({ cmd, args });
  if (!r?.ok) throw new Error(r?.error || "No response from background");
  return r.result;
}

function toast(msg, kind = "", ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function busy(fn) {
  document.body.classList.add("busy");
  try {
    return await fn();
  } catch (e) {
    toast(e.message, "error", 5000);
  } finally {
    document.body.classList.remove("busy");
  }
}

function colorFor(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 48%)`;
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function load() {
  // ?tabId= lets the popup be opened as a normal page (used by the e2e test).
  const forced = new URLSearchParams(location.search).get("tabId");
  if (forced) tab = await chrome.tabs.get(Number(forced));
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state = await call("state", { tabId: tab?.id, url: tab?.url });
  render();
}

function render() {
  const { site } = state;
  const icon = $("#siteIcon");
  icon.className = "dot " + (site ? (site.builtin ? site.id : "custom") : "");
  $("#siteName").textContent = site ? site.name : "Not a managed site";
  $("#siteSub").textContent = site
    ? site.domains.join(", ") + (state.storeId !== "0" ? " · incognito" : "")
    : (() => {
        try {
          return new URL(tab.url).hostname;
        } catch {
          return "";
        }
      })();
  main.replaceChildren();
  if (!site) return renderUnmanaged();
  if (!state.hasPermission) return renderNeedsPermission();
  renderSite();
}

function renderSite() {
  const { site, profiles, activeId, storeId } = state;
  if (!profiles.length) {
    main.append(
      el(
        "div",
        { className: "empty" },
        "No saved accounts yet. Sign in on this site, then ",
        el("b", { textContent: "Save current login" }),
        " below. Repeat with ",
        el("b", { textContent: "Sign in another" }),
        " for each extra account."
      )
    );
  }
  const ul = el("ul", { className: "profiles" });
  for (const p of profiles) ul.append(profileRow(p, p.id === activeId));
  main.append(ul);

  const name = el("input", { type: "text", placeholder: "Name (optional)", maxLength: 60 });
  const save = el("button", { className: "btn primary", textContent: "Save current login" });
  save.onclick = () =>
    busy(async () => {
      const p = await call("saveNew", { siteId: site.id, storeId, name: name.value });
      toast(`Saved "${p.name}"`);
      await load();
    });
  name.onkeydown = (e) => e.key === "Enter" && save.click();
  main.append(el("div", { className: "row" }, name, save));

  const another = el("button", { className: "btn wide", textContent: "Sign in another account…" });
  another.onclick = () =>
    busy(async () => {
      const r = await call("newLogin", { siteId: site.id, storeId });
      if (r.warning) toast(r.warning, "warn", 6000);
      else toast("Signed out locally. Log in with the other account, then click Save current login.", "", 5000);
      await load();
    });
  main.append(el("div", { className: "row" }, another));
  main.append(
    el("p", {
      className: "hint",
      textContent: `Only ${site.domains.join(", ")} cookies are swapped. Every other site in the browser is left alone.`,
    })
  );
}

function profileRow(p, active) {
  const li = $("#tplProfile").content.firstElementChild.cloneNode(true);
  if (active) li.classList.add("active");
  const label = p.name || p.email || "Account";
  const av = $(".avatar", li);
  av.textContent = label.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";
  av.style.background = colorFor(p.email || p.name || p.id);
  $(".name", li).textContent = label;
  $(".email", li).textContent = [p.email && p.email !== label ? p.email : "", `saved ${timeAgo(p.updatedAt)}`]
    .filter(Boolean)
    .join(" · ");

  const { site, storeId } = state;
  $(".switch", li).onclick = () => {
    if (active) return;
    busy(async () => {
      const r = await call("switchTo", { siteId: site.id, storeId, profileId: p.id });
      if (r.warning) toast(r.warning, "warn", 7000);
      else if (r.failed?.length) toast(`Switched, but ${r.failed.length} cookie(s) failed: ${r.failed.join(", ")}`, "warn", 6000);
      else toast(`Switched to ${label}`);
      await load();
    });
  };
  $(".save", li).onclick = () =>
    busy(async () => {
      await call("overwrite", { siteId: site.id, storeId, profileId: p.id });
      toast(`Updated "${label}" with the current login`);
      await load();
    });
  $(".rename", li).onclick = () => {
    const input = el("input", { type: "text", value: p.name, maxLength: 60 });
    const nameEl = $(".name", li);
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = () =>
      !committed &&
      (committed = true) &&
      busy(async () => {
        await call("rename", { siteId: site.id, profileId: p.id, name: input.value });
        await load();
      });
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit();
      if (e.key === "Escape") render();
    };
    input.onclick = (e) => e.stopPropagation();
    input.onblur = commit;
  };
  const del = $(".del", li);
  del.onclick = () => {
    if (!del.dataset.armed) {
      del.dataset.armed = "1";
      del.textContent = "?";
      del.title = "Click again to delete";
      del.style.color = "var(--danger)";
      setTimeout(() => {
        delete del.dataset.armed;
        del.textContent = "✕";
        del.style.color = "";
      }, 2500);
      return;
    }
    busy(async () => {
      await call("remove", { siteId: site.id, profileId: p.id });
      toast(`Deleted "${label}" (the browser's current login was not changed)`);
      await load();
    });
  };
  return li;
}

function renderNeedsPermission() {
  const { site } = state;
  main.append(el("div", { className: "empty", textContent: `Allow access to ${site.domains.join(", ")} cookies to manage accounts here.` }));
  const b = el("button", { className: "btn primary wide", textContent: "Grant access" });
  b.onclick = async () => {
    const ok = await chrome.permissions.request({ origins: sitePermissionOrigins(site) });
    if (ok) load();
  };
  main.append(b);
}

function renderUnmanaged() {
  let guess = null;
  try {
    if (/^https?:/.test(tab?.url)) guess = guessSiteFromUrl(tab.url);
  } catch {}
  if (guess) {
    main.append(
      el("div", {
        className: "empty",
        textContent: `Want to keep several logins for ${guess.domains[0]}? Add it as a site. Switching will only touch its cookies.`,
      })
    );
    const add = el("button", { className: "btn primary wide", textContent: `Add ${guess.domains[0]}` });
    add.onclick = async () => {
      // permissions.request must run directly in the click gesture.
      const ok = await chrome.permissions.request({ origins: sitePermissionOrigins(guess) });
      if (!ok) return toast("Permission denied", "error");
      await busy(async () => {
        await call("saveSite", { site: guess });
        await load();
      });
    };
    main.append(add);
  } else {
    main.append(el("div", { className: "empty", textContent: "Open Claude, ChatGPT or a site you added to switch accounts there." }));
  }
  main.append(el("div", { className: "section-title", textContent: "Sites" }));
  const ul = el("ul", { className: "site-list" });
  for (const s of state.sites) {
    const n = state.allProfiles[s.id]?.length || 0;
    const open = el("a", { href: "#", textContent: s.name });
    open.onclick = (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: s.origins?.[0] || `https://${s.domains[0]}` });
    };
    ul.append(el("li", {}, open, el("span", { className: "count", textContent: `${n} account${n === 1 ? "" : "s"}` })));
  }
  main.append(ul);
}

$("#openOptions").onclick = () => chrome.runtime.openOptionsPage();
$("#openHelp").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("src/help/help.html") });

load().catch((e) => {
  main.replaceChildren(el("div", { className: "empty", textContent: e.message }));
});
