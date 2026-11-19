import { sitePermissionOrigins, normalizeDomain } from "../sites.js";

const $ = (s, el = document) => el.querySelector(s);

async function call(cmd, args) {
  const r = await chrome.runtime.sendMessage({ cmd, args });
  if (!r?.ok) throw new Error(r?.error || "No response from background");
  return r.result;
}

function toast(msg, kind = "", ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

const lines = (v) =>
  v
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

let state;

async function load() {
  state = await call("state", {});
  for (const k of ["autoSave", "swapLocalStorage", "clearSiteData"]) $("#" + k).checked = state.settings[k];
  const box = $("#sites");
  box.replaceChildren();
  for (const s of state.sites) box.append(siteCard(s));
}

function siteCard(site, isNew = false) {
  const card = $("#tplSite").content.firstElementChild.cloneNode(true);
  $(".dot", card).className = "dot " + (site.builtin ? site.id : "custom");
  $(".title", card).textContent = site.name || "New site";
  const profiles = state.allProfiles[site.id] || [];
  $(".count", card).textContent = isNew ? "" : `${profiles.length} saved account${profiles.length === 1 ? "" : "s"}`;
  const f = (n) => $(`[data-f="${n}"]`, card);
  f("name").value = site.name || "";
  f("domains").value = (site.domains || []).join("\n");
  f("origins").value = (site.origins || []).join("\n");
  f("keep").value = (site.keep || []).join("\n");
  f("whoami").value = (site.whoami || []).join("\n");
  if (site.builtin) $(".reset", card).hidden = false;
  if (isNew) {
    card.open = true;
    $(".delete", card).textContent = "Cancel";
  }

  const list = $(".profiles-list", card);
  for (const p of profiles) {
    const row = Object.assign(document.createElement("div"), { className: "p" });
    list.append(row);
    row.append(
      Object.assign(document.createElement("span"), { textContent: `${p.name}${p.email && p.email !== p.name ? " · " + p.email : ""}` }),
      Object.assign(document.createElement("span"), {
        className: "muted",
        textContent: `${p.cookieCount} cookies · ${new Date(p.updatedAt).toLocaleString()}`,
      })
    );
  }

  $(".save", card).onclick = async () => {
    const domains = lines(f("domains").value).map(normalizeDomain);
    const draft = {
      id: site.id || "custom-" + (domains[0] || "site").replace(/[^a-z0-9]+/gi, "-"),
      name: f("name").value.trim() || domains[0],
      domains,
      origins: lines(f("origins").value),
      keep: lines(f("keep").value),
      whoami: lines(f("whoami").value),
    };
    if (!draft.origins.length) draft.origins = domains.map((d) => `https://${d}`);
    try {
      if (!domains.length) throw new Error("Add at least one cookie domain");
      // Must be called within the click gesture, before other awaits.
      const ok = await chrome.permissions.request({ origins: sitePermissionOrigins(draft) });
      if (!ok) throw new Error("Permission for those domains was not granted");
      await call("saveSite", { site: draft });
      toast("Saved");
      await load();
    } catch (e) {
      toast(e.message, "error", 5000);
    }
  };
  $(".reset", card).onclick = async () => {
    await call("resetSite", { siteId: site.id });
    toast("Reset to default");
    load();
  };
  const del = $(".delete", card);
  del.onclick = async () => {
    if (isNew) return card.remove();
    if (!del.dataset.armed) {
      del.dataset.armed = "1";
      del.textContent = `Click again: delete site + ${profiles.length} profile(s)`;
      return;
    }
    await call("deleteSite", { siteId: site.id });
    toast("Removed");
    load();
  };
  return card;
}

for (const k of ["autoSave", "swapLocalStorage", "clearSiteData"]) {
  $("#" + k).onchange = async (e) => {
    await call("saveSettings", { settings: { [k]: e.target.checked } });
    toast("Saved");
  };
}

$("#addSite").onclick = () => {
  const card = siteCard({ id: "", name: "", domains: [], origins: [], keep: [], whoami: [] }, true);
  $("#sites").prepend(card);
  $('[data-f="domains"]', card).focus();
};

$("#restoreBuiltins").onclick = async () => {
  await call("restoreBuiltins");
  toast("Built-in sites restored");
  load();
};

$("#export").onclick = async () => {
  const data = await call("exportAll");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `account-switcher-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

$("#import").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const r = await call("importAll", { payload: JSON.parse(await file.text()) });
    toast(`Imported ${r.profiles} profile(s)`);
    load();
  } catch (err) {
    toast(err.message, "error", 5000);
  } finally {
    e.target.value = "";
  }
};

load().catch((e) => toast(e.message, "error", 8000));
