"use strict";
/*
 * Tiled layout ("Tile posts side by side", settings.tile).
 *
 * jsdom does no layout, so nothing here can check how it LOOKS (column
 * counts, row spans, where a post ends up on screen) -- that's a browser
 * job. What these tests hold onto is the structure tiling depends on, and
 * above all that one column is untouched by it.
 *
 * tileCols() falls back to window.innerWidth (1024 in jsdom) when nothing
 * lays out, so a 480px column width means two columns and a 960px one
 * means one. TILED/NARROW below are the two.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const TILED = { tile: true, tileMax: 4, columnWidth: 480 };
const NARROW = { tile: true, columnWidth: 960 };

const a = h.actor(1), b = h.actor(2);
/* Two days, several hours, a reply right after its post (which fuses into a
   chain), and a post with pictures. */
const DAY = 24 * 60;
const parent = h.post("P", a, -DAY - 120);
const feed = [
  h.item(h.post("OLD", a, -DAY - 180)),
  h.item(parent),
  h.item(h.post("R", b, -DAY - 119, { replyTo: parent }), { parent }),
  h.item(h.post("PIC", a, -60, { embed: h.embeds.images(2) })),
  h.item(h.post("NEW", b, -5)),
];
const server = { timeline: feed };
const start = h.BASE - (DAY + 240) * h.MIN;

/** The feed's shape, divider labels aside: what each band holds. */
const shape = page => page.$$("#feed > *").map(el =>
  el.classList.contains("band")
    ? [...el.children].map(c => c.classList.contains("tile")
        ? "tile:" + [...c.children].map(p => p.querySelector(":scope > .pv:last-child .pv-text").textContent.replace(/^post /, "")).join("+")
        : c.className.split(" ")[0])
    : el.className.split(" ")[0] || "post");

test("tiled: every post sits in a tile inside a band", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  assert.deepEqual(page.ids(), ["OLD", "P", "R", "PIC", "NEW"], "the same posts, in the same order");
  assert.equal(page.$$("#feed > .post").length, 0, "no post is a direct child of the feed");
  assert.ok(page.$$("#feed > .band").length >= 2, "the feed is built from bands");
  for (const post of page.$$("#feed .post")) {
    assert.ok(post.parentElement.classList.contains("tile"), "post is in a tile");
    assert.ok(post.parentElement.parentElement.classList.contains("band"), "tile is in a band");
  }
  // The grid can't work out a masonry row span by itself, so every item in a
  // band carries one, and is watched for the height changes that come later
  // (pictures arriving, a thread expanded in place, a change of text size).
  const items = page.$$("#feed > .band > *");
  const watched = page.resizeObservers.flatMap(o => o.targets);
  for (const el of items) {
    assert.match(el.style.gridRow, /^span \d+$/, `${el.className} has a row span`);
    assert.ok(watched.includes(el), `${el.className} is watched for height changes`);
  }
});

test("tiled: a divider is full width in a band of its own posts", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const bands = page.$$("#feed > .band");
  for (const band of bands) {
    const kids = [...band.children];
    const dividers = kids.filter(k => k.classList.contains("day") || k.classList.contains("hour"));
    assert.deepEqual(dividers, kids.slice(0, dividers.length), "dividers come first in their band");
    for (const d of dividers) assert.ok(!d.closest(".tile"), "a divider is never inside a tile");
  }
  // Each band after the first was opened by a divider, so no band but
  // possibly the first can be dividerless, and none holds two groups.
  for (const [i, band] of bands.entries()) {
    const kids = [...band.children];
    const starts = kids.filter(k => k.classList.contains("day")).length;
    assert.ok(starts <= 1, "a band holds at most one day divider");
    if (i > 0) assert.ok(kids[0].classList.contains("day") || kids[0].classList.contains("hour"), "every later band starts with a divider");
  }
  // One tile per post, less the ones fused onto the post above them. (Which
  // posts fuse depends on where the hour dividers fall, so count them.)
  assert.equal(page.$$("#feed .tile").length, page.$$("#feed .post").length - page.$$("#feed .post.joined").length,
    "every post has a tile, except those fused into the one above");
});

test("tiled: posts stay in time order, and a fused reply stays in one tile", async () => {
  const page = await h.loadPage({ settings: { ...TILED, hourDividers: false, dayDividers: false }, server });
  await page.startDate(start);
  assert.deepEqual(shape(page), [["tile:OLD", "tile:P+R", "tile:PIC", "tile:NEW"]],
    "no dividers means one band; the reply is fused into its parent's tile");
  const chain = page.article("R").parentElement;
  assert.ok(page.article("P").parentElement === chain, "both halves of the chain are in the same grid item");
  assert.ok(page.article("P").classList.contains("has-next") && page.article("R").classList.contains("joined"));
});

test("tiled: a post with media is marked as a two-column tile", async () => {
  // Only whole-image mode lets a post with pictures be wider than the
  // column, and only then does a tile ask for two of them.
  const page = await h.loadPage({ settings: { ...TILED, wholeImages: "whole", mediaWidth: 1.5 }, server });
  await page.startDate(start);
  assert.ok(page.article("PIC").classList.contains("has-media"));
  assert.ok(page.article("PIC").parentElement.classList.contains("wide"), "its tile may span two columns");
  assert.ok(!page.article("NEW").parentElement.classList.contains("wide"), "a text post may not");
  assert.equal(page.document.documentElement.hasAttribute("data-tile-wide"), true, "and the CSS for it is switched on");
});

test("one column is left exactly as it was: no bands, no tiles, no root flag", async () => {
  const off = await h.loadPage({ settings: { columnWidth: 480 }, server });
  await off.startDate(start);
  const flat = off.$$("#feed > *").map(el => el.className.split(" ")[0] || "post");
  assert.ok(flat.length && !flat.includes("band"), "setting off: flat feed");

  // Setting ON, but the window only fits one column: still the untiled page.
  const narrow = await h.loadPage({ settings: NARROW, server });
  await narrow.startDate(start);
  assert.equal(narrow.eval("settings.tile"), true, "the setting is on");
  assert.equal(narrow.eval("tileCols()"), 1);
  assert.equal(narrow.eval("tileOn()"), false, "but tiling is not in force");
  assert.deepEqual(narrow.$$("#feed > *").map(el => el.className.split(" ")[0] || "post"), flat,
    "the markup is the same as with the setting off");
  assert.equal(narrow.$$("#feed .tile").length + narrow.$$("#feed .band").length, 0);
  assert.equal(narrow.document.documentElement.hasAttribute("data-tile"), false, "no data-tile, so none of the tiled CSS applies");
  assert.deepEqual(narrow.ids(), off.ids());
});

test("turning tiling on and off rebuilds the feed in place", async () => {
  const page = await h.loadPage({ settings: { columnWidth: 480 }, server });
  await page.startDate(start);
  const before = page.ids();

  await page.setSetting("tile", true);
  assert.equal(page.document.documentElement.hasAttribute("data-tile"), true);
  assert.ok(page.$$("#feed > .band").length >= 2, "rebuilt into bands");
  assert.deepEqual(page.ids(), before, "the same posts in the same order");

  await page.setSetting("tile", false);
  assert.equal(page.document.documentElement.hasAttribute("data-tile"), false);
  assert.equal(page.$$("#feed .band").length, 0, "rebuilt flat");
  assert.deepEqual(page.ids(), before);
});

test("a column width that no longer fits twice rebuilds the feed untiled", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  assert.ok(page.$$("#feed > .band").length >= 1, "tiled to begin with");
  await page.setSetting("columnWidth", 960);
  assert.equal(page.eval("tileOn()"), false);
  assert.equal(page.$$("#feed .band").length, 0, "back to the untiled markup");
  assert.deepEqual(page.ids(), ["OLD", "P", "R", "PIC", "NEW"]);
});

test("tiling is shareable in a link, and the cap with it", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  assert.equal(page.eval('linkable(SETTINGS_SCHEMA.find(s => s.key === "tile"))'), true);
  assert.equal(page.eval('linkable(SETTINGS_SCHEMA.find(s => s.key === "tileMax"))'), true);
  assert.equal(page.eval('paramToSetting(SETTINGS_SCHEMA.find(s => s.key === "tileMax"), "9")'), 6, "the cap is clamped to the range");
});

/* ---- keeping your place when the columns change ----
   jsdom lays nothing out, so every rectangle is empty and topVisiblePost()
   finds nothing; these set the reading spot the scroll handler would have
   recorded and then watch how far the page scrolls itself to restore it. */
const readingAt = (page, n) => page.eval(`(() => { state.clockKey = state.view[${n}].key; state.clockTop = 120; return state.clockKey; })()`);

test("more columns: the post you were reading goes back where it was", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const key = readingAt(page, 2);
  const tile = page.$(`#feed [data-key="${key}"]`).parentElement;
  page.scrolls.length = 0;

  await page.resizeTo(1600);                       // 480px columns: 2 -> 3
  assert.equal(page.eval("tileCols()"), 3);
  assert.equal(page.eval("tileOn()"), true, "still tiled, so nothing is rebuilt");
  assert.ok(tile.isConnected, "the same tiles are still in the page");
  assert.ok(page.scrolls.length, "the page scrolled itself to keep the spot");
  // Rectangles are all zero here, so putting the post's top edge back at 120
  // is a scroll of 0 - 120.
  assert.deepEqual(page.scrolls[0], [0, -120]);
  assert.equal(page.eval("state.clockKey"), key, "and it's still the post being read");
});

test("a resize that leaves the columns alone doesn't move the page", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  readingAt(page, 2);
  page.scrolls.length = 0;
  await page.resizeTo(1100);                       // still two columns
  assert.equal(page.eval("tileCols()"), 2);
  assert.deepEqual(page.scrolls, [], "nothing to put back");
});

test("a resize down to one column rebuilds the feed and keeps the spot", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const key = readingAt(page, 2);
  page.scrolls.length = 0;

  await page.resizeTo(700);                        // one 480px column fits
  assert.equal(page.eval("tileOn()"), false);
  assert.equal(page.$$("#feed .band").length, 0, "rebuilt with the untiled markup");
  assert.deepEqual(page.ids(), ["OLD", "P", "R", "PIC", "NEW"], "and the same posts");
  assert.ok(page.scrolls.length, "the rebuild scrolled back to the post being read");
  assert.ok(page.$(`#feed [data-key="${key}"]`), "which is still in the feed");

  await page.resizeTo(1600);                       // and back up to three
  assert.equal(page.eval("tileOn()"), true);
  assert.ok(page.$$("#feed > .band").length >= 2, "tiled again");
  assert.deepEqual(page.ids(), ["OLD", "P", "R", "PIC", "NEW"]);
});

test("a column width that changes the count keeps the spot too", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  await page.resizeTo(1600);                       // three 480px columns
  const key = readingAt(page, 2);
  const tile = page.$(`#feed [data-key="${key}"]`).parentElement;
  page.scrolls.length = 0;

  await page.setSetting("columnWidth", 520);       // still tiled, but two columns
  assert.equal(page.eval("tileCols()"), 2);
  assert.ok(tile.isConnected, "nothing was rebuilt: the posts only moved");
  assert.deepEqual(page.scrolls[0], [0, -120], "and the one being read went back where it was");
});

test("a column width that turns tiling off rebuilds, keeping the spot", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const key = readingAt(page, 2);
  page.scrolls.length = 0;
  await page.setSetting("columnWidth", 540);       // 1024px wide: no second column
  assert.equal(page.eval("tileOn()"), false);
  assert.equal(page.$$("#feed .band").length, 0, "rebuilt untiled");
  assert.ok(page.scrolls.length, "and scrolled back to the post being read");
  assert.ok(page.$(`#feed [data-key="${key}"]`));
});

test("the scroll handler is what records the reading spot", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  // jsdom lays nothing out, so give the posts a column of fake geometry:
  // 100px apart, with the third straddling the top of the screen.
  const tops = page.json(`(() => {
    const posts = [...document.querySelectorAll("#feed .post")];
    posts.forEach((el, i) => { const top = i * 100 - 250;
      el.getBoundingClientRect = () => ({ top, bottom: top + 90, left: 0, right: 100, width: 100, height: 90, x: 0, y: top }); });
    return posts.map(el => el.getBoundingClientRect().top);
  })()`);
  assert.deepEqual(tops.slice(0, 3), [-250, -150, -50]);

  page.window.dispatchEvent(new page.window.Event("scroll"));
  await h.wait(60);
  const spot = page.json("readingSpot()");
  assert.equal(spot.key, page.eval("state.view[2].key"), "the post straddling the top of the screen");
  assert.equal(spot.offset, -50, "and where its top edge was");
});

/* ---- the width cap and the column count have to agree ----
   The CSS caps the feed at --tile-width and lets auto-fill divide that up;
   tileCols() decides, from the same numbers, how many columns that is. If
   the cap is even a pixel short of the count, auto-fill lays out one column
   fewer than the setting asks for -- which is what "Most columns: 2" did in
   1.1.0, where the cap counted a gap after the last column and forgot the
   page's padding. */
test("the width cap fits exactly as many columns as the count promises", async () => {
  const page = await h.loadPage({ settings: { tile: true, columnWidth: 640 } });
  for (const [max, width] of [[2, 1320], [3, 1976], [4, 2632], [6, 3944]]) {
    page.eval(`settings.tileMax = ${max}`);
    assert.equal(page.eval("tileWidth()"), width, `cap for ${max} columns`);
    // At exactly the cap, that many columns fit; one pixel less and they don't.
    await page.resizeTo(width);
    assert.equal(page.eval("tileCols()"), max, `${width}px fits ${max} columns`);
    await page.resizeTo(width - 1);
    assert.equal(page.eval("tileCols()"), max - 1, `${width - 1}px fits one fewer`);
  }
});

test("two columns is the default, and two columns is what you get", async () => {
  const page = await h.loadPage({ settings: { tile: true }, server });   // tileMax untouched
  assert.equal(page.eval("settings.tileMax"), 2, "the default cap");
  await page.resizeTo(page.eval("tileWidth()"));      // a window exactly wide enough
  await page.startDate(start);
  assert.equal(page.eval("tileCols()"), 2);
  assert.equal(page.eval("tileOn()"), true, "so the feed really does tile");
  assert.ok(page.$$("#feed > .band").length >= 1);
});

test("the cap the CSS uses is the one the count was worked out from", async () => {
  const page = await h.loadPage({ settings: { tile: true, tileMax: 3, columnWidth: 500 } });
  await page.resizeTo(3000);
  assert.equal(page.eval("tileCols()"), 3);
  assert.equal(page.document.documentElement.style.getPropertyValue("--tile-width"), page.eval("tileWidth()") + "px");
});

test("a 1.1.0 link still shows what its author saw", async () => {
  // Links carry only non-default settings, so one made by 1.1.0 with tiling
  // on says nothing about a cap of 4 -- the format number has to fill it in.
  const page = await h.loadPage({ url: "https://example.test/#recent=50&v=2&s.tile=1" });
  assert.equal(page.eval("settings.tile"), true);
  assert.equal(page.eval("settings.tileMax"), 4, "1.1.0's default, not today's");
  const now = await h.loadPage({ url: "https://example.test/#recent=50&v=3&s.tile=1" });
  assert.equal(now.eval("settings.tileMax"), 2, "a link from this version uses today's");
});

test("only the feed is allowed the tiled width", async () => {
  // main holds the start screen as well, so the width cap is scoped to the
  // screen that's up (data-view, set by show()).
  const page = await h.loadPage({ settings: TILED, server });
  const root = page.document.documentElement;
  assert.equal(root.dataset.view, "start", "the start screen is up at first");
  await page.startDate(start);
  assert.equal(root.dataset.view, "feed", "and the feed once it's loaded");
  page.$("#btnNew").click();
  assert.equal(root.dataset.view, "start", "and back again for a new catch-up");

  const css = require("node:fs").readFileSync(h.PAGE_PATH, "utf8");
  const widened = css.match(/^:root\[data-tile\][^\n]*main[\s\S]*?\}/m)[0];
  assert.match(widened, /data-view="feed"/, "the cap only applies on the feed");
  assert.ok(!/\[data-tile\][^\n]*\.bar-inner/.test(css), "and the top bar is not widened at all");
});

test("the start post breaks the band and takes a row of its own while tiled", async () => {
  // The band is a .bleed, which reaches the viewport edges by measuring out
  // from its own centre -- right only for a box that is itself centred. A
  // divider is (it spans the whole row); an anchor sharing a row with other
  // posts is not, so its band painted across the window and, because .bleed
  // isolates its own stacking context, OVER the column beside it. 1.1.2
  // scoped the band back to the column; 1.1.7 gives the anchor the whole row
  // instead, which is the same rule the dividers already follow.
  const timeline = Array.from({ length: 30 }, (_, i) => h.item(h.post("P" + i, a, 10 + i)));
  const page = await h.loadPage({ settings: TILED, server: { timeline } });
  await page.startPost("https://bsky.app/profile/u1.test/post/P20");

  const anchor = page.article("P20");
  assert.ok(anchor.classList.contains("bleed"), "the start post still carries the band");
  const tile = anchor.closest(".tile");
  assert.ok(tile.classList.contains("full"), "its tile spans the whole row");
  assert.equal(tile.parentElement.children.length, 1, "and nothing else is in that band");

  // The posts either side are in bands of their own, so the grid can't put
  // anything beside the anchor.
  const bandOf = el => el.closest(".band");
  const before = page.article("P19"), after = page.article("P21");
  assert.notEqual(bandOf(before), bandOf(anchor), "the post above is in another band");
  assert.notEqual(bandOf(after), bandOf(anchor), "and so is the post below");
  assert.ok(!after.closest(".tile").classList.contains("full"), "which is an ordinary tile again");

  const css = require("node:fs").readFileSync(h.PAGE_PATH, "utf8");
  const full = css.match(/^:root\[data-tile\]\s*\.tile\.full\s*\{[^}]*\}/m);
  assert.ok(full, "a full tile must be given the whole row");
  assert.match(full[0], /grid-column:\s*1\s*\/\s*-1/, "grid-column:1/-1, like a divider");
  assert.ok(!/\.tile\s+\.post\.anchor::before/.test(css),
    "and the band is no longer scoped back to a column, which would now be wrong");
});

test("untiled, nothing is given a full row", async () => {
  const timeline = Array.from({ length: 30 }, (_, i) => h.item(h.post("P" + i, a, 10 + i)));
  const page = await h.loadPage({ settings: { ...TILED, tile: false }, server: { timeline } });
  await page.startPost("https://bsky.app/profile/u1.test/post/P20");
  assert.equal(page.$$("#feed .tile").length, 0, "no tiles at all");
  assert.equal(page.$$("#feed .full").length, 0, "and nothing claiming a row");
});

test("a junk column cap falls back to the default, not to a number written twice", async () => {
  // 1.1.0 shipped "Most columns" at 4 and 1.1.1 changed it to 2, but two
  // `Number(settings.tileMax) || 4` fallbacks were left behind. Both now read
  // DEFAULTS, so the default can only ever be stated in one place.
  const page = await h.loadPage({ settings: TILED, server });
  assert.equal(page.eval("DEFAULTS.tileMax"), 2, "the default this test is about");
  // 2 columns of 480 + one 16px gap + main's 24px of padding.
  assert.equal(page.eval("settings.tileMax = 0; tileWidth()"), 2 * 480 + 16 + 24,
    "an unusable value falls back to DEFAULTS.tileMax, not to a stale literal");
  assert.equal(page.eval("tileCols()"), 2, "and the column count agrees with it");
});

test("a divider's row span covers its margins, not just its box", async () => {
  // Tiles have no margin of their own (flow-root keeps the post's inside), but
  // the day and hour dividers do. Measuring only offsetHeight made their band
  // too short to hold them, so a divider painted over the foot of the posts
  // above it and the head of the posts below -- the overlap you can see in a
  // tiled feed with hour dividers on. jsdom does no layout, so this drives
  // setSpan directly with a known height.
  const page = await h.loadPage({ settings: TILED, server });
  const span = page.eval(`(() => {
    const el = document.createElement("div");
    el.style.marginTop = "18px"; el.style.marginBottom = "8px";
    Object.defineProperty(el, "offsetHeight", { value: 100 });
    document.body.append(el);
    setSpan(el);
    const got = el.style.gridRow;
    el.remove();
    return got;
  })()`);
  // (100 + 18 + 8) / 2px rows = 63, not the 50 the border box alone gives.
  assert.equal(span, "span 63", "the margins have to be in the span");
});

test("the tiled metrics are handed to the CSS, not written out twice", async () => {
  // tileCols/tileWidth/setSpan all do arithmetic with these, and a second
  // copy in the stylesheet is how "Most columns" came to disagree with itself
  // in 1.1.0. applyLook pushes them, so there is one source for each.
  const page = await h.loadPage({ settings: TILED, server });
  const root = page.document.documentElement;
  assert.equal(root.style.getPropertyValue("--tile-gap"), page.eval("TILE_GAP") + "px");
  assert.equal(root.style.getPropertyValue("--tile-row"), page.eval("TILE_ROW") + "px");
  assert.equal(root.style.getPropertyValue("--tile-width"), page.eval("tileWidth()") + "px");

  const css = require("node:fs").readFileSync(h.PAGE_PATH, "utf8");
  const band = css.match(/:root\[data-tile\] \.band\{[\s\S]*?\}/)[0];
  assert.match(band, /grid-auto-rows:var\(--tile-row/, "the band reads the row height");
  assert.match(band, /column-gap:var\(--tile-gap/, "and the gap");
});

/* A span that is too SHORT is the visible failure: the item is painted
   outside the rows it was given, over the posts beside and below it and over
   the next band's hour banner. The ResizeObserver only speaks when an item's
   box changes size, and only after the fact, so a span left short stays short
   until the item happens to resize again -- which it may never do. These
   cover the two passes that put it right anyway. jsdom does no layout, so
   each forces a known offsetHeight and then does the thing that should
   trigger a re-measure. */
const tallest = page => {
  const el = page.$$("#feed > .band > .tile")[0];
  Object.defineProperty(el, "offsetHeight", { value: 1000, configurable: true });
  return el;
};

test("scrolling puts right a span that has gone short", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const el = tallest(page);
  assert.notEqual(el.style.gridRow, "span 500", "the span is stale to begin with");
  page.window.dispatchEvent(new page.window.Event("scroll"));
  await h.wait(80);                 // the handler is throttled to a frame
  assert.equal(el.style.gridRow, "span 500", "the sweep covers the item's real height");
});

test("a picture landing late puts right its own tile", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const el = tallest(page);
  const img = el.querySelector("img") || el.appendChild(page.document.createElement("img"));
  // Media load events don't bubble; the page listens in the capture phase.
  img.dispatchEvent(new page.window.Event("load"));
  assert.equal(el.style.gridRow, "span 500", "the tile is measured again when its picture arrives");
});

test("a span that is already long enough is left alone", async () => {
  // Re-measuring on every scroll frame must not fight the observer: only a
  // SHORT span is a fault, a long one is a gap nobody sees.
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const el = page.$$("#feed > .band > .tile")[0];
  el.style.gridRow = "span 999";
  page.window.dispatchEvent(new page.window.Event("scroll"));
  await h.wait(80);
  assert.equal(el.style.gridRow, "span 999", "a generous span stays");
});

test("one column never sweeps", async () => {
  // Everything tiling touches has to be inert when only one column fits.
  const page = await h.loadPage({ settings: NARROW, server });
  await page.startDate(start);
  const el = page.$$("#feed .post")[0];
  el.style.gridRow = "span 1";
  Object.defineProperty(el, "offsetHeight", { value: 1000, configurable: true });
  page.window.dispatchEvent(new page.window.Event("scroll"));
  await h.wait(80);
  assert.equal(el.style.gridRow, "span 1", "untiled, nothing measures anything");
});

test("when the scrolling stops, the whole feed is checked", async () => {
  // The per-frame sweep is rationed to what is near the screen. An item that
  // grew while it was further away than that would keep a short span until
  // the reader came back to it -- and its band would stay too short, which
  // moves everything below. A moment after the scrolling stops, every item
  // in the feed is compared with its own height instead.
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const items = page.$$("#feed > .band > *");
  const far = items[items.length - 1];
  Object.defineProperty(far, "offsetHeight", { value: 1000, configurable: true });
  far.style.gridRow = "span 1";
  // Out of the near-the-screen sweep's reach: well above the window, the way
  // a post you scrolled past an hour ago is. (jsdom lays nothing out, so say
  // so directly rather than pretending to scroll.) Above rather than below,
  // because an item below its own band is overflow, which fitBand would
  // rightly act on.
  far.getBoundingClientRect = () => ({ top: -99999, bottom: -99000, left: 0, right: 100, width: 100, height: 999 });
  page.window.dispatchEvent(new page.window.Event("scroll"));
  await h.wait(80);
  assert.equal(far.style.gridRow, "span 1", "the per-frame sweep leaves what it can't see");
  await h.wait(500);   // the settle sweep is debounced
  assert.equal(far.style.gridRow, "span 500", "the settle sweep covers it anyway");
});

/* A grid can only have so many lines: Gecko stops at 10,000, so a band of
   2px rows cannot be taller than about 20,000px, and a busy hour of posts
   with pictures goes past that. Every further tile is then pinned to the
   last line and painted below the band, over the column beside it and over
   the next hour banner -- with every span perfectly correct, which is why
   it survived three rounds of fixing the spans. Measured in Firefox: two
   bands reading exactly 19998px with posts hanging out of the bottom.
   jsdom lays nothing out, so these stage the geometry directly. */
const rects = (el, top, bottom) => {
  el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top });
};

test("a band whose posts fall out of the bottom is given taller rows", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const band = page.$("#feed > .band");
  const tile = band.querySelector(".tile");
  rects(band, 0, 1000);
  // Past the bottom of its band until the band is re-rowed, then inside it.
  Object.defineProperty(tile, "offsetHeight", { value: 1000, configurable: true });
  tile.getBoundingClientRect = () => ({ top: 0, bottom: band.dataset.row ? 1000 : 1500, left: 0, right: 100, width: 100, height: 1000 });
  page.window.dispatchEvent(new page.window.Event("scroll"));
  await h.wait(80);
  assert.equal(band.dataset.row, "4", "the row height is doubled");
  assert.equal(band.style.getPropertyValue("--tile-row"), "4px", "and handed to the CSS");
  assert.equal(tile.style.gridRow, "span 250", "spans are re-counted in the new rows (1000 / 4px)");
});

test("a band that fits is left on the ordinary rows", async () => {
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const band = page.$("#feed > .band");
  page.window.dispatchEvent(new page.window.Event("scroll"));
  await h.wait(80);
  assert.equal(band.dataset.row, undefined, "nothing is coarsened without cause");
});

test("re-rowing a band stops rather than doubling for ever", async () => {
  // An overflow this can't cure (something else entirely) must not spin.
  const page = await h.loadPage({ settings: TILED, server });
  await page.startDate(start);
  const band = page.$("#feed > .band");
  const tile = band.querySelector(".tile");
  rects(band, 0, 1000);
  rects(tile, 0, 9999);
  Object.defineProperty(tile, "offsetHeight", { value: 1000, configurable: true });
  page.window.dispatchEvent(new page.window.Event("scroll"));
  await h.wait(80);
  assert.equal(band.dataset.row, "64", "it gives up at the biggest row it will use");
});

test("a batch that overflows its band is re-rowed as it lands", async () => {
  // Not only on scroll: a batch is 150 posts by default, which can take a
  // band past the line limit on its own, before anyone has scrolled.
  const many = { timeline: Array.from({ length: 60 }, (_, i) => h.item(h.post("B" + i, a, -600 + i))) };
  const page = await h.loadPage({ settings: { ...TILED, batchSize: 25 }, server: many });
  await page.startDate(h.BASE - 700 * h.MIN);
  // Stage the geometry the engine would produce with a band out of lines:
  // tiles painted below the band that holds them, until it is re-rowed.
  const real = page.window.Element.prototype.getBoundingClientRect;
  page.window.Element.prototype.getBoundingClientRect = function () {
    const box = (top, bottom) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top });
    if (this.classList?.contains("band")) return box(0, 1000);
    if (this.classList?.contains("tile")) return box(0, this.closest(".band")?.dataset.row ? 1000 : 1500);
    return real.call(this);
  };
  const band = page.$("#feed > .band");
  assert.equal(band.dataset.row, undefined, "nothing is coarsened before the batch lands");
  page.eval("renderMore()");
  assert.equal(band.dataset.row, "4", "the new batch's band is re-rowed without waiting for a scroll");
});
