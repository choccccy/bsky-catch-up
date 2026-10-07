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
