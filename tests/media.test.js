"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const a = h.actor(1), b = h.actor(2);

test("galleries render as a strip with counters and arrows", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("G", a, 10, { embed: h.embeds.gallery(6) }))] } });
  await page.startDate(h.BASE);
  const g = page.$(".gallery");
  assert.equal(g.children.length, 6);
  assert.deepEqual(page.$$(".g-count").map(x => x.textContent), ["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
  assert.ok(page.$(".g-nav.prev").classList.contains("off"), "no previous arrow at the start");
  assert.ok(!page.$(".g-nav.next").classList.contains("off"));
});

test("unknown gallery items and unknown embeds show a bsky.app fallback", async () => {
  const gal = h.embeds.gallery(2); gal.items.push({ $type: "app.bsky.embed.gallery#viewVideo" });
  const page = await h.loadPage({ server: { timeline: [
    h.item(h.post("G", a, 10, { embed: gal })), h.item(h.post("U", a, 11, { embed: h.embeds.unknown() })),
  ] } });
  await page.startDate(h.BASE);
  assert.equal(page.$$(".g-unsupported").length, 1);
  assert.ok(page.article("U").querySelector(".embed-unknown a[href*='bsky.app']"));
});

test("the lightbox steps through all images in a post", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("G", a, 10, { embed: h.embeds.gallery(5) }))] } });
  await page.startDate(h.BASE);
  page.$$('.gallery [data-act="zoom"]')[1].click();
  const lb = page.$("#lightbox");
  const state = () => [lb.querySelector("img").getAttribute("src"), lb.querySelector(".lb-count").textContent];
  assert.deepEqual(state(), ["gfull2.jpg", "2 / 5"]);
  assert.equal(lb.querySelector(".lb-alt").textContent, "second");
  page.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowRight" }));
  assert.deepEqual(state(), ["gfull3.jpg", "3 / 5"]);
  lb.querySelector(".lb-nav.prev").click(); lb.querySelector(".lb-nav.prev").click();
  assert.deepEqual(state(), ["gfull1.jpg", "1 / 5"]);
  assert.ok(lb.querySelector(".lb-nav.prev").classList.contains("hidden"));
  lb.click();
  assert.ok(lb.classList.contains("hidden"));
});

test("quoted posts get an action bar; like state is looked up first", async () => {
  const quoted = h.post("Q", h.actor(9), -1000, { likeCount: 5 });
  const page = await h.loadPage({ server: {
    timeline: [h.item(h.post("P", a, 10, { embed: h.embeds.quote(quoted) }))],
    posts: { [quoted.uri]: { ...quoted, likeCount: 6, viewer: { like: `at://${h.ME.did}/app.bsky.feed.like/old` } } },
  } });
  await page.startDate(h.BASE);
  const like = () => page.$(`.quote[data-uri="${quoted.uri}"] [data-act="like"]`);
  assert.ok(like().classList.contains("busy"), "disabled until hydrated");
  await h.waitFor(() => like().classList.contains("liked"), { message: "hydrated" });
  assert.equal(like().textContent.trim(), "6");
  like().click();
  await h.waitFor(() => !like().classList.contains("liked"), { message: "unliked" });
  // The UI updates optimistically, before the request goes out; wait for it.
  await h.waitFor(() => page.calls.includes("com.atproto.repo.deleteRecord"), { message: "deleteRecord request" });
});

test("copy link on gallery posts uses the embed proxy", async () => {
  const g = h.post("G", a, 10, { embed: h.embeds.gallery(5) }), n = h.post("N", a, 11);
  const page = await h.loadPage({ server: { timeline: [h.item(g), h.item(n)] } });
  await page.startDate(h.BASE);
  const copy = id => page.article(id).querySelector(':scope > .pv:last-child [data-act="copy"]').click();
  copy("G"); await h.wait(20);
  assert.equal(page.clip.at(-1), "https://xbsky.app/profile/u1.test/post/G");
  copy("N"); await h.wait(20);
  assert.equal(page.clip.at(-1), "https://bsky.app/profile/u1.test/post/N");
  await page.setSetting("galleryProxyHost", "https://fxbsky.app/x");
  copy("G"); await h.wait(20);
  assert.equal(page.clip.at(-1), "https://fxbsky.app/profile/u1.test/post/G");
  await page.setSetting("galleryProxy", false);
  copy("G"); await h.wait(20);
  assert.equal(page.clip.at(-1), "https://bsky.app/profile/u1.test/post/G");
});

test("videos preload ahead, switch to full buffering on play, and unload", async () => {
  const timeline = Array.from({ length: 6 }, (_, i) => h.item(h.post("V" + i, a, 10 + i, { embed: h.embeds.video() })));
  const page = await h.loadPage({ server: { timeline } });
  await page.startDate(h.BASE);
  const po = page.observers.find(o => o.opts.rootMargin);
  const boxes = po.targets.slice(0, 6);
  po.cb(boxes.map(target => ({ target, isIntersecting: true })));
  await h.wait(350);
  assert.deepEqual(boxes.map(b => !!b._video), [true, true, true, false, false, false], "3 preloaded by default");
  assert.equal(boxes[0]._hls.config.maxBufferLength, 6);
  boxes[0].querySelector(".play").click();
  assert.equal(boxes[0]._hls.config.maxBufferLength, 30);
  po.cb([{ target: boxes[1], isIntersecting: false }]);
  await h.wait(350);
  assert.ok(!boxes[1]._video && boxes[1].querySelector(".play"), "unloaded back to its placeholder");
});

test("adult-labelled media is blurred until revealed", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("S", a, 10, { embed: h.embeds.images(1), labels: [{ val: "nudity" }] }))] } });
  await page.startDate(h.BASE);
  const wrap = page.$(".blurwrap");
  assert.ok(wrap.classList.contains("blurred"));
  wrap.querySelector('[data-act="reveal"]').click();
  assert.ok(!wrap.classList.contains("blurred"));
});

/* GIF videos (presentation "gif"), added in 0.9.0. */
test("GIF videos loop silently without controls and autoplay by default", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("G", a, 10, { embed: h.embeds.gifVideo() }))] } });
  await page.startDate(h.BASE);
  const box = page.$(".video");
  assert.ok(box.classList.contains("is-gif") && box.querySelector(".gif-badge"), "marked as a GIF");
  const auto = page.observers.find(o => Array.isArray(o.opts.threshold));
  assert.ok(auto && auto.targets.includes(box), "watched for autoplay");
  auto.cb([{ target: box, intersectionRatio: 0.9 }]);
  const v = box._video;
  assert.ok(v.loop && v.muted && !v.controls, "loop, muted, no controls");
  assert.ok(box.querySelector(".gif-badge"), "badge kept once playing");
});

test("with GIFs set to click to play, they aren't autoplayed", async () => {
  const page = await h.loadPage({ settings: { gifMode: "click" }, server: { timeline: [h.item(h.post("G", a, 10, { embed: h.embeds.gifVideo() }))] } });
  await page.startDate(h.BASE);
  const auto = page.observers.find(o => Array.isArray(o.opts.threshold));
  assert.ok(!auto || !auto.targets.length, "not watched for autoplay");
  page.$(".video .play").click();
  assert.ok(page.$(".video")._video.loop, "still loops once clicked");
});

test("reduced motion stops GIFs from autoplaying", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("G", a, 10, { embed: h.embeds.gifVideo() }))] } });
  page.window.matchMedia = q => ({ matches: q.includes("reduce") });
  await page.startDate(h.BASE);
  const auto = page.observers.find(o => Array.isArray(o.opts.threshold));
  assert.ok(!auto || !auto.targets.length);
});

test("regular videos keep their controls and don't loop", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("V", a, 10, { embed: h.embeds.video() }))] } });
  await page.startDate(h.BASE);
  page.$(".video .play").click();
  const v = page.$(".video")._video;
  assert.ok(v.controls && !v.loop);
  assert.ok(!page.$(".video .gif-badge"));
});

/* Attachments of deeply nested posts (0.10.0): the API sends no embed views
   for a quote inside a quote, so the page summarizes the raw record. */
function nested(rawEmbed) {
  const inner = h.post("IN", h.actor(7), -2000, { rawEmbed });          // only the raw record embed
  const mid = h.post("MID", h.actor(8), -1000, { embed: h.embeds.quote(inner), rawEmbed: h.raw.quote(inner) });
  const outer = h.post("OUT", a, 10, { embed: h.embeds.quote(mid) });
  // Mimic the AppView: the innermost record view carries no embeds.
  outer.embed.record.embeds[0].record.embeds = [];
  return { inner, timeline: [h.item(outer)] };
}

test("a quote inside a quote shows image thumbnails from the raw record", async () => {
  const { inner, timeline } = nested(h.raw.images(5));
  const page = await h.loadPage({ server: { timeline } });
  await page.startDate(h.BASE);
  const q = page.$(`.quote[data-uri="${inner.uri}"]`);
  const thumbs = [...q.querySelectorAll(".mini-thumb")];
  assert.equal(thumbs.length, 5);
  assert.equal(thumbs.filter(t => !t.classList.contains("hidden")).length, 4, "four visible");
  assert.equal(thumbs[0].querySelector("img").getAttribute("src"), `https://cdn.bsky.app/img/feed_thumbnail/plain/${inner.author.did}/bafyimg1@jpeg`);
  assert.match(q.querySelector(".ms-label").textContent, /5 images · View on bsky\.app/);
  thumbs[1].click();
  assert.equal(page.$("#lightbox img").getAttribute("src"), `https://cdn.bsky.app/img/feed_fullsize/plain/${inner.author.did}/bafyimg2@jpeg`);
  assert.equal(page.$("#lightbox .lb-count").textContent, "2 / 5", "the viewer steps through all of them");
});

test("nested videos, GIFs, links and quotes are labelled", async () => {
  for (const [rawEmbed, want] of [[h.raw.video(), /^Video/], [h.raw.video(true), /^GIF/], [h.raw.link(), /^Link: An article/], [h.raw.quote(h.post("Z", a, 0)), /^Quotes another post/]]) {
    const { inner, timeline } = nested(rawEmbed);
    const page = await h.loadPage({ server: { timeline } });
    await page.startDate(h.BASE);
    assert.match(page.$(`.quote[data-uri="${inner.uri}"] .ms-label`).textContent, want);
    page.close();
  }
});

test("reply reminders say what the parent has attached", async () => {
  const P = h.post("P", a, 10, { embed: h.embeds.images(3), rawEmbed: h.raw.images(3) });
  const R = h.post("R", a, 20, { replyTo: P });
  const page = await h.loadPage({ settings: { dayDividers: false, hourDividers: false }, server: { timeline: [h.item(P), h.item(h.post("X", a, 15)), h.item(R, { parent: P })] } });
  await page.startDate(h.BASE);
  assert.equal(page.article("R").querySelector(".parent-mini .pm-media").textContent, "3 images");
});
