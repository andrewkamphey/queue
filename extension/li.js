// Queue for LinkedIn — content script.
// 1) On LinkedIn's scheduled-posts dialog (/share/management/): read every "Posting … at …" time.
// 2) In the post composer: add a Queue button that puts the post in the next free daily slot
//    (per the chosen cadence) after the last queued post, using LinkedIn's own schedule picker.
(() => {
  const S = globalThis.XQSlots;
  const SITE = "li";
  const KEY = "liq";
  const STALE_MS = 5 * 60 * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let state = { scheduled: [], syncedAt: 0 };
  let syncing = false;
  let busy = false; // Queue is driving the picker; the page watcher stays out

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ site: SITE, ...msg }, (res) => resolve(res || {}));
      } catch (e) {
        resolve({ ok: false, error: String(e) }); // extension reloaded
      }
    });
  async function waitFor(fn, timeout = 4000, every = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }
  const text = (el) => (el?.innerText || el?.textContent || "").trim();

  // ---------- state ----------
  chrome.storage.local.get(KEY, (r) => {
    if (r[KEY]) state = r[KEY];
    refreshLabels();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes[KEY]) {
      state = changes[KEY].newValue || state;
      refreshLabels();
    }
  });
  const upcoming = () => (state.scheduled || []).filter((t) => t > Date.now() - 60 * 1000);
  const CAD_SITE = "li";
  // ---------- cadence (per site, chosen from the ▾ menu) ----------
  let cadence = S.DEFAULT_CADENCE[CAD_SITE];
  let times = S.DEFAULT_TIMES;
  const applyCfg = (cfg) => {
    if (cfg?.[CAD_SITE] && S.CADENCES[cfg[CAD_SITE]]) cadence = cfg[CAD_SITE];
    if (Array.isArray(cfg?.times?.[CAD_SITE])) times = cfg.times[CAD_SITE];
  };
  chrome.storage.local.get("xq_cfg", ({ xq_cfg }) => {
    applyCfg(xq_cfg);
    refreshLabels();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.xq_cfg) return;
    applyCfg(changes.xq_cfg.newValue);
    refreshLabels();
  });
  async function setTimes(t) {
    const { xq_cfg = {} } = await chrome.storage.local.get("xq_cfg");
    await chrome.storage.local.set({
      xq_cfg: { ...xq_cfg, [CAD_SITE]: "slots", times: { ...(xq_cfg.times || {}), [CAD_SITE]: t } },
    });
    times = t;
    cadence = "slots";
    refreshLabels();
    toast(`Cadence: daily at ${S.timesLabel(t)}`);
  }
  async function setCadence(id) {
    const { xq_cfg = {} } = await chrome.storage.local.get("xq_cfg");
    await chrome.storage.local.set({ xq_cfg: { ...xq_cfg, [CAD_SITE]: id } });
    cadence = id;
    refreshLabels();
    toast(`Cadence: ${id === "slots" ? `daily at ${S.timesLabel(times)}` : S.CADENCES[id].label}`);
  }
  const nextSlots = (n) => S.slotsFor(cadence, upcoming(), Date.now(), n, times);
  const isStale = () => Date.now() - (state.syncedAt || 0) > STALE_MS;

  async function syncNow() {
    if (syncing) return waitFor(() => !syncing && state, 35000, 200);
    syncing = true;
    refreshLabels();
    const res = await send({ type: "sync" });
    syncing = false;
    if (res.state) state = res.state;
    refreshLabels();
    return res;
  }

  // ---------- 1) reading the scheduled list ----------
  // List rows say "Posting Mon, Nov 23, 2026 at 6:00 PM" (with year); the composer banner
  // says "Posting at Thu, Nov 26, 1:00 AM" (no year), so the year filters the banner out.
  const postingSpans = (root = document) =>
    [...root.querySelectorAll("span")].filter(
      (e) => e.children.length === 0 && /^Posting \w{3}, \w{3} \d{1,2}, \d{4} at /.test(e.textContent.trim())
    );
  const listDialog = () => postingSpans()[0]?.closest("dialog");

  async function readList(dialog) {
    const scroller = () =>
      [...dialog.querySelectorAll("*")].find(
        (e) => e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)
      );
    // Rows draw in gradually and more load on scroll: stop after 4 quiet rounds in a row.
    let last = -1, quiet = 0;
    for (let i = 0; i < 60 && quiet < 4; i++) {
      const sc = scroller();
      if (sc) sc.scrollTop = sc.scrollHeight;
      await sleep(900);
      const n = postingSpans(dialog).length;
      if (!dialog.isConnected || n < last) return null; // the list went away mid-read
      quiet = n === last ? quiet + 1 : 0;
      last = n;
    }
    const sc = scroller();
    if (sc) sc.scrollTop = 0;
    return postingSpans(dialog).map((e) => S.parsePosting(e.textContent.trim())).filter(Boolean).sort((a, b) => a - b);
  }

  const readDialogs = new WeakSet();
  async function maybeReadList(isSyncTab) {
    const d = listDialog();
    if (!d || readDialogs.has(d)) return false;
    readDialogs.add(d);
    const times = await readList(d);
    if (!times || busy) return false; // Queue is reading this list itself
    await send({ type: "scheduledList", times, raw: times.length, sync: isSyncTab, hidden: document.hidden });
    return true;
  }

  (async () => {
    const { syncTab } = await send({ type: "isSyncTab" });
    if (!syncTab) return;
    // The dialog shows "Scheduled (0)" with no rows when nothing is scheduled.
    const ok = await waitFor(() => listDialog() || null, 20000, 250);
    if (ok) await maybeReadList(true);
    else {
      const empty = [...document.querySelectorAll("dialog[open]")].some((d) => /Scheduled \(0\)/.test(text(d)) && !postingSpans(d).length);
      if (empty) await send({ type: "scheduledList", times: [], raw: 0, sync: true, hidden: document.hidden });
      else await send({ type: "syncFailed", error: "could not read LinkedIn's scheduled list" });
    }
  })();

  // ---------- 2) the Queue button ----------
  const composers = () =>
    [...document.querySelectorAll("dialog[open]")].filter((d) => d.querySelector('[role="textbox"][contenteditable="true"]'));
  const submitIn = (c) =>
    [...c.querySelectorAll("button")].find((b) => !b.closest(".xq-wrap") && /^(Post|Schedule)$/.test(text(b)));
  // The clock link next to Post; it's labelled "Scheduled (N)".
  const clockIn = (c) =>
    [...c.querySelectorAll('a[aria-haspopup="dialog"]')].find((a) => {
      const l = document.getElementById(a.getAttribute("aria-labelledby") || "");
      return /^Scheduled/.test(text(l) || a.getAttribute("aria-label") || "");
    });

  function enhance() {
    for (const c of composers()) {
      const submit = submitIn(c);
      const clock = clockIn(c);
      if (!submit || !clock || submit.parentElement.querySelector(".xq-wrap")) continue;
      const wrap = document.createElement("span");
      wrap.className = "xq-wrap xq-li";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "xq-btn";
      
      const more = document.createElement("button");
      more.type = "button";
      more.className = "xq-more";
      more.title = "Pick a later queue slot";
      more.innerHTML = S.CHEVRON;
      more.setAttribute("aria-label", "More queue slots");
      wrap.append(btn, more);
      submit.parentElement.insertBefore(wrap, submit);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        queue(null);
      });
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(more);
      });
      refreshLabels();
    }
  }

  function refreshLabels() {
    const slot = nextSlots(1)[0];
    for (const b of document.querySelectorAll(".xq-btn")) {
      if (b.dataset.busy) continue;
      S.paintBtn(b, "Queue", slot && !(syncing && !state.syncedAt) ? S.shortLabel(slot) : "");
    }
  }

  // ---------- slot menu ----------
  function closeMenu() {
    document.querySelector(".xq-menu")?.remove();
  }
  function openMenu(anchor) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "xq-menu";
    menu.innerHTML = `<div class="xq-menu-h">Queue for…</div>`;
    for (const t of nextSlots(5)) {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = new Date(t).toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenu();
        queue(t);
      });
      menu.append(item);
    }
    S.cadenceMenu(
      menu,
      cadence,
      (id) => {
        closeMenu();
        setCadence(id);
      },
      times,
      setTimes
    );
    const foot = document.createElement("button");
    foot.type = "button";
    foot.className = "xq-menu-foot";
    const ago = state.syncedAt ? Math.round((Date.now() - state.syncedAt) / 60000) : null;
    foot.textContent = `↻ Re-read LinkedIn queue (${upcoming().length} scheduled${ago === null ? ", never read" : `, read ${ago}m ago`})`;
    foot.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeMenu();
      const c = composers()[0];
      if (busy) return;
      busy = true;
      try {
        await openPicker(c);
        await readFromPicker();
        toast(`Queue read: ${upcoming().length} scheduled`);
      } catch (err) {
        toast(`Couldn't read queue: ${err.message}`);
      }
      busy = false;
      await backToComposer();
      refreshLabels();
    });
    menu.append(foot);
    // LinkedIn's composer is a modal <dialog>: put the menu inside it so it stays clickable.
    (anchor.closest("dialog") || document.body).append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 6)}px`;
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  }

  // ---------- queueing ----------
  const setValue = (el, v) => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  };
  const pickerDialog = () =>
    [...document.querySelectorAll("dialog[open]")].find((d) => d.querySelector('input[placeholder="mm/dd/yyyy"]'));

  // LinkedIn only draws its scheduled list while the tab is visible (5 rows per frame), so a
  // background tab gets stuck at 5. Read it from the picker's own "Scheduled (N)" tab instead.
  const pickerLink = (label) =>
    [...document.querySelectorAll("dialog[open] a")].find((a) =>
      label === "list" ? /^Scheduled \(\d+\)$/.test(text(a)) : text(a) === "Schedule post"
    );
  async function readFromPicker() {
    const tab = pickerLink("list");
    if (!tab) throw new Error("couldn't find the Scheduled tab");
    tab.click();
    const d = await waitFor(() => document.querySelector("dialog[open]"), 3000);
    await waitFor(() => postingSpans(d).length || /Scheduled \(0\)/.test(text(d)) || null, 8000);
    const times = await readList(document.querySelector("dialog[open]"));
    if (!times) throw new Error("the scheduled list closed while reading");
    await send({ type: "scheduledList", times, raw: times.length, sync: false, hidden: false });
    state = { ...state, scheduled: times, syncedAt: Date.now() };
    const back = pickerLink("form");
    if (!back) throw new Error("couldn't get back to the schedule form");
    back.click();
    if (!(await waitFor(pickerDialog, 4000))) throw new Error("the schedule form didn't come back");
    return times;
  }
  const openPicker = async (c) => {
    const clock = clockIn(c);
    if (!clock) throw new Error("couldn't find LinkedIn's schedule button");
    clock.click();
    const p = await waitFor(pickerDialog, 6000);
    if (!p) throw new Error("the schedule picker didn't open");
    return p;
  };
  const backToComposer = async () => {
    document.querySelector('dialog[open] [aria-label="Back"]')?.click();
    await waitFor(() => composers()[0], 4000);
  };

  async function queue(pickedT) {
    if (busy) return;
    let c = composers()[0];
    const btn = c?.querySelector(".xq-btn");
    const submit = c && submitIn(c);
    if (!c || !submit) return toast("Couldn't find the composer.");
    if (submit.disabled || submit.getAttribute("aria-disabled") === "true") return toast("Write something first.");
    const setBusy = (txt) => {
      if (!btn) return;
      btn.dataset.busy = "1";
      S.paintBtn(btn, txt, "");
    };
    const done = () => {
      if (btn) delete btn.dataset.busy;
      refreshLabels();
    };

    busy = true;
    let pressed = false;
    try {
      setBusy("Reading…");
      let p = await openPicker(c);
      await readFromPicker();
      p = pickerDialog();
      let t = pickedT;
      if (t && S.clashes(upcoming(), t)) throw new Error("that slot is taken now. Pick another");
      if (!t) t = nextSlots(1)[0];
      if (!t || t < Date.now() + 2 * 60 * 1000) throw new Error("no valid slot");
      const want = `Posting at ${S.liBanner(t)}`;
      setBusy("Queuing…");
      const dateIn = p.querySelector('input[placeholder="mm/dd/yyyy"]');
      const timeIn = [...p.querySelectorAll("input")].find((i) => i !== dateIn && i.type === "text" && i.offsetParent);
      if (!timeIn) throw new Error("couldn't find the time field");
      setValue(dateIn, S.mdy(t));
      await sleep(300);
      setValue(timeIn, S.timeLabel(t));
      const ok = await waitFor(() => text(p).includes(want), 3000);
      if (!ok) throw new Error(`LinkedIn's preview didn't show ${S.liBanner(t)}`);
      const confirm = [...p.querySelectorAll("button")].find((b) => text(b) === "Confirm");
      if (!confirm || confirm.disabled) throw new Error("Confirm isn't available");
      confirm.click();

      // Back in the composer: banner must match, then press Schedule.
      c = await waitFor(() => composers().find((d) => text(d).includes(want) && submitIn(d) && text(submitIn(d)) === "Schedule"), 6000);
      if (!c) throw new Error("the composer didn't show the chosen time. Nothing was scheduled");
      submitIn(c).click();
      pressed = true;
      await send({ type: "queued", t });
      const gone = await waitFor(() => !composers().some((d) => text(d).includes(want)), 15000, 250);
      if (!gone) {
        toast(`Schedule pressed for ${S.liBanner(t)}. Check your scheduled posts before pressing anything again.`);
        return;
      }
      toast(`Queued for ${new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
    } catch (e) {
      if (!pressed && pickerDialog()) await backToComposer();
      toast(`Queue stopped: ${e.message}`);
    } finally {
      busy = false;
      done();
    }
  }

  function toast(msg) {
    document.querySelector(".xq-toast")?.remove();
    const el = document.createElement("div");
    el.className = "xq-toast";
    el.textContent = msg;
    (document.querySelector("dialog[open]") || document.body).append(el);
    setTimeout(() => el.remove(), /stopped|Couldn't|Check/.test(msg) ? 12000 : 4500);
  }

  // ---------- watch the page ----------
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      pending = false;
      enhance();
      // You opened the scheduled-posts dialog yourself: refresh the cache from it.
      if (listDialog() && !busy) {
        const { syncTab } = await send({ type: "isSyncTab" });
        if (!syncTab) maybeReadList(false);
      }
    }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  enhance();
  setInterval(refreshLabels, 60 * 1000);
})();
