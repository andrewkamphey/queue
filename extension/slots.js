// Pure slot logic — shared by the content script and node tests.
(function (root) {
  const HOUR = 3600 * 1000;

  // "Mon, Nov 23, 2026 at 7:30 AM" -> epoch ms (browser local time), or null.
  function parseWillSend(text) {
    const m = String(text)
      .replace(/^Will send on\s*/i, "")
      .replace(/[  ]/g, " ")
      .match(/([A-Za-z]{3,}) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) ?([AP]M)/i);
    if (!m) return null;
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const mon = months.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mon < 0) return null;
    let h = parseInt(m[4], 10) % 12;
    if (m[6].toUpperCase() === "PM") h += 12;
    return new Date(+m[3], mon, +m[2], h, +m[5], 0, 0).getTime();
  }

  // First `count` top-of-hour slots after now (+ lead) whose hour has no scheduled post.
  function freeSlots(scheduled, now, count = 1, leadMs = 5 * 60 * 1000) {
    const taken = new Set(scheduled.map((t) => hourKey(t)));
    const out = [];
    const d = new Date(now + leadMs);
    if (d.getMinutes() || d.getSeconds() || d.getMilliseconds()) {
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() + 1);
    }
    for (let i = 0; out.length < count && i < 24 * 400; i++) {
      const t = d.getTime();
      if (!taken.has(hourKey(t))) out.push(t);
      d.setHours(d.getHours() + 1); // DST-safe local hour step
    }
    return out;
  }

  // Queue model: posts at least 61 min apart (61–90 min, stable per anchor).
  // The "chain" is the run of upcoming posts starting near now with no gap over 6h.
  // Anything after the first 6h+ gap counts as pinned (a specific date) and is only avoided.
  const MIN = 60 * 1000;
  const CHAIN_GAP = 6 * HOUR;
  const QUARTER = 15 * MIN;
  const ceilQuarter = (t) => Math.ceil(t / QUARTER) * QUARTER;
  // Stable pseudo-random gap in [lo, hi] minutes per anchor, so the label matches what Queue does.
  function gapAfter(anchor, lo = 61, hi = 90) {
    if (hi <= lo) return lo * MIN;
    let h = Math.floor(anchor / MIN) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return (lo + (Math.abs(h ^ (h >>> 16)) % (hi - lo + 1))) * MIN;
  }
  function splitQueue(scheduled, now, chainGap = CHAIN_GAP) {
    const up = scheduled.filter((t) => t > now).sort((a, b) => a - b);
    const chain = [];
    let anchor = now;
    for (const t of up) {
      if (t - anchor > chainGap) break;
      chain.push(t);
      anchor = t;
    }
    return { chain, pinned: up.slice(chain.length) };
  }
  // Next `count` queue slots: end of chain + 61–90 min, then each one after the last.
  function queueSlots(scheduled, now, count = 1, leadMs = 5 * MIN, lo = 61, hi = 90) {
    const { chain, pinned } = splitQueue(scheduled, now, Math.max(CHAIN_GAP, 2 * hi * MIN));
    const all = [...chain, ...pinned];
    const win = Math.min(lo, 61) * MIN; // posts closer than this clash
    const out = [];
    let anchor = chain.length ? chain[chain.length - 1] : null;
    for (let i = 0; i < count; i++) {
      let t = anchor === null ? ceilQuarter(now + leadMs + 5 * MIN) : ceilQuarter(anchor + gapAfter(anchor, lo, hi));
      t = Math.max(t, ceilQuarter(now + leadMs));
      for (let guard = 0; guard < 500; guard++) {
        const clash = all.find((p) => Math.abs(p - t) < win);
        if (clash === undefined) break;
        const base = Math.max(clash, t);
        t = ceilQuarter(base + gapAfter(base, lo, hi));
      }
      out.push(t);
      all.push(t);
      anchor = t;
    }
    return out;
  }
  // X can render the Scheduled list in another timezone when the tab is hidden (seen: 8h behind).
  // Find the shift (15-min steps, ±16h) that best lines a hidden read up with a trusted visible read.
  function bestShift(hidden, trusted) {
    const set = new Set(trusted);
    let best = { shift: 0, hits: -1 };
    for (let q = -64; q <= 64; q++) {
      const k = q * QUARTER;
      let hits = 0;
      for (const t of hidden) if (set.has(t + k)) hits++;
      if (hits > best.hits || (hits === best.hits && Math.abs(k) < Math.abs(best.shift))) best = { shift: k, hits };
    }
    const need = Math.max(3, Math.floor(Math.min(hidden.length, trusted.length) / 2));
    return best.hits >= need ? best.shift : null;
  }
  // Fixed daily slots (LinkedIn): local times like [[21,0],[1,0]].
  // The queue is the run of upcoming posts with no gap over 2 days; Queue takes the first
  // slot after its last post that has no post within 60 min.
  function fixedSlots(scheduled, now, count = 1, times = [[21, 0], [1, 0]], leadMs = 5 * MIN) {
    const up = scheduled.filter((t) => t > now).sort((a, b) => a - b);
    let anchor = now;
    for (const t of up) {
      if (t - anchor > 48 * HOUR) break;
      anchor = t;
    }
    const taken = [...up];
    const out = [];
    const d = new Date(Math.max(anchor, now + leadMs));
    d.setHours(0, 0, 0, 0);
    const sorted = [...times].sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
    for (let day = 0; out.length < count && day < 800; day++) {
      for (const [h, m] of sorted) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, h, m).getTime();
        if (t <= anchor || t < now + leadMs) continue;
        if (taken.some((p) => Math.abs(p - t) < 60 * MIN)) continue;
        out.push(t);
        taken.push(t);
        if (out.length >= count) break;
      }
    }
    return out;
  }
  // "Mon, Nov 23, 2026 at 6:00 PM" (LinkedIn list) — same shape as X's.
  const parsePosting = (text) => parseWillSend(String(text).replace(/^Posting( at)?\s*/i, ""));
  const pad2 = (n) => String(n).padStart(2, "0");
  const mdy = (t) => { const d = new Date(t); return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`; };
  // LinkedIn composer banner: "Posting at Thu, Nov 26, 1:00 AM" (no year).
  function liBanner(t) {
    const d = new Date(t);
    const wd = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
    const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
    return `${wd}, ${mo} ${d.getDate()}, ${timeLabel(t)}`;
  }
  // Cadence presets, chosen per site from the ▾ menu.
  const CADENCES = {
    r61_90: { label: "Every 61–90 min (random)", lo: 61, hi: 90 },
    h1: { label: "Every hour", lo: 60, hi: 60 },
    m90: { label: "Every 90 minutes", lo: 90, hi: 90 },
    h3: { label: "Every 3 hours", lo: 180, hi: 180 },
    d1: { label: "Every day", lo: 1440, hi: 1440 },
    slots: { label: "Daily at set times", times: true },
  };
  const DEFAULT_CADENCE = { x: "r61_90", li: "slots" };
  const DEFAULT_TIMES = [[21, 0], [1, 0]];
  const hm = ([h, m]) => `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
  const timesLabel = (times) => (times?.length ? times.map(hm).join(", ") : "no times set");
  // "21:30" <-> [21, 30]
  const toHHMM = ([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const fromHHMM = (v) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(v || "");
    return m && +m[1] < 24 && +m[2] < 60 ? [+m[1], +m[2]] : null;
  };
  function slotsFor(cadenceId, scheduled, now, count = 1, times = DEFAULT_TIMES) {
    const c = CADENCES[cadenceId] || CADENCES.r61_90;
    if (c.times) return times?.length ? fixedSlots(scheduled, now, count, times) : [];
    return queueSlots(scheduled, now, count, 5 * MIN, c.lo, c.hi);
  }

  // Adds a "Cadence" section to a menu.
  // onPick(id) saves the cadence; onTimes(times) saves the daily times (and picks "slots").
  function cadenceMenu(menu, current, onPick, times, onTimes) {
    const h = document.createElement("div");
    h.className = "xq-menu-h xq-menu-sep";
    h.textContent = "Cadence";
    menu.append(h);
    for (const [id, c] of Object.entries(CADENCES)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "xq-cad" + (id === current ? " xq-on" : "");
      item.textContent = c.times ? `Daily at ${timesLabel(times)}` : c.label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        onPick(id);
      });
      menu.append(item);
      if (c.times) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "xq-cad xq-cad-edit";
        edit.textContent = "Edit times…";
        edit.addEventListener("click", (e) => {
          e.stopPropagation();
          timesEditor(menu, times, onTimes);
        });
        menu.append(edit);
      }
    }
  }

  // Replaces the menu with a small editor: one time field per daily slot.
  function timesEditor(menu, times, onTimes) {
    menu.addEventListener("click", (e) => e.stopPropagation()); // keep the menu open while editing
    menu.innerHTML = '<div class="xq-menu-h">Daily post times</div><div class="xq-times"></div>';
    const list = menu.querySelector(".xq-times");
    const addRow = (v) => {
      const row = document.createElement("div");
      row.className = "xq-time-row";
      const input = document.createElement("input");
      input.type = "time";
      input.step = 900; // 15 min, X's picker steps
      input.value = v;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "xq-time-del";
      del.setAttribute("aria-label", "Remove time");
      del.textContent = "×";
      del.addEventListener("click", () => row.remove());
      row.append(input, del);
      list.append(row);
      return input;
    };
    (times?.length ? times : DEFAULT_TIMES).forEach((t) => addRow(toHHMM(t)));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "xq-cad xq-time-add";
    add.textContent = "+ Add time";
    add.addEventListener("click", () => addRow("12:00").focus());
    const bar = document.createElement("div");
    bar.className = "xq-time-bar";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "xq-time-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => menu.remove());
    const save = document.createElement("button");
    save.type = "button";
    save.className = "xq-time-save";
    save.textContent = "Save";
    save.addEventListener("click", () => {
      const seen = new Set();
      const out = [];
      for (const i of list.querySelectorAll("input")) {
        const t = fromHHMM(i.value);
        if (t && !seen.has(t.join(":"))) {
          seen.add(t.join(":"));
          out.push(t);
        }
      }
      if (!out.length) {
        menu.querySelector(".xq-menu-h").textContent = "Add at least one time";
        return;
      }
      out.sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
      menu.remove();
      onTimes(out);
    });
    bar.append(cancel, save);
    menu.append(add, bar);
  }

  // Button paint (shared by X and LinkedIn). Icons are inline SVG so no fonts load.
  const CHEVRON = '<svg class="xq-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7l7-7"/></svg>';
  // Label only; the slot shows in the tooltip and the ▾ menu.
  function paintBtn(btn, main, slotTitle) {
    btn.textContent = main;
    btn.title = slotTitle ? `Queue for ${slotTitle}` : "";
  }
  const clashes = (scheduled, t) => scheduled.some((p) => Math.abs(p - t) < 61 * MIN);

  function hourKey(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
  }

  // Labels X's schedule picker uses (en-US).
  function dayLabel(t) {
    const d = new Date(t);
    const wd = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getDay()];
    const mo = ["January","February","March","April","May","June","July","August","September","October","November","December"][d.getMonth()];
    return `${wd}, ${mo} ${d.getDate()}, ${d.getFullYear()}`;
  }
  function timeLabel(t) {
    const d = new Date(t);
    const h = d.getHours() % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
  }
  function monthLabel(t) {
    const d = new Date(t);
    return `${["January","February","March","April","May","June","July","August","September","October","November","December"][d.getMonth()]} ${d.getFullYear()}`;
  }
  function shortLabel(t, now = Date.now()) {
    const d = new Date(t);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const day = new Date(t); day.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / (24 * HOUR));
    const h = d.getHours() % 12 || 12;
    const time = d.getMinutes() ? `${h}:${String(d.getMinutes()).padStart(2, "0")}` : `${h}`;
    const ampm = d.getHours() < 12 ? "am" : "pm";
    const wd = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
    const prefix = diff === 0 ? "" : diff === 1 ? "tmrw " : diff < 7 ? `${wd} ` : `${wd} ${d.getDate()} `;
    return `${prefix}${time}${ampm}`;
  }

  const api = { CADENCES, DEFAULT_CADENCE, DEFAULT_TIMES, timesLabel, toHHMM, fromHHMM, slotsFor, cadenceMenu, paintBtn, CHEVRON, parseWillSend, bestShift, fixedSlots, parsePosting, mdy, liBanner, freeSlots, queueSlots, splitQueue, clashes, gapAfter, dayLabel, timeLabel, monthLabel, shortLabel, hourKey };
  root.XQSlots = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
