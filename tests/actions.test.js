"use strict";
/* Likes and reposts (0.10.1): sent immediately, shown as pending until
   confirmed, read back from the account, failures shown in the banner. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const a = h.actor(1);
const P = h.post("A", a, 10, { likeCount: 4 });
const timeline = [h.item(P)];
const likeBtn = page => page.article("A").querySelector(':scope > .pv:last-child [data-act="like"]');

test("a like is created, read back from the account, and kept", async () => {
  const page = await h.loadPage({ server: { timeline } });
  await page.startDate(h.BASE);
  likeBtn(page).click();
  await h.waitFor(() => likeBtn(page).classList.contains("liked") && !likeBtn(page).classList.contains("pending"), { message: "confirmed like" });
  assert.ok(page.calls.includes("com.atproto.repo.getRecord"), "read back");
  const rec = page.records().find(r => r.collection === "app.bsky.feed.like");
  assert.deepEqual(rec.record.subject, { uri: P.uri, cid: P.cid });
  assert.equal(rec.repo, h.ME.did);
  assert.equal(page.banner(), "");
});

test("the button shows as pending until Bluesky answers", async () => {
  let release;
  const gate = new Promise(r => (release = r));
  const page = await h.loadPage({ server: { timeline, handlers: {
    "com.atproto.repo.createRecord": async (p, body) => { await gate; return { uri: `at://${h.ME.did}/${body.collection}/slow`, cid: "c" }; },
    "com.atproto.repo.getRecord": () => ({ uri: "x", cid: "c", value: {} }),
  } } });
  await page.startDate(h.BASE);
  likeBtn(page).click();
  await h.waitFor(() => likeBtn(page).classList.contains("pending"), { message: "pending" });
  assert.equal(likeBtn(page).title, "Saving…");
  release();
  await h.waitFor(() => !likeBtn(page).classList.contains("pending"), { message: "settled" });
  assert.ok(likeBtn(page).classList.contains("liked"));
});

test("likes aren't held back by a rate-limit pause from feed loading", async () => {
  const page = await h.loadPage({ server: { timeline } });
  await page.startDate(h.BASE);
  page.eval("pacer.pauseFor(60000)");
  likeBtn(page).click();
  await h.waitFor(() => page.calls.includes("com.atproto.repo.createRecord"), { timeout: 1000, message: "sent right away" });
});

test("a reply that doesn't confirm the record rolls back with a notice", async () => {
  const page = await h.loadPage({ server: { timeline, handlers: { "com.atproto.repo.createRecord": () => ({}) } } });
  await page.startDate(h.BASE);
  likeBtn(page).click();
  await h.waitFor(() => page.banner(), { message: "banner" });
  assert.match(page.banner(), /didn't confirm the like was saved/);
  assert.ok(!likeBtn(page).classList.contains("liked"));
  assert.equal(likeBtn(page).textContent.trim(), "4");
});

test("a like that isn't found in the account afterwards rolls back with a notice", async () => {
  const page = await h.loadPage({ server: { timeline, handlers: {
    "com.atproto.repo.createRecord": (p, body) => ({ uri: `at://${h.ME.did}/${body.collection}/ghost`, cid: "c" }),
  } } });
  await page.startDate(h.BASE);
  likeBtn(page).click();
  await h.waitFor(() => page.banner(), { message: "banner" });
  assert.match(page.banner(), /isn't in your account/);
  assert.ok(!likeBtn(page).classList.contains("liked"));
});

test("being rate-limited fails right away with a clear notice", async () => {
  const page = await h.loadPage({ server: { timeline, handlers: {
    "com.atproto.repo.createRecord": () => ({ status: 429, error: "RateLimitExceeded", message: "Rate Limit Exceeded" }),
  } } });
  await page.startDate(h.BASE);
  likeBtn(page).click();
  await h.waitFor(() => page.banner(), { timeout: 2000, message: "banner" });
  assert.match(page.banner(), /limiting how fast/);
  assert.ok(!likeBtn(page).classList.contains("liked"));
});

test("unliking deletes the record from the account", async () => {
  const page = await h.loadPage({ server: { timeline } });
  await page.startDate(h.BASE);
  likeBtn(page).click();
  await h.waitFor(() => page.records().length === 1, { message: "created" });
  await h.waitFor(() => !likeBtn(page).classList.contains("pending"), { message: "settled" });
  likeBtn(page).click();
  await h.waitFor(() => page.records().length === 0, { message: "deleted" });
  assert.ok(!likeBtn(page).classList.contains("liked"));
});

/* ---------- following an author from the feed (1.1.8) ---------- */
const stranger = h.actor(9);
const known = h.actor(3, { viewer: { following: "at://did:plc:me/app.bsky.graph.follow/old" } });
const followBtn = (page, id) => page.article(id).querySelector('[data-act="follow"]');
/* Two posts by the same stranger, one by someone already followed, one of
   mine, and one by an author the server told us nothing about. */
const unknownAuthor = h.actor(7, { viewer: undefined });
const followTimeline = [
  h.item(h.post("S1", stranger, 10)),
  h.item(h.post("S2", stranger, 11)),
  h.item(h.post("K", known, 12)),
  h.item(h.post("ME", h.ME, 13)),
  h.item(h.post("U", unknownAuthor, 14)),
];

test("every post gets the same Follow button, saying which way round it is", async () => {
  const page = await h.loadPage({ server: { timeline: followTimeline } });
  await page.startDate(h.BASE);
  assert.ok(followBtn(page, "S1"), "someone I don't follow");
  assert.ok(!followBtn(page, "S1").classList.contains("on"));
  assert.match(followBtn(page, "S1").title, /^Follow @u9/);
  assert.ok(followBtn(page, "K").classList.contains("on"), "someone I already follow, marked");
  assert.match(followBtn(page, "K").title, /^Unfollow @u3/);
  // Not in the follow list and no viewer state of their own, but the follow
  // list was loaded, so "not in it" is an answer.
  assert.ok(followBtn(page, "U"), "an author the feed said nothing about");
  assert.ok(!followBtn(page, "ME"), "never myself");
  // First in the bar, before the reply link.
  const bar = page.article("S1").querySelector(".actions");
  assert.equal(bar.firstElementChild.dataset.act, "follow");
});

test("with nothing to go on, no button is drawn rather than a wrong one", async () => {
  // replies "all" on a custom feed: the follow list is never loaded, and this
  // author's entry carries no viewer state either.
  const FEED = "at://did:plc:owner/app.bsky.feed.generator/foryou";
  const page = await h.loadPage({ settings: { replies: "all" }, server: {
    savedFeeds: [{ id: "1", type: "feed", value: FEED, pinned: true }],
    feeds: { [FEED]: [h.item(h.post("U", unknownAuthor, 14)), h.item(h.post("S1", stranger, 10))] },
  } });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.ok(!page.calls.some(c => c.includes("getFollows")), "nothing loaded the follow list");
  assert.ok(!followBtn(page, "U"), "no viewer state and no follow list: no guess");
  assert.ok(followBtn(page, "S1"), "but an author the feed did describe gets one");
});

test("unfollowing someone followed before this catch-up removes their record", async () => {
  let deleted = null;
  const page = await h.loadPage({ settings: { confirmFollow: false }, server: {
    timeline: followTimeline,
    handlers: { "com.atproto.repo.deleteRecord": (p, body) => { deleted = body; return {}; } },
  } });
  await page.startDate(h.BASE);
  followBtn(page, "K").click();
  await h.waitFor(() => deleted, { message: "the unfollow" });
  assert.equal(deleted.collection, "app.bsky.graph.follow");
  assert.equal(deleted.rkey, "old", "the record their viewer state named");
  await h.waitFor(() => !followBtn(page, "K").classList.contains("on"), { message: "the button to turn over" });
});

test("an unfollow whose record nothing named looks the profile up", async () => {
  // In the follow list, but the feed sent no viewer state for them: the DID is
  // known to be followed, the record that says so isn't.
  const bare = h.actor(4, { viewer: undefined });
  let deleted = null;
  const page = await h.loadPage({ settings: { confirmFollow: false }, server: {
    timeline: [h.item(h.post("B", bare, 10))],
    handlers: {
      "app.bsky.actor.getProfile": p => ({ ...bare, viewer: { following: "at://did:plc:me/app.bsky.graph.follow/found" } }),
      "com.atproto.repo.deleteRecord": (p, body) => { deleted = body; return {}; },
    },
  } });
  await page.startDate(h.BASE);
  assert.ok(followBtn(page, "B").classList.contains("on"), "the follow list says we follow them");
  followBtn(page, "B").click();
  await h.waitFor(() => deleted, { message: "the unfollow" });
  assert.equal(deleted.rkey, "found");
});

test("following writes the record and marks every post by that author", async () => {
  const page = await h.loadPage({ settings: { confirmFollow: false }, server: { timeline: followTimeline } });
  await page.startDate(h.BASE);
  followBtn(page, "S1").click();
  await h.waitFor(() => followBtn(page, "S1").classList.contains("on") && !followBtn(page, "S1").classList.contains("pending"),
    { message: "the follow to be confirmed" });
  const rec = page.records().find(r => r.collection === "app.bsky.graph.follow");
  assert.equal(rec.record.subject, stranger.did);
  assert.equal(rec.repo, h.ME.did);
  assert.ok(followBtn(page, "S2").classList.contains("on"), "their other post agrees");
  assert.match(followBtn(page, "S1").title, /Unfollow @u9/);
  assert.equal(page.banner(), "");

  // The button stays, and now unfollows.
  followBtn(page, "S1").click();
  await h.waitFor(() => !page.records().some(r => r.collection === "app.bsky.graph.follow"), { message: "the follow to be deleted" });
  assert.ok(!followBtn(page, "S1").classList.contains("on"));
  assert.ok(!followBtn(page, "S2").classList.contains("on"));
});

test("by default both following and unfollowing ask first", async () => {
  const page = await h.loadPage({ server: { timeline: followTimeline } });
  await page.startDate(h.BASE);
  const menuItem = () => page.$(".menu [data-m]");

  followBtn(page, "S1").click();
  await h.wait(20);
  assert.ok(menuItem(), "a menu, not a follow");
  assert.equal(page.records().length, 0, "nothing written yet");
  assert.match(menuItem().textContent, /Follow @u9/);
  menuItem().click();
  await h.waitFor(() => page.records().some(r => r.collection === "app.bsky.graph.follow"), { message: "the follow" });
  assert.ok(!page.$(".menu"), "the menu closes behind it");

  await h.waitFor(() => followBtn(page, "S1").classList.contains("on"), { message: "the marked button" });
  followBtn(page, "S1").click();
  await h.wait(20);
  assert.match(menuItem().textContent, /Unfollow @u9/, "unfollowing asks the same way");
  menuItem().click();
  await h.waitFor(() => !page.records().length, { message: "the unfollow" });
});

test("a follow that doesn't save rolls back with a notice", async () => {
  const page = await h.loadPage({ settings: { confirmFollow: false }, server: {
    timeline: followTimeline, handlers: { "com.atproto.repo.createRecord": () => ({}) },
  } });
  await page.startDate(h.BASE);
  followBtn(page, "S1").click();
  await h.waitFor(() => page.banner(), { message: "banner" });
  assert.match(page.banner(), /Couldn't follow @u9/);
  assert.ok(!followBtn(page, "S1").classList.contains("on"));
  assert.ok(!followBtn(page, "S1").classList.contains("pending"), "and isn't left looking busy");
});

test("following someone doesn't change what the catch-up is showing", async () => {
  const FEED = "at://did:plc:owner/app.bsky.feed.generator/foryou";
  const page = await h.loadPage({ settings: { confirmFollow: false, hideFollowed: "posts" }, server: {
    savedFeeds: [{ id: "1", type: "feed", value: FEED, pinned: true }],
    feedNames: { [FEED]: "For You" },
    feeds: { [FEED]: followTimeline },
  } });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.deepEqual(page.ids(), ["S1", "S2", "ME", "U"], "the stranger's posts, and mine; not the one I follow");
  followBtn(page, "S1").click();
  await h.waitFor(() => followBtn(page, "S1").classList.contains("on"), { message: "the follow" });
  // Any setting change rebuilds the view; the follow snapshot must be the one
  // the catch-up started with, or their posts would vanish mid-read.
  await page.setSetting("showCounts", false);
  assert.deepEqual(page.ids(), ["S1", "S2", "ME", "U"], "their posts are still here");
  assert.ok(followBtn(page, "S1").classList.contains("on"), "and still marked as followed");
});

test("no Follow button where a block is in the way", async () => {
  // passes() keeps blocked authors out of the feed, so the one way their post
  // view is drawn at all is as the parent of someone else's reply.
  const blocked = h.actor(6, { viewer: { blocking: "at://did:plc:me/app.bsky.graph.block/x" } });
  const parent = h.post("BP", blocked, 10);
  const page = await h.loadPage({ settings: { replies: "all" }, server: {
    timeline: [h.item(parent), h.item(h.post("R", stranger, 11, { replyTo: parent }), { parent })],
  } });
  await page.startDate(h.BASE);
  const parentView = page.article("R").querySelector(".pv.parent");
  assert.ok(parentView, "the parent is drawn");
  assert.ok(!parentView.querySelector('[data-act="follow"]'), "but offers no follow");
  assert.ok(followBtn(page, "R"), "while the reply's own author does");
});
