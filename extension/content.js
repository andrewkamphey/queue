// Queue — X content script.
// 1) On X's Scheduled page: read every "Will send on …" time and hand it to the background.
// 2) In every composer that has X's "Schedule post" button: add a Queue button that
//    fills X's own schedule picker with the next empty hour and presses Schedule.
(() => {
  const S = globalThis.XQSlots;
  const SCHEDULED_PATH = "/compose/post/unsent/scheduled";
  const STALE_MS = 5 * 60 * 1000;
  const SUBMIT_TEXTS = new Set(["Post", "Schedule", "Reply", "Post all"]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let state = { scheduled: [], syncedAt: 0 };
  let syncing = false;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(res || {}));
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

  // ---------- state ----------
  chrome.storage.local.get("xq", ({ xq }) => {
    if (xq) state = xq;
    refreshLabels();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.xq) {
      state = changes.xq.newValue || state;
      refreshLabels();
    }
  });


  const upcoming = () => (state.scheduled || []).filter((t) => t > Date.now() - 60 * 1000);
  const CAD_SITE = "x";
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
    if (syncing) return waitFor(() => !syncing && state, 30000, 200);
    syncing = true;
    refreshLabels();
    const res = await send({ type: "sync" });
    syncing = false;
    if (res.state) state = res.state;
    refreshLabels();
    return res;
  }

  // ---------- 1) reading the Scheduled list ----------
  function scheduledTabSelected() {
    return [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some(
      (t) => t.innerText.trim() === "Scheduled"
    );
  }
  function willSendSpans() {
    return [...document.querySelectorAll("span")].filter(
      (e) => e.children.length === 0 && /^Will send on /.test(e.textContent)
    );
  }
  function draftsScroller() {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.querySelector('[role="tab"]')
    );
    if (!dialog) return null;
    return [...dialog.querySelectorAll("*")].find(
      (e) => e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)
    );
  }

  async function readScheduledList() {
    const ready = await waitFor(
      () => scheduledTabSelected() && (willSendSpans().length || null),
      8000
    );
    if (!ready) {
      // Nothing scheduled, or still loading.
      if (scheduledTabSelected() && !document.querySelector('[role="progressbar"]')) return [];
      return null;
    }
    // Scroll to the bottom until no new items load.
    const sc = draftsScroller();
    // X loads more in pages and can be slow: stop only after 3 quiet rounds in a row.
    let last = -1, quiet = 0;
    for (let i = 0; i < 60 && sc && quiet < 3; i++) {
      sc.scrollTop = sc.scrollHeight;
      await sleep(800);
      const n = willSendSpans().length;
      quiet = n === last && !document.querySelector('[role="progressbar"]') ? quiet + 1 : 0;
      last = n;
    }
    if (sc) sc.scrollTop = 0;
    const times = willSendSpans().map((e) => S.parseWillSend(e.textContent)).filter(Boolean);
    return times.sort((a, b) => a - b); // keep same-time duplicates
  }

  let passiveTimer = null;
  async function onScheduledPage(isSyncTab) {
    const times = await readScheduledList();
    if (times) await send({ type: "scheduledList", times, raw: willSendSpans().length, sync: isSyncTab, hidden: document.hidden });
    else if (isSyncTab) await send({ type: "syncFailed", error: "could not read the Scheduled list" });
  }

  (async () => {
    const { syncTab } = await send({ type: "isSyncTab" });
    if (syncTab) onScheduledPage(true);
  })();

  // ---------- 2) the Queue button ----------
  function findSubmit(root) {
    return [...root.querySelectorAll("button")].find(
      (b) => !b.closest(".xq-wrap") && SUBMIT_TEXTS.has(b.innerText.trim())
    );
  }
  function composerRootFor(scheduleBtn) {
    let el = scheduleBtn.parentElement;
    for (let i = 0; i < 15 && el; i++, el = el.parentElement) {
      if (findSubmit(el)) return el;
    }
    return null;
  }

  // The whole composer (text box + "Will send on" banner + toolbar), not just the toolbar row.
  function scopeOf(root) {
    const dialog = root.closest('[role="dialog"]');
    if (dialog) return dialog;
    const form = root.closest("form");
    if (form) return form;
    let el = root;
    for (let i = 0; i < 12 && el.parentElement; i++, el = el.parentElement) {
      if (el.querySelector('[role="textbox"], [contenteditable]')) return el;
    }
    return root;
  }
  const bannerIn = (scope) =>
    [...scope.querySelectorAll("button, span")].find((e) => /^Will send on /.test(e.innerText?.trim() || ""));

  function enhance() {
    for (const sb of document.querySelectorAll('[aria-label="Schedule post"]')) {
      if (sb.dataset.xq) continue;
      const root = composerRootFor(sb);
      const submit = root && findSubmit(root);
      if (!submit) continue;
      sb.dataset.xq = "1";
      if (submit.parentElement.querySelector(".xq-wrap")) continue; // X re-rendered the icon only

      const wrap = document.createElement("span");
      wrap.className = "xq-wrap";
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
        queue(sb, null);
      });
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(more, sb);
      });
      refreshLabels();
      if (isStale()) syncNow();
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
  function openMenu(anchor, scheduleBtn) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "xq-menu";
    const slots = nextSlots(5);
    menu.innerHTML = `<div class="xq-menu-h">Queue for…</div>`;
    for (const t of slots) {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = new Date(t).toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenu();
        queue(scheduleBtn, t);
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
    foot.textContent = `↻ Re-read X queue (${upcoming().length} scheduled${ago === null ? ", never read" : `, read ${ago}m ago`})`;
    foot.addEventListener("click", async (e) => {
      e.stopPropagation();
      foot.textContent = "Reading X's Scheduled list…";
      const res = await syncNow();
      closeMenu();
      toast(res.ok === false ? `Couldn't read queue: ${res.error}` : `Queue read: ${upcoming().length} scheduled`);
    });
    menu.append(foot);
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  }

  // ---------- queueing ----------
  async function queue(scheduleBtn, pickedT) {
    const root = composerRootFor(scheduleBtn);
    const btn = root?.querySelector(".xq-btn");
    const submit = root && findSubmit(root);
    if (!root || !submit) return toast("Couldn't find the composer.");
    if (submit.disabled || submit.getAttribute("aria-disabled") === "true")
      return toast("Write something first.");

    const setBusy = (txt) => {
      if (!btn) return;
      btn.dataset.busy = "1";
      S.paintBtn(btn, txt, "");
    };
    const done = () => {
      if (btn) delete btn.dataset.busy;
      refreshLabels();
    };

    try {
      if (isStale()) {
        setBusy("Reading…");
        const res = await syncNow();
        if (res.ok === false && !state.syncedAt) throw new Error(`couldn't read your Scheduled list (${res.error})`);
      }
      // A read in the wrong timezone shows up as posts "in the past". Don't queue on that.
      if ((state.scheduled || []).some((p) => p < (state.syncedAt || 0) - 15 * 60 * 1000))
        throw new Error("the queue times look off. Open your Scheduled page once, then try again");
      let t = pickedT;
      if (t && S.clashes(upcoming(), t)) {
        throw new Error("that slot is now within an hour of another post — pick another");
      }
      t = t || nextSlots(1)[0];
      if (!t) throw new Error("no queue slot. Check the cadence in the ▾ menu");
      setBusy("Queuing…");

      const scope = scopeOf(root);
      await setSchedule(scope, scheduleBtn, t);

      const finalSubmit = await waitFor(() => {
        const b = findSubmit(scope);
        return b && b.innerText.trim() === "Schedule" && !b.disabled ? b : null;
      }, 3000);
      if (!finalSubmit) throw new Error("X didn't switch Post to Schedule");
      finalSubmit.click();

      // Wait for the composer to close or clear.
      const gone = await waitFor(() => !scope.isConnected || !bannerIn(scope), 10000);
      if (!gone) throw new Error("X didn't confirm — check the composer");
      await send({ type: "queued", t });
      toast(`Queued for ${new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
    } catch (err) {
      toast(`Queue failed: ${err.message}`);
      console.warn("[Queue]", err);
    } finally {
      done();
    }
  }

  function pickerDialog() {
    const ds = [...document.querySelectorAll('[role="dialog"]')].filter((d) =>
      d.querySelector('[aria-label="Next month"]')
    );
    return ds[ds.length - 1] || null;
  }

  async function setSchedule(scope, scheduleBtn, t) {
    scheduleBtn.click();
    let picker = await waitFor(pickerDialog, 3000);
    if (!picker) throw new Error("schedule picker didn't open");

    const label = S.dayLabel(t);
    let day = null;
    for (let i = 0; i < 15; i++) {
      picker = pickerDialog();
      day = picker?.querySelector(`[aria-label="${label}"]`);
      if (day) break;
      picker?.querySelector('[aria-label="Next month"]')?.click();
      await sleep(250);
    }
    if (!day) throw new Error(`couldn't find ${label} in the picker`);
    if (day.disabled) throw new Error(`${label} isn't selectable`);
    day.click();
    await sleep(300);

    const timeText = S.timeLabel(t);
    const opt = await waitFor(() =>
      [...(pickerDialog()?.querySelectorAll('[role="option"]') || [])].find(
        (o) => o.innerText.trim().replace(/[  ]/g, " ") === timeText
      )
    );
    if (!opt) throw new Error(`no ${timeText} option`);
    if (opt.disabled || opt.getAttribute("aria-disabled") === "true") throw new Error(`${timeText} is in the past`);
    opt.click();
    await sleep(250);

    const confirm = [...(pickerDialog()?.querySelectorAll("button") || [])].find(
      (b) => ["Schedule", "Update"].includes(b.innerText.trim())
    );
    if (!confirm) throw new Error("no Schedule button in picker");
    confirm.click();
    await waitFor(() => !pickerDialog(), 3000);

    // Check X shows exactly the time we wanted.
    const banner = await waitFor(() => bannerIn(scope));
    const shown = banner && S.parseWillSend(banner.innerText.trim());
    if (shown !== t) throw new Error(`X shows ${banner ? banner.innerText.trim() : "no time"} — not sent`);
  }

  // ---------- toast ----------
  function toast(text) {
    document.querySelector(".xq-toast")?.remove();
    const el = document.createElement("div");
    el.className = "xq-toast";
    el.textContent = text;
    document.body.append(el);
    setTimeout(() => el.remove(), 4500);
  }

  // ---------- watch the page ----------
  let lastPath = "";
  new MutationObserver(() => {
    enhance();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (lastPath === SCHEDULED_PATH) {
        clearTimeout(passiveTimer);
        passiveTimer = setTimeout(async () => {
          const { syncTab } = await send({ type: "isSyncTab" });
          if (!syncTab) onScheduledPage(false);
        }, 500);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  enhance();
  setInterval(refreshLabels, 60 * 1000);
})();
