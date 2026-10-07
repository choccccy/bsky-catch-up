"use strict";
/* Post and repost times (0.11.0). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const a = h.actor(1), b = h.actor(2);
const old = h.post("OLDPOST", h.actor(9), -2 * 24 * 60);        // two days earlier
const P = h.post("P", a, 10);
const R = h.post("R", a, 30, { replyTo: old });
const timeline = [h.item(P), h.item(old, { repostBy: b, repostMin: 20 }), h.item(R, { parent: old })];
const clockOf = t => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const timeText = el => el.querySelector(":scope > .pv:last-child .pv-time").textContent;

test("reposts show the repost time above the original post's own time", async () => {
  const page = await h.loadPage({ server: { timeline } });
  await page.startDate(h.BASE);
  const card = page.article("OLDPOST");
  assert.equal(card.querySelector(".post-meta-line .repost-time").textContent, clockOf(h.BASE + 20 * h.MIN), "when it was reposted");
  assert.match(timeText(card), /, /, "the original's time includes its date (it's from an earlier day)");
  assert.ok(timeText(card).endsWith(clockOf(old.indexedAt)), "and is the original's time, not the repost's");
});

test("posts from the same day as their divider show just the time", async () => {
  const page = await h.loadPage({ server: { timeline } });
  await page.startDate(h.BASE);
  assert.equal(timeText(page.article("P")), clockOf(h.BASE + 10 * h.MIN));
});

test("a parent from an earlier day shows its date", async () => {
  // X sits between the repost and the reply, so the reply isn't joined onto
  // the repost card and shows its parent above it.
  const page = await h.loadPage({ settings: { replyContext: "full", replies: "all" }, server: { timeline: [...timeline, h.item(h.post("X", a, 25))] } });
  await page.startDate(h.BASE);
  assert.match(page.article("R").querySelector(".pv.parent .pv-time").textContent, /, /);
});

test("with day dividers off, every time includes the date", async () => {
  const page = await h.loadPage({ settings: { dayDividers: false }, server: { timeline } });
  await page.startDate(h.BASE);
  assert.match(timeText(page.article("P")), /, /);
});
