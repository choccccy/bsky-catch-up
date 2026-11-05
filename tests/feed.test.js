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
  // the did's colons must stay literal: bsky.app can't load profile/did%3Aplc%3A…
  assert.ok(b.did.includes(":"), "fixture did needs colons for this to mean anything");
  assert.deepEqual(links, [`https://bsky.app/profile/${b.did}`, "https://bsky.app/hashtag/tag"]);
});

test("a post link falls back to the did in the uri when the author is missing", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10))] } });
  await page.startDate(h.BASE);
  const url = page.window.postUrl({ uri: "at://did:plc:u8/app.bsky.feed.post/X" });
  // bsky.app answers profile/undefined with "Unable to fulfill XRPC request".
  assert.equal(url, "https://bsky.app/profile/did:plc:u8/post/X");
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

test("the reposter's name links to their profile", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", h.actor(8), 10), { repostBy: b, repostMin: 20 })] } });
  await page.startDate(h.BASE);
  const link = page.article("A").querySelector(".post-meta-line a");
  assert.ok(link, "the reposter's name is a link");
  assert.equal(link.textContent, "User 2");
  assert.equal(link.getAttribute("href"), "https://bsky.app/profile/u2.test");
});

test("only the avatar itself links to the profile, not the space beside it", async () => {
  // Regression test for 0.8.2, when the link stretched down the avatar's
  // whole column. The column is gone -- the avatar sits in the post's top
  // bar now -- but a stretching item in that bar would be the same bug, a
  // link taller than the face inside it. jsdom does no layout, so check the
  // styles that prevent it. The height is compared against the avatar's own
  // rather than against a number: both read it from --av, and that they
  // AGREE is the actual invariant. jsdom doesn't resolve custom properties,
  // so a literal here would only ever have been testing what the token is
  // spelled.
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10))] } });
  await page.startDate(h.BASE);
  const post = page.article("A");
  const link = post.querySelector(":scope > .pv > .avatar-link");
  assert.ok(link, "avatar wrapped in .avatar-link");
  const cs = page.window.getComputedStyle(link);
  assert.notEqual(cs.alignSelf, "stretch", "the link must not be stretched by its row");
  const avatarH = page.window.getComputedStyle(post.querySelector(".avatar")).height;
  assert.ok(avatarH && avatarH !== "auto", "the avatar is given a height of its own");
  assert.equal(cs.height, avatarH, "the link is pinned to the avatar's height, not stretched");
});

const cssOf = () => {
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  return src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
};

test("a post is a top bar and a body that spans the card", async () => {
  // The avatar used to hold open a column down the post's whole height and
  // everything else was squeezed into what was left, which cost the text 50px
  // of measure and left the space under the avatar empty. The identity line
  // now sits in a top bar beside the avatar, and the body spans both of .pv's
  // columns. Two halves to the invariant, and each can break alone:
  //   the MARKUP has to put .pv-head outside .pv-body (otherwise the bar is
  //   back inside the indented column), and the CSS has to let .pv-body cross
  //   the avatar's track (otherwise it is indented whatever the markup says).
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10))] } });
  await page.startDate(h.BASE);
  const pv = page.article("A").querySelector(":scope > .pv:last-child");
  assert.ok(pv.querySelector(":scope > .pv-head"), "the name/handle/time line is in the top bar, not the body");
  assert.ok(pv.querySelector(":scope > .pv-body > .pv-text"), "the text is in the body");
  // jsdom does no layout, so the span itself is read out of the stylesheet.
  const css = cssOf().replace(/\/\*[\s\S]*?\*\//g, "");
  const areas = /\.pv\s*\{[^}]*grid-template-areas:([^;}]+)/.exec(css);
  assert.ok(areas, ".pv lays its parts out with named grid areas");
  const rows = [...areas[1].matchAll(/"([^"]+)"/g)].map(m => m[1].trim().split(/\s+/));
  const bodyRow = rows.find(cells => cells.includes("body"));
  assert.ok(bodyRow, "one row of the grid is the body");
  assert.deepEqual(bodyRow, bodyRow.map(() => "body"),
    "the body must own every column of its row, or it is indented under the avatar again");
});

test("the thread line runs beside the text, not through it", async () => {
  // It used to run down the middle of the avatar's column, which was empty.
  // With the body spanning the card that column is text, so the line moved
  // out into the card's side padding -- i.e. to a NEGATIVE offset from the
  // content box. Every --rail-x there is has to stay negative (the narrow
  // block sets its own, because the padding is smaller there), and the rules
  // that draw a rail have to read it rather than carry their own number.
  const css = cssOf().replace(/\/\*[\s\S]*?\*\//g, "");
  const values = [...css.matchAll(/--rail-x\s*:\s*([^;}]+)/g)].map(m => m[1].trim());
  assert.ok(values.length, "the rail's offset is a variable");
  for (const v of values)
    assert.match(v, /^-/, `--rail-x: ${v} would put the thread line over the post's text`);
  const rails = [...css.matchAll(/\.pv-body::(?:after|before)\s*\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(rails.length, "a thread rail is drawn on .pv-body");
  for (const decls of rails)
    assert.match(decls, /left\s*:\s*var\(--rail-x\)/,
      "a rail that hard-codes its offset will drift from the padding it hides in");
});

/* On a narrow screen the top bar's buttons go icon-only, and they do it in
   CSS: the words stay in the markup and are hidden from the eye alone. The
   tempting "simplification" is to delete them once there's an icon, which
   silently leaves three buttons with no accessible name at any width. jsdom
   does no layout and so can't see the breakpoint, but it can hold onto the
   part that matters at every width -- that the words are still there. */
test("the top bar's buttons keep their words, however they are drawn", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10))] } });
  await page.startDate(h.BASE);
  for (const [id, words] of [["btnNew", "New catch-up"], ["btnSettings", "Settings"], ["btnSignOut", "Sign out"]]) {
    const btn = page.$("#" + id);
    assert.equal(btn.textContent.trim(), words, `#${id} still says "${words}"`);
    const label = btn.querySelector(".btn-label");
    assert.ok(label, `#${id}'s words are in a .btn-label, which is only ever hidden visually`);
    assert.equal(page.window.getComputedStyle(label).display !== "none", true, `#${id}'s label is not display:none`);
    assert.ok(btn.querySelector(".btn-icon svg"), `#${id} has an icon for the narrow layout`);
  }
});
