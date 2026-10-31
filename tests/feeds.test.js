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

/* ---- what a like says about where you were reading ---- */

const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";
/** A record key that encodes a time, the way a PDS makes one: 53 bits of
 *  microseconds since the epoch, then 10 bits of clock id, in sortable
 *  base32. The page reads this back when a record itself is gone. */
function tid(ms) {
  let n = (BigInt(ms) * 1000n) << 10n, out = "";
  for (let i = 0; i < 13; i++) { out = TID_CHARS[Number(n & 31n)] + out; n >>= 5n; }
  return out;
}
const secs = t => Math.round(t / 1000);
/** Liked a repost: an old post that someone put back in front of you 20
 *  minutes into this feed, liked five minutes after that. */
function viaSetup({ record = true, viaUri = null } = {}) {
  const repostedAt = h.BASE + 20 * h.MIN;
  const orig = h.post("OLD", b, -4000);                 // written days earlier
  const fi = h.item(orig, { repostBy: a, repostMin: 20 });
  if (viaUri) fi.reason.uri = viaUri;
  const server = {
    timeline: [h.item(h.post("BEFORE", b, 10)), fi, h.item(h.post("AFTER", b, 30))],
    likes: [{ uri: orig.uri, via: fi.reason.uri, createdAt: h.iso(repostedAt + 5 * h.MIN) }],
    ...(record ? { recordsByUri: { [fi.reason.uri]: {
      $type: "app.bsky.feed.repost", subject: { uri: orig.uri, cid: orig.cid }, createdAt: h.iso(repostedAt),
    } } } : {}),
  };
  return { orig, fi, server, repostedAt };
}

test("a like on a repost starts where the repost appeared, not at the post's own date", async () => {
  // The post is days old; the repost is what went past you. Starting at the
  // post's own date would read those days back, and would be answering a
  // question about the post rather than about your reading.
  const { server, repostedAt } = viaSetup();
  const page = await h.loadPage({ server });
  await page.start("like");
  assert.ok(page.article("OLD").classList.contains("anchor"),
    `the repost is where you're put: ${page.ids().join(",")}`);
  assert.deepEqual(page.ids(), ["BEFORE", "OLD", "AFTER"],
    "with context above it and the rest of the feed below");
  assert.match(page.$("#feedHead").textContent, /repost/,
    "and the page says that's what happened");
  assert.match(page.window.location.hash, new RegExp(`from=[^&]*/post/OLD@${secs(repostedAt)}\\b`),
    `the link names the post and the time it was read at: ${page.window.location.hash}`);
  const asked = page.requests.filter(r => r.nsid === "com.atproto.repo.getRecord" && r.search.get("collection") === "app.bsky.feed.repost");
  assert.equal(asked.length, 1, "the repost record is read for its time");
  assert.equal(asked[0].search.get("repo"), a.did, "out of the reposter's own repository");
});

test("a repost deleted since the like is still dated, from its record key", async () => {
  // People un-repost things. The key is a TID, so it says when it was
  // written even when there's nothing left to read.
  const repostedAt = h.BASE + 20 * h.MIN;
  const { server } = viaSetup({ record: false, viaUri: `at://${a.did}/app.bsky.feed.repost/${tid(repostedAt)}` });
  const page = await h.loadPage({ server });
  await page.start("like");
  assert.ok(page.article("OLD").classList.contains("anchor"));
  assert.match(page.window.location.hash, new RegExp(`@${secs(repostedAt)}\\b`),
    `dated from the key: ${page.window.location.hash}`);
});

test("a via nothing can date is ignored rather than trusted", async () => {
  // No record and no time in the key: the start falls back to the post, which
  // is what a like with no via at all does. What it must NOT do is start at
  // the epoch, or anywhere else a failed read happens to point.
  const liked = h.post("LIKED", b, 20);
  const fi = h.item(liked, { repostBy: a, repostMin: 25 });
  fi.reason.uri = `at://${a.did}/app.bsky.feed.repost/not-a-tid`;
  const page = await h.loadPage({ server: {
    timeline: [h.item(h.post("BEFORE", b, 5)), fi, h.item(h.post("AFTER", b, 40))],
    likes: [{ uri: liked.uri, via: fi.reason.uri, createdAt: h.iso(h.BASE + 30 * h.MIN) }],
  } });
  await page.start("like");
  assert.ok(page.article("LIKED").classList.contains("anchor"));
  assert.match(page.window.location.hash, new RegExp(`@${secs(h.BASE + 20 * h.MIN)}\\b`),
    `the post's own time, not a misread one: ${page.window.location.hash}`);
});

test("a like on something far older than the like starts at the like instead", async () => {
  // Liked from search, a profile or a thread: nothing says you met it in your
  // feed, its date is days back, and starting there reads days of feed for a
  // catch-up nobody asked for. Your own like is the better guess.
  const old = h.post("ANCIENT", b, -3000);
  const likedAt = h.BASE + 15 * h.MIN;
  const page = await h.loadPage({ server: {
    timeline: [h.item(h.post("EARLIER", b, 5)), h.item(old), h.item(h.post("AFTER", b, 20)), h.item(h.post("LATER", b, 40))],
    likes: [{ uri: old.uri, createdAt: h.iso(likedAt) }],
  } });
  await page.start("like");
  assert.deepEqual(page.ids(), ["AFTER", "LATER"], "reading starts at the like, not days back");
  assert.match(page.$("#feedHead").textContent, /you liked it on/, "and it says why");
  assert.match(page.window.location.hash, /from=\d{4}-\d{2}-\d{2}T/,
    `a time start -- the post is nowhere in the window: ${page.window.location.hash}`);
});

test("a like made in the same sitting still starts at the post itself", async () => {
  // Inside the window the post's own time is the finer of the two, and the
  // post is the thing to highlight.
  const liked = h.post("LIKED", b, 20);
  const page = await h.loadPage({ server: {
    timeline: [h.item(h.post("BEFORE", b, 5)), h.item(liked), h.item(h.post("AFTER", b, 40))],
    likes: [{ uri: liked.uri, createdAt: h.iso(h.BASE + 80 * h.MIN) }],
  } });
  await page.start("like");
  assert.ok(page.article("LIKED").classList.contains("anchor"));
  assert.ok(!/you liked it on/.test(page.$("#feedHead").textContent), "nothing to explain");
  assert.match(page.window.location.hash, new RegExp(`@${secs(h.BASE + 20 * h.MIN)}\\b`));
});

test("a record key is only read as a time when it is one", async () => {
  // tidTime() is the fallback for a repost that's been deleted, so it is the
  // one place a string from somebody else's repository is turned into a
  // number. Anything that isn't a TID has to come back as no answer, not as
  // a number that happens to fall out of the arithmetic.
  const page = await h.loadPage({});
  const when = h.BASE + 20 * h.MIN;
  assert.equal(page.eval(`tidTime(${JSON.stringify(tid(when))})`), when, "a real key gives its own time back");
  for (const bad of ["not-a-tid", "", "self", "3momtuwbpqw2", "3momtuwbpqw2ll", "3MOMTUWBPQW2L", "3momtuwbpq01l"]) {
    assert.ok(Number.isNaN(page.eval(`tidTime(${JSON.stringify(bad)})`)), `${bad || "(empty)"} is not a key that says a time`);
  }
});

test("a repost dated after the like it supposedly came from is not believed", async () => {
  // A time that can't be true is a sign the field isn't what we think, not a
  // start point. Starting there would put the catch-up in the future.
  const liked = h.post("LIKED", b, 20);
  const fi = h.item(liked, { repostBy: a, repostMin: 25 });
  const page = await h.loadPage({ server: {
    timeline: [h.item(h.post("BEFORE", b, 5)), fi, h.item(h.post("AFTER", b, 40))],
    likes: [{ uri: liked.uri, via: fi.reason.uri, createdAt: h.iso(h.BASE + 30 * h.MIN) }],
    recordsByUri: { [fi.reason.uri]: { $type: "app.bsky.feed.repost", createdAt: h.iso(h.BASE + 400 * 24 * 60 * h.MIN) } },
  } });
  await page.start("like");
  assert.ok(page.visible("viewFeed"), `the catch-up still runs: ${page.$("#startErr").textContent}`);
  assert.ok(page.article("LIKED").classList.contains("anchor"));
  assert.match(page.window.location.hash, new RegExp(`@${secs(h.BASE + 20 * h.MIN)}\\b`),
    `the post's own time, the repost's claim ignored: ${page.window.location.hash}`);
});

test("a link to a like-on-a-repost catch-up opens the same catch-up", async () => {
  // Without the time in the link, following it would start at the post's own
  // date and read days nobody read: a different catch-up from the shared one.
  const { server } = viaSetup();
  const page = await h.loadPage({ server });
  await page.start("like");
  const frag = page.window.location.hash.slice(1);
  const again = await h.loadPage({ url: "https://site.example/index.html#" + frag, server: viaSetup().server });
  await again.settle();
  assert.deepEqual(again.ids(), page.ids(), "same posts");
  assert.ok(again.article("OLD").classList.contains("anchor"), "same start post");
  assert.equal(again.window.location.hash, page.window.location.hash, "and the same link again");
  // "Copy link" is the one people actually share, and it is built from the
  // finished run rather than from the address.
  page.$("#btnCopyCatchup").click(); await h.wait(20);
  assert.match(page.clip.at(-1), new RegExp(`from=[^&]*/post/OLD@${secs(h.BASE + 20 * h.MIN)}\\b`),
    `the copied link carries the time as well: ${page.clip.at(-1)}`);
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

/* ---------------------------------------------------------------- feed order */
/* A feed that ranks its posts rather than ordering them by time. The ids are
 * the order it SERVES them in (R0 first, highest-ranked); the minutes are
 * deliberately scattered, so sorting by time would shuffle them. 24 posts so
 * there is enough of a run to judge the order by (ORDER_MIN_ITEMS). */
const RANK_MINS = [31, 9, 57, 14, 48, 2, 39, 21, 60, 5, 44, 17, 53, 28, 11, 36, 1, 50, 24, 7, 42, 19, 33, 12];
const ranked = (n = RANK_MINS.length, from = 0) =>
  RANK_MINS.slice(from, from + n).map((min, i) => h.item(h.post("R" + (from + i), a, min)));
/** The account's saved feeds, with FEED served in the exact order given. */
const withRanked = (feed, extra = {}) => withFeeds({ feeds: { [FEED]: feed }, rankedFeeds: [FEED], ...extra });

test("a ranked feed is read in the order it served, not by time", async () => {
  const page = await h.loadPage({ server: withRanked(ranked()) });
  await page.startRecent(24, { feed: FEED });
  assert.equal(page.eval("state.run.order"), "feed", "the run noticed the feed is ranked");
  assert.deepEqual(page.ids(), RANK_MINS.map((_, i) => "R" + i), "served order, top of the ranking first");
  assert.match(page.$("#feedHead").textContent, /ranks its posts/);
});

test("a ranked feed loads more posts below what you've read", async () => {
  // 24 served at first, 48 available: the second read goes deeper.
  const page = await h.loadPage({ server: withRanked([...ranked(), ...ranked(24, 0).map((fi, i) => h.item(h.post("D" + i, b, 70 + i)))]) });
  await page.startRecent(24, { feed: FEED });
  const first = page.ids();
  const topArticle = page.article("R0");

  page.$("#btnMore").click();
  await h.waitFor(() => page.ids().length > 24, { message: "deeper posts" });
  const after = page.ids();
  assert.deepEqual(after.slice(0, 24), first, "nothing already read moved");
  assert.deepEqual(after.slice(24), Array.from({ length: 24 }, (_, i) => "D" + i), "the deeper posts are below");
  assert.equal(page.article("R0"), topArticle, "and the posts on screen weren't re-rendered");
  assert.match(page.toast(), /24 more posts added below/);
});

test("a ranked feed that re-ranks between reads doesn't reshuffle what you've read", async () => {
  const server = withRanked(ranked());
  const page = await h.loadPage({ server });
  await page.startRecent(24, { feed: FEED });
  const first = page.ids();
  // The feed re-ranks: a post from the middle is now its top result, and a
  // post that wasn't there before is ranked second -- ahead of everything
  // already read. That is exactly the shuffle this has to resist.
  const moved = server.feeds[FEED].splice(12, 1)[0];
  server.feeds[FEED].unshift(h.item(h.post("NEW", b, 70)));
  server.feeds[FEED].unshift(moved);
  server.feeds[FEED].push(h.item(h.post("DEEP", b, 3)));

  page.$("#btnMore").click();
  await h.waitFor(() => page.ids().includes("NEW"), { message: "the new post" });
  assert.deepEqual(page.ids().slice(0, 24), first, "the order you were reading is the order you keep");
  assert.deepEqual(page.ids().slice(24), ["NEW", "DEEP"],
    "posts the feed hadn't served before go below it, however highly it ranks them now");
});

test("a chronological feed is still read oldest first, however it's served", async () => {
  // Served newest-first with a little jitter, as a real feed is: times step
  // backwards by minutes, with a few sub-tolerance wobbles that must not be
  // mistaken for a ranking.
  const mins = [60, 55, 55.5, 50, 45, 40, 40.5, 35, 30, 25, 20, 20.25, 15, 10, 5, 4, 3, 2, 1, 0, -5, -10, -15, -20];
  const feed = mins.map((min, i) => h.item(h.post("C" + i, a, min)));
  const page = await h.loadPage({ server: withRanked(feed) });
  await page.startRecent(24, { feed: FEED });
  assert.equal(page.eval("state.run.order"), "time", "half a minute of wobble isn't a ranking");
  const shown = page.ids();
  const want = mins.map((min, i) => ["C" + i, min]).sort((x, y) => x[1] - y[1]).map(x => x[0]);
  assert.deepEqual(shown, want, "oldest first, as always -- wobble and all");
});

test("a short ranked feed is taken at its word as chronological", async () => {
  // Too few posts to judge an order by (ORDER_MIN_ITEMS), so time it is.
  const page = await h.loadPage({ server: withRanked(ranked(6)) });
  await page.startRecent(6, { feed: FEED });
  assert.equal(page.eval("state.run.order"), "time");
});

test("reading by date keeps time order even on a ranked feed", async () => {
  const page = await h.loadPage({ server: withRanked(ranked()) });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.equal(page.eval("state.run.order"), "time", "a start time only means anything in time order");
  const times = page.eval("JSON.stringify(state.view.map(i => i.t))");
  const sorted = [...JSON.parse(times)].sort((x, y) => x - y);
  assert.deepEqual(JSON.parse(times), sorted, "oldest first");
});

test("feed order drops the day and hour dividers", async () => {
  const page = await h.loadPage({
    settings: { dayDividers: true, hourDividers: true },
    server: withRanked(ranked()),
  });
  await page.startRecent(24, { feed: FEED });
  assert.equal(page.$$(".hour").length, 0, "no hour dividers");
  assert.equal(page.$$(".day").length, 0, "no day dividers");
  // The same posts read by time still get them.
  const byTime = await h.loadPage({
    settings: { dayDividers: true, hourDividers: true },
    server: withFeeds({ feeds: { [FEED]: ranked() } }),
  });
  await byTime.startRecent(24, { feed: FEED });
  assert.ok(byTime.$$(".hour").length >= 2, "hour dividers where time is the order");
});

test("feed order doesn't move your saved reading position", async () => {
  const page = await h.loadPage({ server: withRanked(ranked()) });
  await page.startRecent(24, { feed: FEED });
  page.window.Element.prototype.getBoundingClientRect = function () { return { top: 20, bottom: 120, left: 0, right: 0, width: 0, height: 100 }; };
  page.eval("updateClock()");
  assert.equal(page.window.localStorage.getItem(`bcu:position:${h.ME.did}`), null,
    "how deep into For You you got isn't a place in your Following feed");
  assert.match(page.$("#clockSub").textContent, /in the order For You gave them/);
});

/* ------------------------------------------------------- feeds that don't load */
test("a saved list that no longer resolves is left out of the picker", async () => {
  const page = await h.loadPage({ server: withFeeds({ missingLists: [LIST] }) });
  await h.wait(50);
  const opts = [...page.$("#inFeed").options].map(o => o.textContent);
  assert.ok(!opts.some(o => /Friends|Unavailable|friends/.test(o)), `the dead list is hidden: ${opts.join(" | ")}`);
  assert.ok(!opts.some(o => /^\s*[a-z0-9]{8,}\s*\(list\)$/i.test(o)), "and its rkey isn't shown as a name");
  assert.ok(opts.includes("★ For You"), "the feeds that do load are still there");
});

test("turning on broken feeds brings them back, named for what they are", async () => {
  const page = await h.loadPage({ settings: { showBrokenFeeds: true }, server: withFeeds({ missingLists: [LIST] }) });
  await h.wait(50);
  const opts = [...page.$("#inFeed").options].map(o => o.textContent);
  assert.ok(opts.includes("Unavailable list (list)"), `shown and named: ${opts.join(" | ")}`);
});
