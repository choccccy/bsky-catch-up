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
  assert.match(css, /\.choice:not\(:has\(input:checked\)\)\s*\.choice-body:not\(\.always\)\s*\{[^}]*display\s*:\s*none/,
    "an unchosen option's body must be hidden, unless it's marked .always");
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
    ["resume", "like", "post", "date", "recent"]);
});

test("you can see what the two resume-ish options would do before choosing", async () => {
  // One names the post you'd land on, the other says where the like is kept.
  // Collapsing those would make you pick an option to find out what it means.
  const page = await h.loadPage({});
  const always = page.$$("#startForm .choice-body.always");
  assert.equal(always.length, 2, "both of them stay open");
  assert.deepEqual(always.map(el => el.closest(".choice").querySelector("input").value),
    ["resume", "like"]);
  // They earn the room by being short: a paragraph here makes the row tall.
  for (const el of always) {
    const words = el.textContent.trim().split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 20, `always-visible blurbs stay to a line or two, got ${words} words: ${el.textContent}`);
  }
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const css = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  const hides = [...css.matchAll(/([^{}]*\.choice-body[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /display\s*:\s*none/.test(body));
  assert.ok(hides.length, "something collapses the option bodies");
  for (const [, selector] of hides) {
    assert.match(selector, /:not\(\.always\)/, `${selector.trim()} must spare .always`);
  }
});

/* ---- starting from the last post you liked ---- */

test("the last post you liked is where the catch-up starts", async () => {
  const posts = [h.post("OLD", a, 100), h.post("LIKED", b, 60), h.post("AFTER", a, 20)];
  const page = await h.loadPage({ server: {
    timeline: posts.map(h.item),
    likes: [posts[1].uri],            // newest like first
  } });
  await page.start("like");
  assert.ok(page.article("LIKED").classList.contains("anchor"),
    `the liked post is the one you're put at: ${page.ids().join(",")}`);
  assert.ok(page.ids().includes("AFTER"), "and it carries on to what came after it");
  // "OLD" is above it on purpose: a post start shows a few earlier posts for
  // context, which is exactly what you want when picking up where you left off.
});

test("only the newest like is asked for", async () => {
  // listRecords orders by record key descending by default, so the first
  // record is the most recent like: asking for one is enough, and asking for
  // more would be a bigger response for nothing.
  const posts = [h.post("NEW", a, 30), h.post("OLDER", b, 90)];
  const server = { timeline: posts.map(h.item), likes: [posts[0].uri, posts[1].uri] };
  const page = await h.loadPage({ server });
  await page.start("like");
  const q = (server.listRecordsQueries || []).join(" ");
  assert.ok(q, "the page read its own likes");
  assert.match(q, /limit=1/, "one record is all it needs");
  assert.ok(!/reverse=true/.test(q), "and it must not reverse: that would fetch the oldest like");
  assert.ok(page.article("NEW").classList.contains("anchor"),
    "started at the newest like, not the first one ever");
});

test("a like start writes a link that names the post, not the like", async () => {
  // "wherever I last left a like" would mean something different for every
  // person who opened the link, and would change under its own author the
  // moment they liked something else.
  // The id deliberately contains no "like": the point is that the word is
  // absent from the link, so it mustn't be smuggled in by the post's name.
  const liked = h.post("TARGET", b, 60);
  const page = await h.loadPage({ server: { timeline: [h.item(liked), h.item(h.post("AFTER", a, 20))], likes: [liked.uri] } });
  await page.start("like");
  const hash = page.window.location.hash;
  assert.ok(!/like/i.test(hash), `the link shouldn't mention likes: ${hash}`);
  assert.match(hash, /from=[^&]*\/post\/TARGET/, `it names the post itself: ${hash}`);
});

test("liking nothing yet is explained, not a crash", async () => {
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("A", a, 10))], likes: [] } });
  await page.start("like");
  assert.ok(page.visible("viewStart"), "you're left on the start screen, not a blank one");
  assert.match(page.$("#startErr").textContent, /haven't liked anything/i);
});

test("the two ways to pick up where you left off sit together", async () => {
  const page = await h.loadPage({});
  const pair = page.$("#startForm .choice-pair");
  assert.ok(pair, "there's a row for them");
  assert.deepEqual([...pair.querySelectorAll('input[name="kind"]')].map(el => el.value),
    ["resume", "like"], "and it holds exactly those two");
  // A row that can't wrap would push past the edge on a phone.
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const css = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  assert.match(css, /\.choice-pair\{[^}]*flex-wrap\s*:\s*wrap/, "the row stacks when narrow");
});

test("with nothing read yet, the like option still fills the row", async () => {
  // No saved position hides "Resume where I left off" entirely; the option
  // beside it mustn't be left sitting in half a row.
  const page = await h.loadPage({ storage: {} });
  assert.ok(page.$("#choiceResume").classList.contains("hidden"), "nothing to resume to");
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const css = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  assert.match(css, /\.choice-pair\s*>\s*\.choice\.hidden\{[^}]*display\s*:\s*none/,
    "a hidden option in the row must take no space");
});

test("signing out forgets the account's saved feeds", async () => {
  // The picker is filled once per sign-in. Sign-out used to leave both
  // state.savedFeeds and the filled <select> behind, so the next person to
  // sign in on the same computer was shown the previous account's feeds.
  const page = await h.loadPage({ server: withFeeds({ timeline: [h.item(h.post("A", a, 10))] }) });
  const names = () => [...page.$("#inFeed").options].map(o => o.textContent).join(" | ");
  for (let i = 0; i < 100 && !names().includes("For You"); i++) await new Promise(r => setTimeout(r, 20));
  assert.match(names(), /For You/, "the signed-in account's feeds are listed");

  page.$("#btnSignOut").click();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(page.eval("state.savedFeeds"), null, "the saved feeds are dropped");
  assert.equal(page.eval("chosenFeed"), null, "and so is the chosen one");
  assert.doesNotMatch(names(), /For You|Friends/, "no feed names left in the picker");
  assert.equal(page.eval('$("#inFeed").dataset.filled'), undefined,
    "the picker will fill again for the next account");
  assert.ok(page.visible("viewLogin"));
});

/* ---------- the end of a "most recent N posts" catch-up ---------- */
// Reading by time means nothing on a ranked feed, which is the whole reason
// this mode exists -- so "Load newer posts" (which asks for everything since
// the newest post it holds) would almost always come back empty. The useful
// move there is to read DEEPER into the ranking instead.

test("recent mode offers more posts, not newer ones", async () => {
  const many = Array.from({ length: 12 }, (_, i) => h.item(h.post("P" + i, a, 10 + i)));
  const page = await h.loadPage({ server: withFeeds({ feeds: { [FEED]: many } }) });
  await page.startRecent(5, { feed: FEED });
  assert.equal(page.$("#btnNewer"), null, "no 'load newer posts' button here");
  assert.match(page.$("#btnMore").textContent, /Load 5 more/);
  assert.match(page.$("#endcap").textContent, /That's all 5 posts, as of/);
});

test("a date catch-up still offers newer posts", async () => {
  const page = await h.loadPage({ server: withFeeds({ feeds: { [FEED]: [h.item(h.post("F1", a, 10))] } }) });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.equal(page.$("#btnMore"), null);
  assert.match(page.$("#btnNewer").textContent, /Load newer posts/);
});

test("loading more reads deeper into the feed and puts the posts above", async () => {
  const many = Array.from({ length: 12 }, (_, i) => h.item(h.post("P" + i, a, 10 + i)));
  const page = await h.loadPage({ server: withFeeds({ feeds: { [FEED]: many } }) });
  await page.startRecent(5, { feed: FEED });
  assert.deepEqual(page.ids(), ["P7", "P8", "P9", "P10", "P11"]);
  const newest = page.article("P11");

  page.$("#btnMore").click();
  await h.waitFor(() => page.ids().includes("P2"), { message: "deeper posts" });
  // Five more, further down the ranking -- so, oldest first, above what we had.
  assert.deepEqual(page.ids(), ["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"]);
  assert.notEqual(page.article("P11"), newest, "the view was rebuilt around them");
  assert.match(page.toast(), /5 more posts added above/);
  assert.match(page.$("#endcap").textContent, /That's all 10 posts/);
  assert.match(page.$("#btnMore").textContent, /Load 5 more/, "and you can keep going");
});

test("a feed with nothing deeper says so and drops the button", async () => {
  const some = Array.from({ length: 3 }, (_, i) => h.item(h.post("P" + i, a, 10 + i)));
  const page = await h.loadPage({ server: withFeeds({ feeds: { [FEED]: some } }) });
  await page.startRecent(5, { feed: FEED });
  page.$("#btnMore").click();
  await h.waitFor(() => page.toast(), { message: "the end-of-feed toast" });
  assert.match(page.toast(), /doesn't go back any further/);
  assert.equal(page.$("#btnMore"), null, "nothing left to press");
  assert.match(page.$("#endcap").textContent, /doesn't go back any further/);
});
