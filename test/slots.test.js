process.env.TZ = "Asia/Makassar";
const S = require("../extension/slots.js");
const assert = require("assert");
const t = (s) => new Date(s).getTime();
assert.equal(S.parseWillSend("Will send on Mon, Nov 23, 2026 at 7:30 AM"), t("2026-11-23T07:30:00"));
assert.equal(S.parseWillSend("Tue, Dec 15, 2026 at 10:00 PM"), t("2026-12-15T22:00:00"));
assert.equal(S.parseWillSend("Sat, Apr 3, 2027 at 12:05 AM"), t("2027-04-03T00:05:00"));
assert.equal(S.parseWillSend("Sat, Apr 3, 2027 at 12:05 PM"), t("2027-04-03T12:05:00"));
const now = t("2026-11-23T06:41:00");
const sched = ["2026-11-23T07:30","2026-11-23T10:00","2026-11-23T08:00"].map(t);
assert.deepEqual(S.freeSlots(sched, now, 3), ["2026-11-23T09:00","2026-11-23T11:00","2026-11-23T12:00"].map(t));
// lead time: 6:57 -> 7:00 is too close (5 min lead) -> 8:00 slot
assert.deepEqual(S.freeSlots([], t("2026-11-23T06:57:00"), 1), [t("2026-11-23T08:00")]);
assert.deepEqual(S.freeSlots([], t("2026-11-23T06:50:00"), 1), [t("2026-11-23T07:00")]);
assert.equal(S.dayLabel(t("2026-11-24T14:00")), "Tuesday, November 24, 2026");
assert.equal(S.timeLabel(t("2026-11-24T14:00")), "2:00 PM");
assert.equal(S.timeLabel(t("2026-11-24T00:00")), "12:00 AM");
assert.equal(S.shortLabel(t("2026-11-24T14:00"), now), "tmrw 2pm");
assert.equal(S.shortLabel(t("2026-11-23T09:00"), now), "9am");
console.log("ok");
// --- queue model ---
{
  const M = 60000, now = t("2026-11-23T07:04:00");
  const chain = ["2026-11-23T07:30","2026-11-23T08:45","2026-11-23T10:00"].map(t);
  const pinned = [t("2027-04-03T06:56"), t("2026-12-01T22:00")];
  const { chain: c, pinned: p } = S.splitQueue([...chain, ...pinned], now);
  assert.equal(c.length, 3); assert.equal(p.length, 2);
  const [s1, s2, s3] = S.queueSlots([...chain, ...pinned], now, 3);
  const g1 = (s1 - chain[2]) / M;
  assert.ok(g1 >= 61 && g1 <= 105 && s1 % (15 * M) === 0, "gap " + g1);
  assert.ok((s2 - s1) / M >= 61 && (s3 - s2) / M >= 61);
  // stable label vs click
  assert.equal(S.queueSlots([...chain, ...pinned], now, 1)[0], s1);
  // empty queue -> soon
  const e = S.queueSlots([], now, 1)[0];
  assert.ok(e - now >= 5 * M && e - now <= 30 * M, "empty " + (e - now) / M);
  // avoids a pinned post right after the chain end
  const pin = chain[2] + 75 * M;
  const s = S.queueSlots([...chain, pin, t("2027-04-03T06:56")], now, 1)[0];
  assert.ok(Math.abs(s - pin) >= 61 * M && s - chain[2] >= 61 * M);
}
console.log("queue ok");

// bestShift: hidden read 8h behind a visible one
{
  const S2 = require("../extension/slots.js");
  const H = 3600e3;
  const vis = [0, 1, 2, 3, 4, 5].map((i) => Date.UTC(2026, 10, 23, 4, 45) + i * 75 * 60e3);
  const hid = vis.map((t) => t - 8 * H).concat([Date.UTC(2026, 10, 30)]);
  if (S2.bestShift(hid, vis) !== 8 * H) throw new Error("bestShift 8h");
  if (S2.bestShift(vis, vis) !== 0) throw new Error("bestShift 0");
  if (S2.bestShift([1, 2], vis) !== null) throw new Error("bestShift none");
  console.log("shift ok");
}

// LinkedIn fixed slots
{
  const S3 = require("../extension/slots.js");
  const L = (y, mo, d, h, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
  const now = L(2026, 11, 23, 13, 30);
  const sched = [];
  for (let d = 23; d <= 30; d++) sched.push(L(2026, 11, d, 21), L(2026, 11, d + 1, 1));
  sched.push(L(2026, 11, 23, 18), L(2026, 11, 23, 23, 45));
  sched.push(L(2027, 4, 3, 7)); // pinned far away
  const got = S3.fixedSlots(sched, now, 3).map((t) => new Date(t).toString().slice(0, 21));
  const want = [L(2026, 12, 1, 21), L(2026, 12, 2, 1), L(2026, 12, 2, 21)].map((t) => new Date(t).toString().slice(0, 21));
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("fixedSlots " + got);
  // empty queue: next slot today 9 PM
  if (S3.fixedSlots([], now, 1)[0] !== L(2026, 11, 23, 21)) throw new Error("fixedSlots empty");
  if (S3.parsePosting("Posting Mon, Nov 23, 2026 at 6:00 PM") !== L(2026, 11, 23, 18)) throw new Error("parsePosting");
  if (S3.mdy(L(2026, 11, 3, 1)) !== "11/03/2026") throw new Error("mdy");
  if (S3.liBanner(L(2026, 11, 26, 1)) !== "Thu, Nov 26, 1:00 AM") throw new Error("liBanner " + S3.liBanner(L(2026, 11, 26, 1)));
  console.log("linkedin ok");
}

// cadences
{
  const S4 = require("../extension/slots.js");
  const L = (y, mo, d, h, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
  const now = L(2026, 11, 23, 13, 0);
  const chain = [L(2026, 11, 23, 14), L(2026, 11, 23, 15, 30)];
  const eq = (a, b, m) => { if (a !== b) throw new Error(m + " " + new Date(a) + " vs " + new Date(b)); };
  eq(S4.slotsFor("h1", chain, now)[0], L(2026, 11, 23, 16, 30), "h1");
  eq(S4.slotsFor("m90", chain, now)[0], L(2026, 11, 23, 17), "m90");
  eq(S4.slotsFor("h3", chain, now)[0], L(2026, 11, 23, 18, 30), "h3");
  eq(S4.slotsFor("d1", chain, now)[0], L(2026, 11, 24, 15, 30), "d1");
  // daily chain spanning days stays one chain
  const daily = [L(2026, 11, 24, 9), L(2026, 11, 25, 9), L(2026, 11, 26, 9)];
  eq(S4.slotsFor("d1", daily, now)[0], L(2026, 11, 27, 9), "d1 chain");
  const r = S4.slotsFor("r61_90", chain, now)[0] - chain[1];
  if (r < 61 * 60e3 || r > 105 * 60e3) throw new Error("r61_90 " + r / 60e3);
  eq(S4.slotsFor("slots", [], now)[0], L(2026, 11, 23, 21), "slots");
  console.log("cadence ok");
}

// editable daily times
{
  const S5 = require("../extension/slots.js");
  const L = (y, mo, d, h, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
  const now = L(2026, 11, 23, 13, 0);
  if (S5.slotsFor("slots", [], now, 1, [[8, 30], [18, 0]])[0] !== L(2026, 11, 23, 18)) throw new Error("custom times");
  if (S5.slotsFor("slots", [], now, 1, [])[0] !== undefined) throw new Error("empty times");
  if (S5.timesLabel([[21, 0], [1, 30]]) !== "9 PM, 1:30 AM") throw new Error("label " + S5.timesLabel([[21, 0], [1, 30]]));
  if (S5.toHHMM([9, 5]) !== "09:05" || S5.fromHHMM("21:45").join() !== "21,45" || S5.fromHHMM("25:00") !== null) throw new Error("hhmm");
  console.log("times ok");
}
