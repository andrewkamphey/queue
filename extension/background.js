// Queue — background: reads your scheduled posts by opening the site's own
// scheduled page in a background tab, letting the content script read it, then closing it.
// Sites: "x" (storage key xq) and "li" (LinkedIn, storage key liq).
importScripts("slots.js");

const SITES = {
  x: { url: "https://x.com/compose/post/unsent/scheduled", key: "xq" },
  li: { url: "https://www.linkedin.com/share/management/", key: "liq" },
};
const syncTabs = new Map(); // tabId -> {resolve, timer, site, backTo}
const inflight = {};

// hidden: read in a background tab, where the site may show times in another timezone
// (X was seen 8h behind). Visible reads are trusted; hidden reads get the learned shift.
async function saveScheduled(site, rawTimes, hidden) {
  const key = SITES[site].key;
  const { [key]: cur = {} } = await chrome.storage.local.get(key);
  let times = rawTimes;
  let shift = cur.hiddenShift ?? null;
  if (hidden) {
    if (cur.trusted?.length) {
      const learned = XQSlots.bestShift(rawTimes, cur.trusted);
      if (learned !== null) shift = learned;
    }
    if (shift === null) shift = 0;
    times = rawTimes.map((t) => t + shift);
  }
  // Keep slots we queued in the last 3 min in case the site's list hasn't caught up yet.
  const recent = (cur.localQueued || []).filter((q) => Date.now() - q.at < 3 * 60 * 1000);
  const merged = [...times, ...recent.map((q) => q.t).filter((t) => !times.includes(t))].sort((a, b) => a - b);
  const next = {
    ...cur, scheduled: merged, syncedAt: Date.now(), localQueued: recent, hiddenShift: shift,
    ...(hidden ? {} : { trusted: rawTimes, trustedAt: Date.now() }),
  };
  await chrome.storage.local.set({ [key]: next });
  return next;
}

// The first read for a site happens in a visible tab: a hidden tab can show times in
// another timezone, and the shift can only be learned once there's a trusted (visible) read.
function sync(site, fromTabId) {
  if (inflight[site]) return inflight[site];
  inflight[site] = new Promise(async (resolve) => {
    let tab;
    try {
      const key = SITES[site].key;
      const { [key]: cur = {} } = await chrome.storage.local.get(key);
      const visible = !cur.trusted?.length;
      tab = await chrome.tabs.create({
        url: SITES[site].url, active: visible, pinned: false,
        ...(fromTabId ? { openerTabId: fromTabId } : {}),
      });
      const timer = setTimeout(() => finish(tab.id, { ok: false, error: "timeout" }), 60000);
      syncTabs.set(tab.id, { resolve, timer, site, backTo: visible ? fromTabId : null });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  }).finally(() => (inflight[site] = null));
  return inflight[site];
}

function finish(tabId, result) {
  const entry = syncTabs.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  syncTabs.delete(tabId);
  if (entry.backTo) chrome.tabs.update(entry.backTo, { active: true }).catch(() => {});
  chrome.tabs.remove(tabId).catch(() => {});
  entry.resolve(result);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const site = SITES[msg.site] ? msg.site : "x";
    const key = SITES[site].key;
    switch (msg.type) {
      case "isSyncTab":
        return { syncTab: syncTabs.has(sender.tab?.id) };
      case "scheduledList": {
        // From a sync tab, or from you opening the scheduled page yourself.
        const state = await saveScheduled(site, msg.times, msg.hidden);
        const lastRead = { at: Date.now(), times: msg.times.length, raw: msg.raw, sync: msg.sync, hidden: msg.hidden, shift: state.hiddenShift };
        await chrome.storage.local.set({ [key]: { ...state, lastRead } });
        if (sender.tab && syncTabs.has(sender.tab.id)) finish(sender.tab.id, { ok: true, state: { ...state, lastRead } });
        return { ok: true };
      }
      case "syncFailed":
        if (sender.tab) finish(sender.tab.id, { ok: false, error: msg.error });
        return { ok: true };
      case "sync":
        return await sync(site, sender.tab?.id);
      case "queued": {
        const { [key]: cur = {} } = await chrome.storage.local.get(key);
        const scheduled = [...new Set([...(cur.scheduled || []), msg.t])].sort((a, b) => a - b);
        const localQueued = [...(cur.localQueued || []), { t: msg.t, at: Date.now() }];
        await chrome.storage.local.set({ [key]: { ...cur, scheduled, localQueued } });
        return { ok: true };
      }
    }
  })().then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => finish(tabId, { ok: false, error: "tab closed" }));
