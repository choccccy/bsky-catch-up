"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const a = h.actor(1), b = h.actor(2);
const FEED = "at://did:plc:owner/app.bsky.feed.generator/foryou";
const LIST = "at://did:plc:owner/app.bsky.graph.list/friends";

/** A page whose account has one saved feed and one saved list. */
const withFeeds = (extra = {}) => ({
  savedFeeds: [
    { id: "1", type: "feed", value: FEED, pinned: true },
    { id: "2", type: "list", value: LIST, pinned: false },
    { id: "3", type: "timeline", value: "following", pinned: true },
  ],
  feedNames: { [FEED]: "For You", [LIST]: "Friends" },
  ...extra,
});

test("a custom feed is read instead of the timeline", async () => {
  const page = await h.loadPage({ server: withFeeds({
    timeline: [h.item(h.post("TL", a, 10))],
    feeds: { [FEED]: [h.item(h.post("F1", a, 10)), h.item(h.post("F2", b, 11))] },
  }) });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.deepEqual(page.ids(), ["F1", "F2"], "the feed's posts, not the timeline's");
  assert.ok(!page.calls.some(c => c.includes("getTimeline")), "the timeline was never asked for");
  assert.match(page.$("#feedHead").textContent, /from For You/);
});

test("a list is read through getListFeed", async () => {
  const page = await h.loadPage({ server: withFeeds({
    feeds: { [LIST]: [h.item(h.post("L1", a, 10))] },
  }) });
  await page.startDate(h.BASE, null, { feed: LIST });
  assert.deepEqual(page.ids(), ["L1"]);
  assert.ok(page.calls.some(c => c.includes("getListFeed")), "used the list endpoint");
});

test("the picker is built from the account's saved feeds, pinned first", async () => {
  const page = await h.loadPage({ server: withFeeds() });
  await h.wait(50);
  const opts = [...page.$("#inFeed").options].map(o => o.textContent);
  assert.equal(opts[0], "Following");
  assert.ok(opts.includes("★ For You"), `pinned feed listed: ${opts.join(" | ")}`);
  assert.ok(opts.includes("Friends (list)"), "lists are listed and marked");
  assert.equal(opts[opts.length - 1], "Paste a feed or list link…");
  // A "timeline" saved entry isn't a custom feed; Following is already there.
  assert.equal(opts.filter(o => o === "Following").length, 1);
});

test("a feed that runs out says so, and is never rebuilt from follows", async () => {
  const page = await h.loadPage({ server: withFeeds({
    feeds: { [FEED]: [h.item(h.post("F1", a, 40))] },   // nothing as far back as asked
  }) });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.match(page.$("#feedHead").textContent, /For You only goes back to/);
  assert.ok(!page.calls.some(c => c.includes("getAuthorFeed")), "no rebuild was attempted");
});

test("the most recent N posts are read, oldest first", async () => {
  const many = Array.from({ length: 12 }, (_, i) => h.item(h.post("P" + i, a, 10 + i)));
  const page = await h.loadPage({ server: withFeeds({ feeds: { [FEED]: many } }) });
  await page.startRecent(5, { feed: FEED });
  // The five newest (P7..P11), shown oldest first.
  assert.deepEqual(page.ids(), ["P7", "P8", "P9", "P10", "P11"]);
  assert.match(page.$("#feedHead").textContent, /The 5 most recent posts, from For You\./);
});

test("a link carries the feed and the recent count", async () => {
  const page = await h.loadPage({ server: withFeeds({ feeds: { [FEED]: [h.item(h.post("F1", a, 10))] } }) });
  await page.startRecent(3, { feed: FEED });
  const hash = page.window.location.hash;
  assert.match(hash, /recent=3/);
  assert.match(hash, new RegExp("feed=" + encodeURIComponent(FEED).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a pasted bsky.app feed link resolves to its at:// URI", async () => {
  const page = await h.loadPage({ server: withFeeds({
    handles: { "owner.bsky.social": "did:plc:owner" },
    feeds: { [FEED]: [h.item(h.post("F1", a, 10))] },
  }) });
  // Spread into this realm's objects: a value built inside jsdom has a
  // different Object prototype, which strict deepEqual counts as unequal.
  const got = await page.window.parseFeedInput("https://bsky.app/profile/owner.bsky.social/feed/foryou");
  assert.deepEqual({ ...got }, { kind: "feed", uri: FEED });
  const list = await page.window.parseFeedInput("https://bsky.app/profile/did:plc:owner/lists/friends");
  assert.deepEqual({ ...list }, { kind: "list", uri: LIST });
  await assert.rejects(() => page.window.parseFeedInput("https://example.com/nope"), /feed or list link/);
});

test("the follow list is only loaded when something needs it", async () => {
  // Replies set to "all": nothing needs the follow list on a custom feed.
  const page = await h.loadPage({
    settings: { replies: "all" },
    server: withFeeds({ feeds: { [FEED]: [h.item(h.post("F1", a, 10))] } }),
  });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.ok(!page.calls.some(c => c.includes("getFollows")), "follows were not fetched");

  // Back to the default reply rule, which does need it.
  const page2 = await h.loadPage({
    settings: { replies: "followed" },
    server: withFeeds({ feeds: { [FEED]: [h.item(h.post("F1", a, 10))] } }),
  });
  await page2.startDate(h.BASE, null, { feed: FEED });
  assert.ok(page2.calls.some(c => c.includes("getFollows")), "follows were fetched for the reply filter");
});

test("the page never writes preferences", async () => {
  const page = await h.loadPage({ server: withFeeds({ feeds: { [FEED]: [h.item(h.post("F1", a, 10))] } }) });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.ok(!page.calls.some(c => c.includes("putPreferences")), "putPreferences must never be called");
  // The page does mention it, in the comment explaining why it never calls
  // it -- so look for a call, not the word.
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  assert.equal(src.match(/xrpc\(\s*["'`]app\.bsky\.actor\.putPreferences/g), null, "no call site in the page");
});

/* ---- the start screen's shape ---- */

test("only the chosen start option explains itself", async () => {
  // Four options showing their input and their hint at once made the start
  // screen twice as tall as it needed to be. The rule is CSS-only, and jsdom
  // doesn't do the cascade, so this reads the stylesheet.
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const css = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  assert.match(css, /\.choice:not\(:has\(input:checked\)\)\s*\.choice-body:not\(#resumeDesc\)\s*\{[^}]*display\s*:\s*none/,
    "an unchosen option's body must be hidden, except the one that says what resuming means");
  // Every option must have a body for that rule to act on, and a radio to
  // open it with.
  const page = await h.loadPage({});
  for (const el of page.$$("#startForm .choice")) {
    assert.ok(el.querySelector('input[type=radio]'), "each option is chosen by a radio");
  }
});

test("the feed picker is there without an extra click", async () => {
  const page = await h.loadPage({ server: withFeeds() });
  assert.ok(page.$("#startForm .feed-pick"), "the picker sits in the form, not behind a toggle");
  assert.ok(page.$("#inFeed"), "and the select itself is there");
  assert.equal(page.$("#startForm label[for=\"inFeed\"]"), null,
    "no label row: the first option already reads Following");
});

test("a feed from a link shows up in the picker", async () => {
  const page = await h.loadPage({ server: withFeeds() });
  await h.wait(50);
  page.eval(`setFeedChoice({ kind: "feed", uri: ${JSON.stringify(FEED)}, name: "For You" })`);
  assert.equal(page.$("#inFeed").value, FEED, "the picker points at the feed");
  assert.match(page.$("#feedHint").textContent, /how much history/,
    "and warns that a custom feed may not reach back as far as you ask");
});

test("the start options read specific to broad", async () => {
  // Resume first when there is one, then narrowing down: a post you can name,
  // a time you can name, then "just give me the recent ones".
  const page = await h.loadPage({});
  assert.deepEqual(page.$$('#startForm input[name="kind"]').map(el => el.value),
    ["resume", "post", "date", "recent"]);
});

test("you can see what resuming would mean before choosing it", async () => {
  // The resume line names the post you'd land on. Collapsing it with the
  // other option bodies would make you pick resume to find out what resume
  // means, so it is exempt from the collapse rule.
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const css = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  const hides = [...css.matchAll(/([^{}]*\.choice-body[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /display\s*:\s*none/.test(body));
  assert.ok(hides.length, "something collapses the option bodies");
  for (const [, selector] of hides) {
    assert.match(selector, /:not\(#resumeDesc\)/, `${selector.trim()} must spare #resumeDesc`);
  }
});
