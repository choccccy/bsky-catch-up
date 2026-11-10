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

/* ---------------------------------------------------------------- the profile panel */
/* Clicking a name opens the person OVER the feed. The thing that matters is
   that it is an overlay and not a view: the catch-up underneath keeps its
   posts and its scroll position, because leaving the page with #from=... in
   the address would re-run the whole thing on the way back. */

const profTimeline = [h.item(h.post("A", h.actor(1), 10)), h.item(h.post("B", h.actor(2), 20))];

test("clicking a name opens the profile over the feed", async () => {
  const page = await h.loadPage({ server: { timeline: profTimeline } });
  await page.startDate(h.BASE);
  const ids = page.ids();

  page.article("A").querySelector('.pv-name[data-act="profile"]').dispatchEvent(
    new page.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await h.waitFor(() => page.$("#profile .pf-name"), { message: "the panel" });

  assert.ok(page.visible("viewFeed"), "the feed is still the view underneath");
  assert.deepEqual(page.ids(), ids, "and still has its posts");
  assert.match(page.$("#profile .pf-handle").textContent, /^@u1\.test/);
  assert.ok(!page.$("#profScrim").classList.contains("hidden"), "with its scrim up");
});

test("the panel closes without disturbing the catch-up", async () => {
  const page = await h.loadPage({ server: { timeline: profTimeline } });
  await page.startDate(h.BASE);
  const ids = page.ids();
  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$("#profile .pf-name"), { message: "the panel" });
  page.$('#profile [data-act="prof-close"]').click();
  assert.ok(page.$("#profile").classList.contains("hidden"), "panel gone");
  assert.ok(page.$("#profScrim").classList.contains("hidden"), "scrim gone");
  assert.deepEqual(page.ids(), ids, "the catch-up is untouched");
});

test("Escape closes the panel too", async () => {
  const page = await h.loadPage({ server: { timeline: profTimeline } });
  await page.startDate(h.BASE);
  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$("#profile .pf-name"), { message: "the panel" });
  page.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(page.$("#profile").classList.contains("hidden"));
});

test("a modified click is left to the browser", async () => {
  // Someone asking for a new tab gets the front-end, as the href says.
  const page = await h.loadPage({ settings: { webHost: "deer.example" }, server: { timeline: profTimeline } });
  await page.startDate(h.BASE);
  const link = page.article("A").querySelector('.pv-name[data-act="profile"]');
  assert.match(link.href, /^https:\/\/deer\.example\/profile\//, "the href still points out");
  const ev = new page.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
  link.dispatchEvent(ev);
  assert.ok(!ev.defaultPrevented, "the click was not swallowed");
  assert.ok(page.$("#profile").classList.contains("hidden"), "and no panel opened");
});

test("the panel shows their posts, with working action buttons", async () => {
  const page = await h.loadPage({ server: {
    timeline: profTimeline,
    authorFeeds: { "did:plc:u1": [h.item(h.post("X1", h.actor(1), 5))] },
  } });
  await page.startDate(h.BASE);
  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$("#profile .pv"), { message: "their posts" });
  const post = page.$("#profile .pv");
  assert.match(post.textContent, /post X1/);
  // The like button inside the panel writes a record like any other.
  post.querySelector('[data-act="like"]').click();
  await h.waitFor(() => page.records().some(r => r.collection === "app.bsky.feed.like"),
    { message: "the like" });
});

test("'Read their posts here' starts an author catch-up", async () => {
  const page = await h.loadPage({ server: {
    timeline: profTimeline,
    authorFeeds: { "did:plc:u1": [h.item(h.post("X1", h.actor(1), 5)), h.item(h.post("X2", h.actor(1), 6))] },
  } });
  await page.startDate(h.BASE);
  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$('#profile [data-act="prof-read"]'), { message: "the button" });
  page.$('#profile [data-act="prof-read"]').click();
  await page.settle();
  assert.ok(page.$("#profile").classList.contains("hidden"), "the panel closed behind it");
  assert.equal(page.eval("state.run.feed.kind"), "author", "and a catch-up of one person started");
  assert.equal(page.eval("state.run.feed.did"), "did:plc:u1");
});

test("in protocol mode the name stays a link out", async () => {
  // The panel is built from two AppView reads, and that mode promises none.
  const page = await h.loadPage({ settings: { protocolOnly: true }, server: { timeline: profTimeline } });
  page.eval(`openProfile("did:plc:u1")`);
  await h.wait(50);
  assert.ok(page.$("#profile").classList.contains("hidden"), "no panel");
  assert.equal(page.calls.filter(c => c.startsWith("app.bsky.")).length, 0, "and no AppView request");
});

test("a profile that won't load says so inside the panel", async () => {
  const page = await h.loadPage({ server: {
    timeline: profTimeline,
    handlers: { "app.bsky.actor.getProfile": () => ({ status: 400, error: "InvalidRequest", message: "Profile not found" }) },
  } });
  await page.startDate(h.BASE);
  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$("#profile .pf-note"), { message: "the message" });
  assert.match(page.$("#profile .pf-note").textContent, /Couldn't load that profile/);
});

/* The two things the panel does that nothing was holding (both guards came
   back GREEN in sabotage.py before these existed). */

/* Back must shut the panel rather than leave the page -- and leaving is
   expensive here, because the address carries #from=... and coming back
   re-runs the whole catch-up. Opening pushes a history entry and closing
   gives it back, so the two have to stay in step: a panel that pushed and
   never popped would make Back do nothing the first time it was pressed. */
test("Back closes the profile panel instead of leaving the page", async () => {
  const page = await h.loadPage({ server: { timeline: profTimeline } });
  await page.startDate(h.BASE);
  const depth = page.window.history.length;

  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$("#profile .pf-name"), { message: "the panel" });
  assert.equal(page.window.history.length, depth + 1, "opening it pushed an entry to go back to");
  assert.equal(page.eval("overlays.length"), 1, "and it is holding that entry");

  page.window.history.back();
  await h.wait(20);
  assert.ok(page.$("#profile").classList.contains("hidden"), "Back closed the panel");
  assert.deepEqual(page.ids(), ["A", "B"], "and the catch-up is still on screen, not restarted");

  // Closing by the button has to give the entry back the same way, or the
  // next Back press would do nothing.
  page.eval(`openProfile("did:plc:u2")`);
  await h.waitFor(() => page.$("#profile .pf-name"), { message: "the panel again" });
  page.$('#profile [data-act="prof-close"]').click();
  await h.wait(20);
  assert.equal(page.eval("overlays.length"), 0, "the button gave the entry back too");
});

/* Two requests are in flight for every panel, and either can land after the
   reader has moved on -- closed it, or opened somebody else. Whatever comes
   back late belongs to a panel that is no longer there and must not be
   drawn over the one that is. */
/* A held getProfile, so a late answer can be made to land exactly when the
   test wants it to. ME is passed through untouched: the page asks about the
   signed-in user at boot, and answering that with an error would leave the
   session down and every assertion below meaningless. */
const heldProfiles = () => {
  const gate = {};
  const handler = async p => {
    const who = p.get("actor");
    if (!who || who === "did:plc:me" || who === "me.test") return { did: "did:plc:me", handle: "me.test", displayName: "Me", followsCount: 0 };
    if (gate[who]) await gate[who];
    const n = /^did:plc:u(\d+)$/.exec(who);
    return n ? { ...h.actor(Number(n[1])), followersCount: 1, followsCount: 1, postsCount: 1 }
             : { status: 400, error: "InvalidRequest", message: "no" };
  };
  return {
    handler,
    hold(who) { let release; gate[who] = new Promise(r => (release = r)); return () => { delete gate[who]; release(); }; },
  };
};

test("a profile that answers late doesn't draw over the one that replaced it", async () => {
  const g = heldProfiles();
  const page = await h.loadPage({ server: { timeline: profTimeline, handlers: { "app.bsky.actor.getProfile": g.handler } } });
  await page.startDate(h.BASE);

  const letU1Answer = g.hold("did:plc:u1");
  page.eval(`openProfile("did:plc:u1")`);
  await h.wait(20);
  page.eval(`openProfile("did:plc:u2")`);
  await h.waitFor(() => page.$("#profile .pf-handle")?.textContent === "@u2.test", { message: "u2 drawn" });

  letU1Answer();                       // u1's answer lands for a panel nobody is looking at
  await h.wait(120);
  assert.equal(page.$("#profile .pf-handle").textContent, "@u2.test",
    "the late answer did not replace the person on screen");
});

test("a profile that answers after the panel is closed stays closed", async () => {
  const g = heldProfiles();
  const page = await h.loadPage({ server: { timeline: profTimeline, handlers: { "app.bsky.actor.getProfile": g.handler } } });
  await page.startDate(h.BASE);

  const letItAnswer = g.hold("did:plc:u1");
  page.eval(`openProfile("did:plc:u1")`);
  await h.wait(20);
  page.eval(`closeProfile()`);
  assert.ok(page.$("#profile").classList.contains("hidden"), "closed while the request was still out");

  letItAnswer();
  await h.wait(120);
  assert.ok(page.$("#profile").classList.contains("hidden"), "and the late answer left it closed");
  assert.equal(page.$("#profile").innerHTML, "", "with nothing drawn into it");
});

test("a muted account says so, and still shows their posts", async () => {
  const muted = { ...h.actor(1), viewer: { muted: true }, followersCount: 1, followsCount: 1, postsCount: 1 };
  const page = await h.loadPage({ server: {
    timeline: profTimeline,
    profiles: { "did:plc:u1": muted },
    authorFeeds: { "did:plc:u1": [h.item(h.post("X1", h.actor(1), 5))] },
  } });
  await page.startDate(h.BASE);
  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$("#profile .pv"), { message: "their posts" });
  assert.match(page.$("#profile .pf-note").textContent, /muted/i, "says they're muted");
  assert.ok(page.$("#profile .pv"), "and their posts are still there, because muting isn't blocking");
});

test("a blocked account shows no posts at all", async () => {
  const blocked = { ...h.actor(1), viewer: { blockedBy: true }, followersCount: 1, followsCount: 1, postsCount: 1 };
  const page = await h.loadPage({ server: { timeline: profTimeline, profiles: { "did:plc:u1": blocked } } });
  await page.startDate(h.BASE);
  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$("#profile .pf-name"), { message: "the profile" });
  assert.match(page.$("#profile .pf-note").textContent, /block/i);
  assert.ok(!page.$("#profile .pv"), "no posts");
  assert.ok(!page.$("#profile .pf-posts"), "and no empty 'Latest posts' heading either");
});

/* Swipe down to dismiss. The panel scrolls, so the gesture only counts from
   the top -- dismissing on a drag made part-way down would make it unreadable. */
test("swiping down from the top dismisses the panel, but a scroll doesn't", async () => {
  const page = await h.loadPage({ server: { timeline: profTimeline } });
  await page.startDate(h.BASE);
  const box = page.$("#profile");
  const ptr = (type, y) => {
    const ev = new page.window.MouseEvent(type, { bubbles: true, clientX: 100, clientY: y });
    Object.defineProperty(ev, "isPrimary", { value: true });
    return ev;
  };
  const drag = (dy, from = 0) => {
    box.scrollTop = from;
    box.dispatchEvent(ptr("pointerdown", 100));
    box.dispatchEvent(ptr("pointerup", 100 + dy));
  };

  page.eval(`openProfile("did:plc:u1")`);
  await h.waitFor(() => page.$("#profile .pf-name"), { message: "the panel" });
  drag(20);
  assert.ok(!box.classList.contains("hidden"), "a short drag is not a dismissal");
  drag(-150);
  assert.ok(!box.classList.contains("hidden"), "flicking UP is not putting it away");
  drag(150, 300);
  assert.ok(!box.classList.contains("hidden"), "and neither is a drag that started part-way down: that's a scroll");
  drag(150);
  assert.ok(box.classList.contains("hidden"), "down from the top puts it away");
  assert.equal(page.eval("overlays.length"), 0, "and gives its history entry back");
});

/* ---------------------------------------------------------------- the composer */
/* The first thing this page writes that is WORDS. Everything here is about
   the record that reaches the repository: a like is a reference, a post is
   content, and getting its shape wrong is visible to everyone else. */

const compTimeline = [h.item(h.post("A", h.actor(1), 10))];
const openQuote = async page => {
  page.article("A").querySelector('[data-act="repost"]').click();
  await h.wait(20);
  const quote = [...page.$$(".menu [data-m]")].find(el => el.textContent.trim() === "Quote");
  assert.ok(quote, "the repost menu offers Quote");
  quote.click();
  await h.waitFor(() => page.visible("composer"), { message: "the composer" });
};
const write = (page, text) => {
  page.$("#compText").value = text;
  page.$("#compText").dispatchEvent(new page.window.Event("input", { bubbles: true }));
};
const posted = page => page.records().find(r => r.collection === "app.bsky.feed.post");

test("a quote post is written with the quoted post embedded", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  await openQuote(page);
  write(page, "look at this");
  page.$("#compPost").click();
  await h.waitFor(() => posted(page), { message: "the post" });

  const rec = posted(page).record;
  assert.equal(rec.$type, "app.bsky.feed.post");
  assert.equal(rec.text, "look at this");
  assert.equal(rec.embed.$type, "app.bsky.embed.record", "the quote is an embed, not a link");
  assert.match(rec.embed.record.uri, /app\.bsky\.feed\.post\/A$/);
  assert.ok(rec.embed.record.cid, "with the cid, which is what pins the version quoted");
  assert.ok(Date.parse(rec.createdAt), "and a timestamp");
  assert.ok(!page.visible("composer"), "the composer closed behind it");
});

test("links, mentions and hashtags are marked up by BYTE offset", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  await openQuote(page);
  // The emoji is the point: it is two UTF-16 units and four bytes, so a
  // facet counted in characters would land in the wrong place.
  const text = "🎉 see https://example.com and @u1.test #tag";
  write(page, text);
  page.$("#compPost").click();
  await h.waitFor(() => posted(page), { message: "the post" });

  const rec = posted(page).record;
  const bytes = Buffer.from(rec.text, "utf8");
  const slice = f => bytes.slice(f.index.byteStart, f.index.byteEnd).toString("utf8");
  const byType = t => rec.facets.find(f => f.features[0].$type === `app.bsky.richtext.facet#${t}`);
  assert.equal(slice(byType("link")), "https://example.com", "the link covers exactly the link");
  assert.equal(slice(byType("mention")), "@u1.test", "the mention covers the handle");
  assert.equal(slice(byType("tag")), "#tag", "and the tag its word");
  assert.equal(byType("mention").features[0].did, "did:plc:u1", "a mention names a DID, not a handle");
  assert.equal(byType("tag").features[0].tag, "tag", "without the hash");
  assert.deepEqual(rec.facets.map(f => f.index.byteStart), [...rec.facets.map(f => f.index.byteStart)].sort((a, b) => a - b),
    "and they are in order");
});

test("a handle that doesn't resolve stays plain words", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  await openQuote(page);
  write(page, "hello @nobody.invalid");
  page.$("#compPost").click();
  await h.waitFor(() => posted(page), { message: "the post" });
  const rec = posted(page).record;
  assert.ok(!rec.facets?.some(f => f.features[0].$type === "app.bsky.richtext.facet#mention"),
    "no mention facet was guessed at");
});

test("the counter counts graphemes, not UTF-16 units", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  await openQuote(page);
  // One family emoji: seven code points, one thing a reader sees.
  write(page, "👨‍👩‍👧‍👦");
  assert.match(page.$("#compCount").textContent, /^1 \/ 300/, "one grapheme, not eleven");
  assert.ok(!page.$("#compPost").disabled);

  write(page, "x".repeat(301));
  assert.match(page.$("#compCount").textContent, /^301 \/ 300/);
  assert.ok(page.$("#compCount").classList.contains("over"), "marked as over");
  assert.ok(page.$("#compPost").disabled, "and Post can't be pressed");

  write(page, "   ");
  assert.ok(page.$("#compPost").disabled, "nor with nothing but spaces");
});

test("a post that doesn't save leaves the words in the box", async () => {
  const page = await h.loadPage({ server: {
    timeline: compTimeline,
    handlers: { "com.atproto.repo.createRecord": () => ({}) },   // no uri back
  } });
  await page.startDate(h.BASE);
  await openQuote(page);
  write(page, "this will fail");
  page.$("#compPost").click();
  await h.waitFor(() => page.$("#compErr").textContent, { message: "the error" });
  assert.match(page.$("#compErr").textContent, /didn't confirm/i, "says what went wrong");
  assert.ok(page.visible("composer"), "the composer stays open");
  assert.equal(page.$("#compText").value, "this will fail", "with the words still there");
  assert.ok(!page.$("#compPost").disabled, "and can be tried again");
});

test("a post can be taken straight back out again", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  await openQuote(page);
  write(page, "oops");
  page.$("#compPost").click();
  await h.waitFor(() => posted(page), { message: "the post" });
  const undo = page.$("#toast .toast-action");
  assert.ok(undo, "the toast offers Undo");
  undo.click();
  await h.waitFor(() => !posted(page), { message: "the delete" });
  assert.ok(!posted(page), "the post is gone from the repository");
});

test("Escape closes the composer, and Back does too", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  await openQuote(page);
  const depth = page.window.history.length;
  assert.equal(page.eval("overlays.length"), 1, "it holds a history entry");
  page.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(!page.visible("composer"), "Escape closed it");
  assert.equal(page.eval("overlays.length"), 0, "and gave the entry back");

  await openQuote(page);
  page.window.history.back();
  await h.wait(20);
  assert.ok(!page.visible("composer"), "Back closed it too");
  assert.deepEqual(page.ids(), ["A"], "and the catch-up is still there");
});

test("the keyboard shortcut can't post past the limit either", async () => {
  // Ctrl/Cmd+Enter calls publishComposed() directly, so the disabled Post
  // button is not what stops an over-long post -- the check inside it is.
  // (sabotage.py found this: removing that check broke nothing.)
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  await openQuote(page);
  write(page, "x".repeat(301));
  assert.ok(page.$("#compPost").disabled, "the button is disabled");

  page.document.dispatchEvent(new page.window.KeyboardEvent("keydown",
    { key: "Enter", ctrlKey: true, bubbles: true }));
  await h.wait(120);
  assert.ok(!posted(page), "and the shortcut wrote nothing");
  assert.ok(page.visible("composer"), "the composer is still open with the words in it");

  // Back under the limit, the same shortcut does post.
  write(page, "short enough");
  page.document.dispatchEvent(new page.window.KeyboardEvent("keydown",
    { key: "Enter", metaKey: true, bubbles: true }));
  await h.waitFor(() => posted(page), { message: "the post" });
  assert.equal(posted(page).record.text, "short enough");
});

/* ---------------------------------------------------------------- posts and replies */

test("the top bar writes a post with no embed and no reply", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  page.$("#btnWrite").click();
  await h.waitFor(() => page.visible("composer"), { message: "the composer" });
  assert.ok(page.$("#compQuote").classList.contains("hidden"), "nothing is being quoted");
  write(page, "hello world");
  page.$("#compPost").click();
  await h.waitFor(() => posted(page), { message: "the post" });

  const rec = posted(page).record;
  assert.equal(rec.text, "hello world");
  assert.ok(!rec.embed, "no embed");
  assert.ok(!rec.reply, "and no reply refs: this is a post of its own");
});

test("a reply names both the post it answers and the thread's root", async () => {
  // The two differ the moment you answer a reply. Taking the parent for the
  // root files the exchange under the wrong conversation everywhere else.
  const top = h.post("TOP", h.actor(1), 10, { replyCount: 1 });
  const mid = h.post("MID", h.actor(2), 11, { replyTo: top, replyCount: 0 });
  const page = await h.loadPage({ server: {
    timeline: [h.item(top)],
    posts: Object.fromEntries([top, mid].map(x => [x.uri, x])),
  } });
  await page.startDate(h.BASE);

  // Open TOP's replies, then answer MID -- a reply to a reply.
  page.article("TOP").querySelector('[data-act="replies"]').click();
  await h.waitFor(() => page.article("TOP").querySelector(".replies"), { message: "the replies" });
  const midPv = page.article("TOP").querySelector('.replies .pv[data-uri$="MID"]');
  assert.ok(midPv, "MID is on screen");
  midPv.querySelector('[data-act="replies"]').click();
  await h.waitFor(() => midPv.querySelector(".replies"), { message: "MID's own replies" });
  midPv.querySelector('[data-act="reply-to"]').click();
  await h.waitFor(() => page.visible("composer"), { message: "the composer" });
  assert.match(page.$("#compQuote").textContent, /Replying to/);

  write(page, "answering the reply");
  page.$("#compPost").click();
  await h.waitFor(() => posted(page), { message: "the reply" });

  const rec = posted(page).record;
  assert.match(rec.reply.parent.uri, /post\/MID$/, "the parent is the post answered");
  assert.match(rec.reply.root.uri, /post\/TOP$/, "the root is the thread's first post, not the parent");
  assert.ok(rec.reply.parent.cid && rec.reply.root.cid, "both carry a cid");
});

test("replying to a top-level post makes it its own root", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  page.article("A").querySelector('[data-act="replies"]').click();
  await h.waitFor(() => page.article("A").querySelector('[data-act="reply-to"]'), { message: "the reply button" });
  page.article("A").querySelector('[data-act="reply-to"]').click();
  await h.waitFor(() => page.visible("composer"), { message: "the composer" });
  write(page, "first reply");
  page.$("#compPost").click();
  await h.waitFor(() => posted(page), { message: "the reply" });

  const rec = posted(page).record;
  assert.equal(rec.reply.root.uri, rec.reply.parent.uri, "root and parent are the same post");
  assert.match(rec.reply.root.uri, /post\/A$/);
});

test("a reply can carry links and mentions like any other post", async () => {
  const page = await h.loadPage({ server: { timeline: compTimeline } });
  await page.startDate(h.BASE);
  page.article("A").querySelector('[data-act="replies"]').click();
  await h.waitFor(() => page.article("A").querySelector('[data-act="reply-to"]'), { message: "the reply button" });
  page.article("A").querySelector('[data-act="reply-to"]').click();
  await h.waitFor(() => page.visible("composer"), { message: "the composer" });
  write(page, "see https://example.com @u1.test");
  page.$("#compPost").click();
  await h.waitFor(() => posted(page), { message: "the reply" });
  const rec = posted(page).record;
  assert.equal(rec.facets.length, 2, "the same facet builder runs for a reply");
  assert.ok(rec.reply, "and it is still a reply");
});
