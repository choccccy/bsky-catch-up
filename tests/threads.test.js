"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

// A: post; B reply to A (right after); C reply to B; X, Y others;
// D reply to A (later); E reply to a post not in the feed; F reply to X.
const [u1, u2, u3, u4] = [1, 2, 3, 4].map(n => h.actor(n));
const Z = h.post("Z", u1, -500);
const A = h.post("A", u1, 10), B = h.post("B", u1, 11, { replyTo: A }), C = h.post("C", u2, 12, { replyTo: B });
const X = h.post("X", u3, 13), Y = h.post("Y", u4, 14);
const D = h.post("D", u2, 20, { replyTo: A }), E = h.post("E", u1, 21, { replyTo: Z }), F = h.post("F", u1, 22, { replyTo: X });
const server = { timeline: [
  h.item(A), h.item(B, { parent: A }), h.item(C, { parent: B }), h.item(X), h.item(Y),
  h.item(D, { parent: A }), h.item(E, { parent: Z }), h.item(F, { parent: X }), h.item(h.post("OLD", u4, -300)),
] };

/** Describes the feed as "id(context)" tokens. */
function describe(page) {
  return page.$$("#feed .post").map(el => {
    const id = el.querySelector(":scope > .pv:last-child .pv-text").textContent.replace("post ", "");
    if (el.classList.contains("joined")) return id + "(j)";
    const mini = el.querySelector(".parent-mini .pm-text"); if (mini) return `${id}(mini ${mini.textContent.replace("post ", "")})`;
    const full = el.querySelector(".pv.parent .pv-text"); if (full) return `${id}(full ${full.textContent.replace("post ", "")})`;
    if (el.querySelector(".reply-to")) return id + "(line)";
    return id;
  }).join(" ");
}
const expected = {
  none: "A B(j) C(j) X Y D(line) E(line) F(line)",
  reminder: "A B(j) C(j) X Y D(mini A) E(full Z) F(mini X)",
  full: "A B(j) C(j) X Y D(full A) E(full Z) F(full X)",
  moveLater: "Y A B(j) C(j) D(mini A) E(full Z) X F(j)",
  moveUp: "A B(j) C(j) D(mini A) X F(j) Y E(full Z)",
};
for (const [mode, want] of Object.entries(expected)) {
  test(`reply context: ${mode}`, async () => {
    const page = await h.loadPage({ settings: { replyContext: mode, dayDividers: false, hourDividers: false }, server });
    await page.startDate(h.BASE);
    assert.equal(describe(page), want);
  });
}

test("joined cards: the upper card is marked has-next", async () => {
  const page = await h.loadPage({ settings: { dayDividers: false, hourDividers: false }, server });
  await page.startDate(h.BASE);
  assert.equal(page.$$(".post.has-next").length, 2);
});

test("a reminder expands to the full parent on click", async () => {
  const page = await h.loadPage({ settings: { dayDividers: false, hourDividers: false }, server });
  await page.startDate(h.BASE);
  page.article("D").querySelector(".parent-mini").click();
  assert.ok(page.article("D").querySelector(".pv.parent"));
});

test("moved threads keep dividers in feed order", async () => {
  const page = await h.loadPage({ settings: { replyContext: "moveLater" }, server });
  await page.startDate(h.BASE);
  const ts = page.$$("#feed .post").map(el => Number(el.dataset.t));
  assert.deepEqual(ts, [...ts].sort((x, y) => x - y), "placement times never go backwards");
});

/* Regression tests for 0.8.3: a followed account (u1) replies to a stranger
   (s), which the "only replies to people I follow" filter hides, then
   replies to themselves. The follow-up must show the stranger's post too. */
const s = h.actor("stranger");
const S = h.post("S", s, 30);                                   // stranger's question (thread root)
const R1 = h.post("R1", u1, 31, { replyTo: S });                // followed account answers
const R2 = h.post("R2", u1, 32, { replyTo: R1 });               // ...and follows up
const deepServer = { follows: [u1], timeline: [
  h.item(S), h.item(R1, { parent: S }), h.item(R2, { parent: R1, root: S }), h.item(h.post("OLD", u1, -300)),
] };
deepServer.timeline.splice(0, 1); // the stranger's own post isn't in your timeline

test("a follow-up to a reply to a stranger shows the thread's first post", async () => {
  const page = await h.loadPage({ settings: { dayDividers: false, hourDividers: false }, server: deepServer });
  await page.startDate(h.BASE);
  assert.deepEqual(page.ids(), ["R2"], "the reply to the stranger is filtered; the follow-up isn't");
  const parents = page.article("R2").querySelectorAll(".pv.parent .pv-text");
  assert.deepEqual([...parents].map(x => x.textContent), ["post S", "post R1"], "root, then parent, then the post");
});

test("the thread's first post becomes a reminder once it's on screen", async () => {
  const R3 = h.post("R3", u1, 40, { replyTo: R2 });
  const server = { ...deepServer, timeline: [...deepServer.timeline, h.item(h.post("X", u1, 35)), h.item(R3, { parent: R2, root: S })] };
  const page = await h.loadPage({ settings: { dayDividers: false, hourDividers: false }, server });
  await page.startDate(h.BASE);
  const minis = [...page.article("R3").querySelectorAll(".parent-mini")].map(m => m.querySelector(".pm-label").textContent);
  assert.deepEqual(minis, ["Thread started by", "Replying to"]);
  page.article("R3").querySelector('.parent-mini[data-which="root"]').click();
  assert.equal(page.article("R3").querySelector(".pv.parent .pv-text").textContent, "post S", "expands to the root");
});

/* A thread whose middle is missing from the feed: S (root) <- M <- N <- P,
   and the feed only carries Q, a reply to P. gapServer knows every post, so
   getPostThread can fill the gap in; `missing` names posts to hide from it,
   which is what a deleted or blocked post in the chain looks like. */
const M = h.post("M", s, 31, { replyTo: S });
const N = h.post("N", s, 32, { replyTo: M });
const P = h.post("P", u1, 33, { replyTo: N });
const Q = h.post("Q", u1, 34, { replyTo: P });
function gapServer({ missing = [], handlers } = {}) {
  const known = [S, M, N, P].filter(x => !missing.includes(x));
  return {
    follows: [u1], handlers,
    posts: Object.fromEntries(known.map(x => [x.uri, x])),
    timeline: [h.item(Q, { parent: P, root: S }), h.item(h.post("OLD", u1, -300))],
  };
}
const gapOpts = opts => ({ settings: { dayDividers: false, hourDividers: false }, server: gapServer(opts) });
const parentTexts = card => [...card.querySelectorAll(".pv.parent .pv-text")].map(x => x.textContent);

test("a gap between the thread's first post and the parent links to the full thread", async () => {
  const page = await h.loadPage(gapOpts());
  await page.startDate(h.BASE);
  const card = page.article("Q");
  assert.deepEqual(parentTexts(card), ["post S", "post P"]);
  assert.match(card.querySelector(".thread-gap a").getAttribute("href"), /\/post\/P$/);
});

test("the gap expands in place, oldest first", async () => {
  const page = await h.loadPage(gapOpts());
  await page.startDate(h.BASE);
  const card = page.article("Q");
  card.querySelector('.thread-gap [data-act="expand-gap"]').click();
  await h.waitFor(() => !card.querySelector(".thread-gap"), { message: "the gap to fill" });
  assert.deepEqual(parentTexts(card), ["post S", "post M", "post N", "post P"], "the missing middle, in reading order");
  assert.equal(page.calls.filter(c => c === "app.bsky.feed.getPostThread").length, 1);
});

test("a gap that can't be filled completely keeps the way out to bsky.app", async () => {
  // M is gone, so the chain stops after N and the marker stays.
  const page = await h.loadPage(gapOpts({ missing: [M] }));
  await page.startDate(h.BASE);
  const card = page.article("Q");
  card.querySelector('.thread-gap [data-act="expand-gap"]').click();
  await h.waitFor(() => parentTexts(card).length > 2, { message: "what could be fetched" });
  assert.deepEqual(parentTexts(card), ["post S", "post N", "post P"]);
  const gap = card.querySelector(".thread-gap");
  assert.ok(gap, "the marker stays");
  assert.match(gap.querySelector("a").getAttribute("href"), /\/post\/P$/);
  assert.equal(gap.querySelector("button").disabled, false, "and can be tried again");
});

test("a video in an expanded gap is registered for preloading", async () => {
  const V = h.post("V", s, 31, { replyTo: S, embed: h.embeds.video() });
  const P2 = h.post("P2", u1, 33, { replyTo: V });
  const Q2 = h.post("Q2", u1, 34, { replyTo: P2 });
  const page = await h.loadPage({ settings: { dayDividers: false, hourDividers: false }, server: {
    follows: [u1], posts: Object.fromEntries([S, V, P2].map(x => [x.uri, x])),
    timeline: [h.item(Q2, { parent: P2, root: S }), h.item(h.post("OLD", u1, -300))],
  } });
  await page.startDate(h.BASE);
  const card = page.article("Q2");
  assert.equal(page.observers.filter(o => o.opts.rootMargin).length, 0, "no video on screen yet");
  card.querySelector('.thread-gap [data-act="expand-gap"]').click();
  await h.waitFor(() => !card.querySelector(".thread-gap"), { message: "the gap to fill" });
  const po = page.observers.find(o => o.opts.rootMargin);
  assert.equal(po?.targets.length, 1, "the fetched post's video is watched");
  assert.ok(card.querySelector(".pv.parent .video"), "and it's there to watch");
});

test("a gap that fails to load says so and stays a link", async () => {
  const page = await h.loadPage(gapOpts({ handlers: { "app.bsky.feed.getPostThread": () => ({ status: 400, error: "InvalidRequest", message: "nope" }) } }));
  await page.startDate(h.BASE);
  const card = page.article("Q");
  const btn = card.querySelector('.thread-gap [data-act="expand-gap"]');
  const label = btn.textContent;
  btn.click();
  await h.waitFor(() => page.toast(), { message: "the failure toast" });
  assert.match(page.toast(), /Couldn't load/);
  assert.deepEqual(parentTexts(card), ["post S", "post P"], "nothing was inserted");
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, label, "the button goes back to its label");
  assert.match(card.querySelector(".thread-gap a").getAttribute("href"), /\/post\/P$/);
});

test("'Just Replying to @name' doesn't add thread context", async () => {
  const page = await h.loadPage({ settings: { replyContext: "none", dayDividers: false, hourDividers: false }, server: deepServer });
  await page.startDate(h.BASE);
  assert.equal(page.article("R2").querySelectorAll(".pv.parent, .parent-mini").length, 0);
});

/* ---------------------------------------------------------------- replies in place */
/* The reply button unfolds a post's replies underneath it instead of sending
   you to a front-end. getPostThread has no limit and no cursor, so the budget
   is the page's own: depth 1, and a render cap with a button for the rest. */

const R = h.actor(9);
/** A post with `n` replies to it. */
const withReplies = (n, extra = {}) => {
  const top = h.post("TOP", u1, 10, { replyCount: n });
  const replies = Array.from({ length: n }, (_, i) => h.post("R" + (i + 1), R, 11 + i, { replyTo: top }));
  return { timeline: [h.item(top)], posts: Object.fromEntries([top, ...replies].map(x => [x.uri, x])), ...extra };
};
const openReplies = async page => {
  const btn = page.article("TOP").querySelector('[data-act="replies"]');
  assert.ok(btn, "the reply button is a toggle");
  btn.click();
  await h.waitFor(() => page.article("TOP").querySelector(".replies"), { message: "the replies" });
  return page.article("TOP").querySelector(".replies");
};

test("the reply button unfolds the replies under the post", async () => {
  const page = await h.loadPage({ server: withReplies(3) });
  await page.startDate(h.BASE);
  const box = await openReplies(page);
  assert.deepEqual([...box.querySelectorAll(".pv")].map(el => el.textContent.match(/post (R\d+)/)[1]),
    ["R1", "R2", "R3"], "oldest first, like the catch-up itself");
  const req = page.requests.find(r => r.nsid === "app.bsky.feed.getPostThread");
  assert.equal(req.search.get("depth"), "1", "direct replies only");
  assert.equal(req.search.get("parentHeight"), "0", "and no ancestors, which are already on screen");
});

test("pressing it again folds them away", async () => {
  const page = await h.loadPage({ server: withReplies(2) });
  await page.startDate(h.BASE);
  await openReplies(page);
  page.article("TOP").querySelector('[data-act="replies"]').click();
  assert.ok(!page.article("TOP").querySelector(".replies"), "folded away");
  assert.equal(page.eval("state.openReplies.size"), 0, "and the page knows it is shut");
});

test("only a batch is drawn, and the rest come without another request", async () => {
  const page = await h.loadPage({ settings: { repliesShown: 4 }, server: withReplies(10) });
  await page.startDate(h.BASE);
  const box = await openReplies(page);
  assert.equal(box.querySelectorAll(".pv").length, 4, "the cap is honoured");
  assert.match(box.querySelector(".more-replies").textContent, /6 more replies/);

  const before = page.calls.filter(c => c === "app.bsky.feed.getPostThread").length;
  box.querySelector(".more-replies").click();
  assert.equal(page.article("TOP").querySelector(".replies").querySelectorAll(".pv").length, 8, "another batch");
  assert.equal(page.calls.filter(c => c === "app.bsky.feed.getPostThread").length, before,
    "from the answer already in hand, with no second request");

  page.article("TOP").querySelector(".more-replies").click();
  const box3 = page.article("TOP").querySelector(".replies");
  assert.equal(box3.querySelectorAll(".pv").length, 10, "and the last of them");
  assert.ok(!box3.querySelector(".more-replies"), "with the button gone");
});

test("a reply's own replies unfold under it, one request each", async () => {
  const top = h.post("TOP", u1, 10, { replyCount: 1 });
  const mid = h.post("MID", R, 11, { replyTo: top, replyCount: 1 });
  const deep = h.post("DEEP", u1, 12, { replyTo: mid });
  const page = await h.loadPage({ server: { timeline: [h.item(top)], posts: Object.fromEntries([top, mid, deep].map(x => [x.uri, x])) } });
  await page.startDate(h.BASE);
  const box = await openReplies(page);

  const midBtn = box.querySelector('.pv[data-uri$="MID"] [data-act="replies"]');
  assert.ok(midBtn, "a reply carries the same button");
  midBtn.click();
  await h.waitFor(() => box.querySelector(".replies"), { message: "the nested replies" });
  assert.match(box.querySelector(".replies").textContent, /post DEEP/);
  assert.equal(page.calls.filter(c => c === "app.bsky.feed.getPostThread").length, 2,
    "one request per level, asked for only when opened");
});

test("gaps in a thread are named rather than silently dropped", async () => {
  const top = h.post("TOP", u1, 10, { replyCount: 3 });
  const ok = h.post("R1", R, 11, { replyTo: top });
  const page = await h.loadPage({ server: {
    timeline: [h.item(top)], posts: Object.fromEntries([top, ok].map(x => [x.uri, x])),
    threadReplies: { [top.uri]: [
      ok,
      { $type: "app.bsky.feed.defs#blockedPost", uri: "at://x/app.bsky.feed.post/b", blocked: true },
      { $type: "app.bsky.feed.defs#notFoundPost", uri: "at://x/app.bsky.feed.post/n", notFound: true },
    ] },
  } });
  await page.startDate(h.BASE);
  const box = await openReplies(page);
  assert.equal(box.querySelectorAll(".pv").length, 1, "the one real reply");
  const notes = [...box.querySelectorAll(".reply-note")].map(n => n.textContent);
  assert.equal(notes.length, 2, "and a line for each gap");
  assert.ok(notes.some(t => /blocked/i.test(t)) && notes.some(t => /deleted/i.test(t)));
});

test("a post with no replies still opens, because that is where you reply", async () => {
  // Until replies could be written here, a post nobody had answered kept a
  // plain link out. Now that box is the way to answer, so the one kind of
  // post you most want to reply to must be able to open it.
  const page = await h.loadPage({ server: { timeline: [h.item(h.post("TOP", u1, 10))] } });
  await page.startDate(h.BASE);
  assert.ok(page.article("TOP").querySelector('[data-act="replies"]'), "the toggle is there");
  const box = await openReplies(page);
  assert.match(box.textContent, /No replies yet/);
  assert.ok(box.querySelector('[data-act="reply-to"]'), "and the way to write one");
});

/* Replies are found with getPostThread, which only an AppView can answer, so
   that mode keeps the link out. Asked of the builder directly and both ways
   round: an earlier version of this test went through the feed and wrapped
   its assertions in "if the post rendered", which in protocol mode it didn't
   -- so the test passed while checking nothing, and sabotage.py caught it. */
const fakePost = `{ uri: "at://did:plc:u1/app.bsky.feed.post/abc", author: { handle: "u1.test", did: "did:plc:u1" } }`;
const replyBtn = page => page.eval(`repliesBtnHtml(${fakePost}, { replyCount: 5 }, n => String(n))`);

test("in protocol mode the reply button stays a link out", async () => {
  const page = await h.loadPage({ settings: { protocolOnly: true }, server: withReplies(3) });
  const html = replyBtn(page);
  assert.match(html, /^<a /, "a link out, not a toggle");
  assert.ok(!/data-act="replies"/.test(html), "and nothing to press for replies");
});

test("with an AppView in use the same post gets the toggle", async () => {
  const page = await h.loadPage({ server: withReplies(3) });
  const html = replyBtn(page);
  assert.match(html, /data-act="replies"/, "the toggle is offered");
  assert.ok(!/^<a /.test(html), "and it is no longer a link");
});

test("replies that won't load say so and leave the post alone", async () => {
  const page = await h.loadPage({ server: withReplies(2, {
    handlers: { "app.bsky.feed.getPostThread": () => ({ status: 500, error: "InternalServerError", message: "nope" }) },
  }) });
  await page.startDate(h.BASE);
  page.article("TOP").querySelector('[data-act="replies"]').click();
  await h.waitFor(() => page.$("#toast") && !page.$("#toast").classList.contains("hidden"), { timeout: 8000, message: "the toast" });
  assert.match(page.$("#toast").textContent, /Couldn't load the replies/);
  assert.ok(!page.article("TOP").querySelector(".replies"), "nothing was opened");
  assert.ok(!page.article("TOP").querySelector('[data-act="replies"]').disabled, "and the button works again");
});

test("folding away and reopening doesn't ask the server again", async () => {
  // The replies for a post are kept once fetched: one answer holds all of
  // them, so reopening is a redraw, not a request.
  const page = await h.loadPage({ server: withReplies(3) });
  await page.startDate(h.BASE);
  await openReplies(page);
  const once = page.calls.filter(c => c === "app.bsky.feed.getPostThread").length;
  assert.equal(once, 1, "one request to open it");

  page.article("TOP").querySelector('[data-act="replies"]').click();   // fold
  assert.ok(!page.article("TOP").querySelector(".replies"), "folded");
  await openReplies(page);                                              // and open again
  assert.equal(page.calls.filter(c => c === "app.bsky.feed.getPostThread").length, once,
    "reopening used what was already fetched");
});

/* A quoted post carries its own action bar, including its own reply button.
   Its markup is a .quote, not a .pv (see quoteHtml), so finding "the post
   this button belongs to" by .pv walked straight past it to the post doing
   the quoting -- which fetched the wrong post's replies and hung them under
   the wrong card. Every other action finds its post with [data-uri]; this
   one has to as well. */
test("the reply button on a QUOTED post opens that post's replies", async () => {
  const inner = h.post("INNER", u2, 5, { replyCount: 2 });
  const innerReply = h.post("IR1", u3, 6, { replyTo: inner });
  const outer = h.post("OUTER", u1, 10, { embed: h.embeds.quote(inner), replyCount: 0 });
  const page = await h.loadPage({ server: {
    timeline: [h.item(outer)],
    posts: Object.fromEntries([outer, inner, innerReply].map(x => [x.uri, x])),
  } });
  await page.startDate(h.BASE);

  const art = page.article("OUTER");
  const quote = art.querySelector(`.quote[data-uri="${inner.uri}"]`);
  assert.ok(quote, "the quoted post is on screen");
  quote.querySelector('[data-act="replies"]').click();
  await h.waitFor(() => quote.querySelector(":scope > .replies"), { message: "the quoted post's replies" });

  // Asked about the QUOTED post, not the one quoting it.
  const req = page.requests.find(r => r.nsid === "app.bsky.feed.getPostThread");
  assert.equal(req.search.get("uri"), inner.uri, "asked for the quoted post");

  // And landed inside the quote, not under the outer post.
  const box = quote.querySelector(":scope > .replies");
  assert.match(box.textContent, /post IR1/, "showing the quoted post's reply");
  assert.ok(!art.querySelector(":scope > .pv > .replies"), "and nothing was hung under the quoting post");
  assert.ok(page.eval(`state.openReplies.has(${JSON.stringify(inner.uri)})`), "the quoted post is the one marked open");
});

test("replying from a quoted post answers that post", async () => {
  const inner = h.post("INNER", u2, 5);
  const outer = h.post("OUTER", u1, 10, { embed: h.embeds.quote(inner) });
  const page = await h.loadPage({ server: {
    timeline: [h.item(outer)],
    posts: Object.fromEntries([outer, inner].map(x => [x.uri, x])),
  } });
  await page.startDate(h.BASE);
  const quote = page.article("OUTER").querySelector(`.quote[data-uri="${inner.uri}"]`);
  quote.querySelector('[data-act="replies"]').click();
  await h.waitFor(() => quote.querySelector('[data-act="reply-to"]'), { message: "the reply button" });
  quote.querySelector('[data-act="reply-to"]').click();
  await h.waitFor(() => page.visible("composer"), { message: "the composer" });
  assert.equal(page.eval("composing.reply.parent.uri"), inner.uri, "answers the quoted post");
});
