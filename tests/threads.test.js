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

test("a gap between the thread's first post and the parent links to the full thread", async () => {
  const M = h.post("M", s, 31, { replyTo: S });
  const P = h.post("P", u1, 33, { replyTo: M });
  const Q = h.post("Q", u1, 34, { replyTo: P });
  const page = await h.loadPage({ settings: { dayDividers: false, hourDividers: false }, server: { follows: [u1], timeline: [
    h.item(Q, { parent: P, root: S }), h.item(h.post("OLD", u1, -300)),
  ] } });
  await page.startDate(h.BASE);
  const card = page.article("Q");
  assert.deepEqual([...card.querySelectorAll(".pv.parent .pv-text")].map(x => x.textContent), ["post S", "post P"]);
  assert.match(card.querySelector(".thread-gap").getAttribute("href"), /\/post\/P$/);
});

test("'Just Replying to @name' doesn't add thread context", async () => {
  const page = await h.loadPage({ settings: { replyContext: "none", dayDividers: false, hourDividers: false }, server: deepServer });
  await page.startDate(h.BASE);
  assert.equal(page.article("R2").querySelectorAll(".pv.parent, .parent-mini").length, 0);
});
