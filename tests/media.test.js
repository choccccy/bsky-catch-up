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

// ---------------------------------------------------------------------------
// "Show images whole" (settings.wholeImages) and its sub-settings.
// ---------------------------------------------------------------------------

/** Loads a page with the whole-image mode on, plus any other settings. */
const whole = (server, settings = {}) =>
  h.loadPage({ settings: { wholeImages: "whole", ...settings }, server });

test("by default images keep the Bluesky app's square layout", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(3) }))] } });
  await page.startDate(h.BASE);
  assert.equal(page.$$(".img-cell").length, 0, "no whole-image cells");
  assert.equal(page.$$(".alt-cap").length, 0, "no alt captions");
  assert.equal(page.$(".imgs").className, "imgs n3");
  // Thumbnails, not full-size files.
  assert.deepEqual(page.$$(".imgs img").map(i => i.getAttribute("src")), ["thumb1.jpg", "thumb2.jpg", "thumb3.jpg"]);
  assert.ok(!page.document.documentElement.hasAttribute("data-whole"));
});

test("whole mode gives every image its real ratio as --ar", async () => {
  const ratios = [{ width: 16, height: 9 }, { width: 3, height: 4 }];
  const page = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(2, ratios) }))] });
  await page.startDate(h.BASE);
  assert.deepEqual(page.$$(".imgs .img").map(b => b.style.getPropertyValue("--ar").trim()), ["16/9", "3/4"]);
  // The height cap is applied as a width worked out from these two numbers,
  // so they have to be there alongside the "16/9" form.
  assert.deepEqual(page.$$(".imgs .img").map(b => [b.style.getPropertyValue("--arw").trim(), b.style.getPropertyValue("--arh").trim()]),
    [["16", "9"], ["3", "4"]]);
  assert.equal(page.$$(".img-cell").length, 2, "each image gets its own cell");
  assert.ok(page.document.documentElement.hasAttribute("data-whole"));
});

test("an image with no aspectRatio just gets no --ar", async () => {
  const e = h.embeds.images(1); delete e.images[0].aspectRatio;
  const page = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: e }))] });
  await page.startDate(h.BASE);
  assert.equal(page.$(".imgs .img").style.getPropertyValue("--ar"), "");
});

test("the big file is offered only when the slot could use it", async () => {
  // One image fills the post (~610px here), so at 2x it wants more than the
  // 1000px thumbnail: both sizes are offered and the browser picks. Two
  // images share the row (~302px each), so even a 3x phone can't use the
  // 2000px file -- offering it would cost ~11MB of decoded memory for
  // nothing, so it isn't offered at all.
  const one = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(1) }))] });
  await one.startDate(h.BASE);
  const big = one.$(".imgs img");
  assert.deepEqual(big.getAttribute("srcset").split(", "), ["thumb1.jpg 1000w", "full1.jpg 2000w"]);
  assert.match(big.getAttribute("sizes"), /^\d+px$/);

  const two = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(2) }))] });
  await two.startDate(h.BASE);
  for (const img of two.$$(".imgs img")) {
    assert.equal(img.getAttribute("srcset").split(", ").length, 1, "small cells get the thumbnail only");
    assert.match(img.getAttribute("srcset"), /^thumb\d\.jpg 1000w$/);
  }
  // src stays the thumbnail everywhere, so a browser without srcset is fine.
  assert.deepEqual(two.$$(".imgs img").map(i => i.getAttribute("src")), ["thumb1.jpg", "thumb2.jpg"]);
});

test("every rendered image decodes off the main thread", async () => {
  const page = await whole({ timeline: [
    h.item(h.post("I", a, 10, { embed: h.embeds.images(2) })),
    h.item(h.post("G", a, 11, { embed: h.embeds.gallery(3) })),
  ] });
  await page.startDate(h.BASE);
  const imgs = page.$$("#feed .imgs img, #feed .gallery img");
  assert.ok(imgs.length >= 5);
  for (const i of imgs) assert.equal(i.getAttribute("decoding"), "async");
});

test("alt text becomes a caption, and replaces the ALT badge", async () => {
  const page = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(2) }))] });
  await page.startDate(h.BASE);
  // Only the first image has alt text in the builder.
  assert.deepEqual(page.$$(".alt-cap").map(c => c.textContent), ["first image"]);
  assert.equal(page.$$(".alt-badge").length, 0, "the badge gives way to the caption");
  const off = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(2) }))] }, { wholeAlt: false });
  await off.startDate(h.BASE);
  assert.equal(off.$$(".alt-cap").length, 0);
  assert.equal(off.$$(".alt-badge").length, 1, "the badge comes back");
});

test("a very tall image can be asked to fill the post's width", async () => {
  const tall = [{ width: 1, height: 4 }, { width: 4, height: 3 }];
  const page = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(2, tall) }))] });
  await page.startDate(h.BASE);
  const wraps = page.$$(".tallwrap");
  assert.equal(wraps.length, 1, "only the very tall one gets the button");
  assert.ok(!wraps[0].classList.contains("open"));
  page.$('[data-act="expand-img"]').click();
  assert.ok(page.$(".tallwrap").classList.contains("open"));
});

test("the lightbox still steps through every image in whole mode", async () => {
  const page = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(3) }))] });
  await page.startDate(h.BASE);
  page.$$('.imgs [data-act="zoom"]')[1].click();
  const lb = page.$("#lightbox");
  assert.equal(lb.querySelector(".lb-count").textContent, "2 / 3");
  assert.equal(lb.querySelector("img").getAttribute("src"), "full2.jpg");
});

test("galleries offer both sizes in whole mode but stay a strip", async () => {
  const page = await whole({ timeline: [h.item(h.post("G", a, 10, { embed: h.embeds.gallery(6) }))] });
  await page.startDate(h.BASE);
  assert.equal(page.$(".gallery").children.length, 6, "still one strip of six");
  // A strip item fills the post, so both sizes are offered there.
  assert.deepEqual(page.$$(".gallery img").map(i => i.getAttribute("src")).slice(0, 2), ["gthumb1.jpg", "gthumb2.jpg"]);
  assert.deepEqual(page.$(".gallery img").getAttribute("srcset").split(", "), ["gthumb1.jpg 1000w", "gfull1.jpg 2000w"]);
  // Strip items size themselves from the inline aspect-ratio, and need the
  // two numbers as well so the height cap can be applied as a width.
  const it = page.$(".g-item");
  assert.equal(it.style.aspectRatio, "4/3");
  assert.deepEqual([it.style.getPropertyValue("--arw").trim(), it.style.getPropertyValue("--arh").trim()], ["4", "3"]);
});

test("only posts with pictures or video are allowed the extra width", async () => {
  const page = await whole({ timeline: [
    h.item(h.post("IMG", a, 10, { embed: h.embeds.images(1) })),
    h.item(h.post("VID", a, 11, { embed: h.embeds.video() })),
    h.item(h.post("LINK", a, 12, { embed: h.embeds.link() })),
    h.item(h.post("TEXT", a, 13)),
  ] });
  await page.startDate(h.BASE);
  const wide = k => page.article(k).classList.contains("has-media");
  assert.deepEqual([wide("IMG"), wide("VID"), wide("LINK"), wide("TEXT")], [true, true, false, false]);
});

test("the sub-settings do nothing while the mode is off", async () => {
  const page = await h.loadPage({
    settings: { wholeImages: "app", wholeAlt: true, wholeFullsize: true, wholeVideo: true, wholeLinkThumbs: true },
    server: { timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(2) }))] },
  });
  await page.startDate(h.BASE);
  assert.deepEqual(page.$$(".imgs img").map(i => i.getAttribute("src")), ["thumb1.jpg", "thumb2.jpg"]);
  assert.equal(page.$$(".alt-cap").length, 0);
  const r = page.document.documentElement;
  assert.ok(!r.hasAttribute("data-whole") && !r.hasAttribute("data-whole-video") && !r.hasAttribute("data-whole-link"));
});

test("the mode and its width can be set from a catch-up link", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(2) }))] } });
  await page.startDate(h.BASE);
  assert.ok(!page.document.documentElement.hasAttribute("data-whole"));
  await page.setSetting("wholeImages", "whole");
  assert.ok(page.document.documentElement.hasAttribute("data-whole"));
  assert.equal(page.$$(".img-cell").length, 2);
});

test("images carry the author's alt text as a real alt attribute", async () => {
  // 0.12.0 shipped a mangled gallery <img> whose alt text became a stray
  // attribute, leaving alt empty for screen readers. Nothing asserted the
  // attribute itself, so nothing caught it.
  const page = await h.loadPage({ server: { timeline: [
    h.item(h.post("G", a, 10, { embed: h.embeds.gallery(3) })),
    h.item(h.post("I", a, 11, { embed: h.embeds.images(2) })),
  ] } });
  await page.startDate(h.BASE);
  const altsOf = sel => page.$$(sel).map(i => i.getAttribute("alt"));
  assert.deepEqual(altsOf(".gallery img"), ["", "second", ""], "gallery alt text reaches the img");
  assert.deepEqual(altsOf(".imgs img"), ["first image", ""], "grid alt text reaches the img");
  // No generated image may carry a junk attribute from a broken template.
  for (const img of page.$$("#feed img")) {
    const names = [...img.attributes].map(x => x.name);
    assert.ok(names.every(n => /^[a-z-]+$/.test(n)), `odd attribute on an image: ${names.join(", ")}`);
  }
});

test("whole mode keeps alt on the img even when it also shows a caption", async () => {
  const page = await whole({ timeline: [h.item(h.post("I", a, 10, { embed: h.embeds.images(2) }))] });
  await page.startDate(h.BASE);
  assert.deepEqual(page.$$(".imgs img").map(i => i.getAttribute("alt")), ["first image", ""]);
  assert.deepEqual(page.$$(".alt-cap").map(c => c.textContent), ["first image"]);
});

/** Makes the page believe canPlayType answers `answer` for HLS. */
const sayHls = (page, answer) => {
  page.window.HTMLMediaElement.prototype.canPlayType = function (t) {
    return t === "application/vnd.apple.mpegurl" ? answer : "";
  };
};

test('a "maybe" answer is not good enough to skip hls.js', async () => {
  // Desktop Chrome answers "maybe" for HLS and then cannot play it. Trusting
  // that answer breaks video on exactly the browsers that need hls.js, so
  // only "probably" counts as native support.
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("V", a, 10, { embed: h.embeds.video() }))] } });
  await page.startDate(h.BASE);
  sayHls(page, "maybe");
  page.$('[data-act="play"]').click();
  await h.wait(30);
  assert.equal(page.window.__hls.length, 1, "fell back to hls.js, as it must");
  assert.equal(page.$(".video video").getAttribute("src"), null, "the stream did not go to the element");
});

test("a browser that plays HLS itself never reaches for hls.js", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("V", a, 10, { embed: h.embeds.video() }))] } });
  await page.startDate(h.BASE);
  sayHls(page, "probably");
  page.$('[data-act="play"]').click();
  await h.wait(30);
  assert.equal(page.window.__hls.length, 0, "no hls.js player was built");
  const v = page.$(".video video");
  assert.equal(v.getAttribute("src"), "https://video.example/playlist.m3u8", "the stream went straight to the element");
});

test("without native HLS the page still builds an hls.js player", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("V", a, 10, { embed: h.embeds.video() }))] } });
  await page.startDate(h.BASE);
  page.$('[data-act="play"]').click();
  await h.wait(30);
  assert.equal(page.window.__hls.length, 1);
  assert.equal(page.window.__hls[0].src, "https://video.example/playlist.m3u8");
});

test("the page fetches nothing at all when it loads", async () => {
  // hls.js is fetched on demand (see ensureHls) and the typeface is embedded,
  // so opening the page makes no third-party request: no ~600KB of JavaScript
  // to parse for a reader who never watches a video, and a copy saved to disk
  // looks the same offline.
  // Read the FILE, not the loaded DOM: loadPage strips <script src> and <link>
  // so tests never touch the network, which would hide a tag that came back.
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const head = src.slice(0, src.indexOf("</head>"));
  assert.equal(head.match(/<script\s+src=/g), null, "no external script in the head");
  assert.equal(head.match(/<link\s/g), null, "no stylesheet or preconnect in the head");
  assert.equal(src.match(/fonts\.(googleapis|gstatic)\.com/g), null, "no Google Fonts reference anywhere");
});
