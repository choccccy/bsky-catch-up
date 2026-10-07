"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const [a, b, c] = [h.actor(1), h.actor(2), h.actor(3)];

test("timeline mode shows posts from the start time, oldest first", async () => {
  const page = await h.loadPage({ server: { timeline: [
    h.item(h.post("OLD", a, -60)), h.item(h.post("A", a, 10)), h.item(h.post("B", b, 20)), h.item(h.post("C", c, 30)),
  ] } });
  await page.startDate(h.BASE);
  assert.deepEqual(page.ids(), ["A", "B", "C"]);
  assert.match(page.$("#feedHead").textContent, /from your timeline/);
});

test("auto mode rebuilds from follows when the timeline runs out", async () => {
  const timeline = Array.from({ length: 30 }, (_, i) => h.item(h.post("P" + i, [a, b, c][i % 3], 170 - i * 5)));
  const page = await h.loadPage({ settings: { fetchMethod: "auto" }, server: { timeline, timelineLimit: 5 } });
  await page.startDate(h.BASE);
  assert.match(page.$("#feedHead").textContent, /rebuilt from \d+ follows/);
  assert.equal(page.ids().length, 30);
  assert.ok(page.calls.includes("app.bsky.feed.getAuthorFeed"));
});

test("rebuild skips muted follows", async () => {
  const muted = h.actor(9, { viewer: { muted: true } });
  const page = await h.loadPage({ settings: { fetchMethod: "rebuild" }, server: {
    follows: [a, muted], timeline: [h.item(h.post("A", a, 10)), h.item(h.post("M", muted, 11))],
  } });
  await page.startDate(h.BASE);
  assert.deepEqual(page.ids(), ["A"]);
});

test("starting from a post shows 12 earlier posts as context and highlights it", async () => {
  const timeline = Array.from({ length: 30 }, (_, i) => h.item(h.post("P" + i, a, 10 + i)));
  const page = await h.loadPage({ server: { timeline } });
  await page.startPost("https://bsky.app/profile/u1.test/post/P20");
  const ids = page.ids();
  assert.equal(ids[0], "P8");
  assert.ok(page.article("P20").classList.contains("anchor"));
  assert.equal(page.$$(".post.context").length, 12);
});

test("a repost of a post is found when starting from that post's link", async () => {
  const orig = h.post("X", h.actor(8), -500);
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10)), h.item(orig, { repostBy: b, repostMin: 20 }), h.item(h.post("C", a, 30))] } });
  await page.startPost("https://bsky.app/profile/did:plc:u8/post/X");
  assert.ok(page.article("X").classList.contains("anchor"));
  assert.match(page.article("X").textContent, /Reposted by User 2/);
});

test("rich text facets become links", async () => {
  const text = "hi @u2.test see #tag";
  const enc = s => Buffer.byteLength(s);
  const facets = [
    { index: { byteStart: enc("hi "), byteEnd: enc("hi @u2.test") }, features: [{ $type: "app.bsky.richtext.facet#mention", did: b.did }] },
    { index: { byteStart: enc("hi @u2.test see "), byteEnd: enc(text) }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "tag" }] },
  ];
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10, { text, facets }))] } });
  await page.startDate(h.BASE);
  const links = page.$$("#feed .pv-text a").map(x => x.getAttribute("href"));
  assert.deepEqual(links, [`https://bsky.app/profile/${encodeURIComponent(b.did)}`, "https://bsky.app/hashtag/tag"]);
});

test("post text is escaped, never injected as HTML", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10, { text: "<img src=x onerror=alert(1)>" }))] } });
  await page.startDate(h.BASE);
  assert.equal(page.$$("#feed .pv-text img").length, 0);
});

test("load newer posts appends without redrawing", async () => {
  const timeline = [h.item(h.post("A", a, 10))];
  const page = await h.loadPage({ server: { timeline } });
  await page.startDate(h.BASE);
  const first = page.article("A");
  timeline.push(h.item(h.post("NEW", a, 179)));   // the simulated server reads this array live
  page.$("#btnNewer").click();
  await h.waitFor(() => page.ids().includes("NEW"), { message: "newer post" });
  assert.deepEqual(page.ids(), ["A", "NEW"]);
  assert.equal(page.article("A"), first);
});

test("likes are optimistic and use the post's uri and cid", async () => {
  const p = h.post("A", a, 10, { likeCount: 4 });
  const page = await h.loadPage({ server: { timeline: [h.item(p)] } });
  await page.startDate(h.BASE);
  const like = () => page.article("A").querySelector('[data-act="like"]');
  like().click();
  await h.waitFor(() => like().classList.contains("liked"), { message: "liked" });
  assert.equal(like().textContent.trim(), "5");
  // The UI updates optimistically, before the request goes out; wait for it.
  await h.waitFor(() => page.calls.includes("com.atproto.repo.createRecord"), { message: "createRecord request" });
});

test("reading position is saved and offered for resume", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10)), h.item(h.post("B", a, 20))] } });
  await page.startDate(h.BASE);
  // jsdom does no layout (every box is 0x0), so give posts a position for
  // the "which post is at the top of the screen" calculation.
  page.window.Element.prototype.getBoundingClientRect = function () { return { top: 20, bottom: 120, left: 0, right: 0, width: 0, height: 100 }; };
  page.eval("updateClock()");
  const pos = JSON.parse(page.window.localStorage.getItem(`bcu:position:${h.ME.did}`));
  assert.ok(pos && pos.uri.endsWith("/A"));
  page.$("#btnNew").click();
  assert.ok(!page.$("#choiceResume").classList.contains("hidden"));
});

test("only the avatar itself links to the profile, not the column below it", async () => {
  // Regression test for 0.8.2. jsdom does no layout, so check the styles
  // that keep the link from stretching to the post's full height.
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10))] } });
  await page.startDate(h.BASE);
  const link = page.article("A").querySelector(":scope > .pv > .avatar-link");
  assert.ok(link, "avatar wrapped in .avatar-link");
  const cs = page.window.getComputedStyle(link);
  assert.equal(cs.alignSelf, "flex-start");
  assert.equal(cs.height, "40px");
});
