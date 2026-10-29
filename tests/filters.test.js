"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const a = h.actor(1);
const quoted = h.post("QQ", h.actor(9), -1000, { embed: h.embeds.gallery(5) });
const server = { timeline: [
  h.item(h.post("T", a, 10)),
  h.item(h.post("I", a, 11, { embed: h.embeds.images(2) })),
  h.item(h.post("G", a, 12, { embed: h.embeds.gallery(6) })),
  h.item(h.post("V", a, 13, { embed: h.embeds.video() })),
  h.item(h.post("L", a, 14, { embed: h.embeds.link() })),
  h.item(h.post("F", a, 15, { embed: h.embeds.gif() })),
  h.item(h.post("Q", a, 16, { embed: h.embeds.quote(quoted) })),
  h.item(h.post("GV", a, 17, { embed: h.embeds.gifVideo() })),
  h.item(h.post("OLD", a, -300)),
] };

const cases = {
  images: ["I"], gallery: ["G", "Q"], video: ["V"], link: ["L"], gif: ["F", "GV"], quote: ["Q"], text: ["T"],
};
for (const [kind, want] of Object.entries(cases)) {
  test(`only show posts with: ${kind}`, async () => {
    const page = await h.loadPage({ settings: { onlyTypes: [kind] }, server });
    await page.startDate(h.BASE);
    assert.deepEqual(page.ids(), want);
  });
}

test("the filter notice shows and can clear the filter", async () => {
  const page = await h.loadPage({ server });
  await page.startDate(h.BASE);
  await page.setSetting("onlyTypes", ["gallery", "video"]);
  assert.deepEqual(page.ids(), ["G", "V", "Q"]);
  assert.match(page.$("#filterNote").textContent, /galleries.*videos/i);
  page.$("#filterNote [data-note-btn]").click();
  await h.wait(30);
  assert.equal(page.ids().length, 8);
  assert.ok(page.$("#filterNote").classList.contains("hidden"));
  assert.ok(!("onlyTypes" in page.saved()));
});

test("an end point stops the feed; keep going continues to now", async () => {
  const page = await h.loadPage({ server });
  await page.startDate(h.BASE, { date: h.BASE + 13.5 * h.MIN });
  assert.deepEqual(page.ids(), ["T", "I", "G", "V"]);
  assert.match(page.$("#endcap").textContent, /reached your end point/);
  page.$("#btnPastEnd").click();
  await h.wait(30);
  assert.equal(page.ids().length, 8);
  assert.ok(!page.window.location.hash.includes("to="), "address drops the end");
});

test("an end post is included and ends the feed", async () => {
  const page = await h.loadPage({ server });
  await page.startDate(h.BASE, { post: "https://bsky.app/profile/u1.test/post/G" });
  assert.deepEqual(page.ids(), ["T", "I", "G"]);
});

test("an end before the start is rejected", async () => {
  const page = await h.loadPage({ server });
  await page.startDate(h.BASE, { date: h.BASE - 60 * h.MIN });
  assert.match(page.$("#startErr").textContent, /after the start point/);
});

/* ---------- "Hide people I follow" (settings.hideFollowed) ----------
   The harness's account follows actors 1-5, so actor 1 is "someone I follow"
   and actor 9 is a stranger. The filter only applies to a feed that can carry
   strangers, so these use a custom feed; the Following feed is where it must
   do nothing at all. */
const stranger = h.actor(9);
const FEED = "at://did:plc:owner/app.bsky.feed.generator/foryou";
/** A page whose account has one saved feed, holding `items`. */
const withFeed = (items, extra = {}) => ({
  savedFeeds: [{ id: "1", type: "feed", value: FEED, pinned: true }],
  feedNames: { [FEED]: "For You" },
  feeds: { [FEED]: items },
  ...extra,
});
/** One post from someone I follow, one from a stranger, and a stranger's post
 *  that someone I follow has shared. */
const mixedFeed = () => [
  h.item(h.post("MINE", a, 10)),
  h.item(h.post("NEW", stranger, 11)),
  h.item(h.post("SHARED", stranger, 12), { repostBy: h.actor(2), repostMin: 13 }),
];

for (const [mode, want] of Object.entries({
  off: ["MINE", "NEW", "SHARED"],
  posts: ["NEW", "SHARED"],
  all: ["NEW"],
})) {
  test(`hide people I follow: ${mode}`, async () => {
    const page = await h.loadPage({ settings: { hideFollowed: mode }, server: withFeed(mixedFeed()) });
    await page.startDate(h.BASE, null, { feed: FEED });
    assert.deepEqual(page.ids(), want);
  });
}

test("the follow filter is ignored on the Following feed, however it arrives", async () => {
  // Saved settings say "all", which on the timeline would hide everything.
  const page = await h.loadPage({ settings: { hideFollowed: "all" }, server });
  await page.startDate(h.BASE);
  assert.equal(page.ids().length, 8, "every post is still shown");
  assert.ok(page.$("#followNote").classList.contains("hidden"), "and no note claims otherwise");
  assert.equal(page.saved().hideFollowed, "all", "the setting is remembered, just not applied");

  // Same from a catch-up link, which is the other way it can arrive already on.
  const linked = await h.loadPage({
    url: "https://example.test/#from=" + new Date(h.BASE).toISOString() + "&s.hideFollowed=all&v=3",
    server,
  });
  await h.waitFor(() => linked.visible("viewFeed"), { message: "the linked catch-up" });
  assert.equal(linked.ids().length, 8);
});

test("the note says the follow filter is on, how much it hides, and turns it off", async () => {
  const page = await h.loadPage({ settings: { hideFollowed: "all" }, server: withFeed(mixedFeed()) });
  await page.startDate(h.BASE, null, { feed: FEED });
  const note = page.$("#followNote");
  assert.ok(!note.classList.contains("hidden"), "the note is shown");
  assert.match(note.textContent, /only accounts you don't follow/i);
  assert.match(note.textContent, /2 posts hidden/, "counts what it held back");
  note.querySelector("[data-note-btn]").click();
  await h.wait(30);
  assert.deepEqual(page.ids(), ["MINE", "NEW", "SHARED"], "everyone is back");
  assert.ok(note.classList.contains("hidden"));
  assert.ok(!("hideFollowed" in page.saved()), "and the setting is back to its default");
});

test("the drawer greys the follow filter out on Following and enables it on a feed", async () => {
  const page = await h.loadPage({ server: withFeed(mixedFeed(), { timeline: [h.item(h.post("TL", a, 10))] }) });
  const row = () => page.$('#drawer [data-row="hideFollowed"]');
  const why = () => page.$('#drawer [data-why="hideFollowed"]');

  await page.startDate(h.BASE);                       // the Following feed
  page.$("#btnSettings").click();
  assert.ok(row().classList.contains("off"), "dimmed on Following");
  assert.ok(row().querySelector("[data-k]").disabled, "and not settable");
  assert.ok(!why().classList.contains("hidden"), "with the reason shown");
  assert.match(why().textContent, /nothing but posts from people you follow/i);
  assert.ok(!row().classList.contains("sub-set"), "not indented: it doesn't depend on a setting");
  page.$("#btnCloseDrawer").click();

  await page.startDate(h.BASE, null, { feed: FEED }); // a custom feed
  page.$("#btnSettings").click();
  assert.ok(!row().classList.contains("off"), "available on a custom feed");
  assert.ok(!row().querySelector("[data-k]").disabled);
  assert.ok(why().classList.contains("hidden"), "and no reason to explain");
});

test("the follow list is loaded for the filter, at the start or on demand", async () => {
  // Replies set to "all" and a custom feed: the filter is the only thing that
  // needs the follow list, so its being fetched at all is the assertion.
  const page = await h.loadPage({
    settings: { replies: "all", hideFollowed: "posts" },
    server: withFeed(mixedFeed()),
  });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.ok(page.calls.some(c => c.includes("getFollows")), "fetched before the feed was built");
  assert.deepEqual(page.ids(), ["NEW", "SHARED"]);

  // Turned on halfway through, with no follow list in hand: it is fetched then.
  const later = await h.loadPage({ settings: { replies: "all" }, server: withFeed(mixedFeed()) });
  await later.startDate(h.BASE, null, { feed: FEED });
  assert.ok(!later.calls.some(c => c.includes("getFollows")), "nothing needed it yet");
  await later.setSetting("hideFollowed", "posts");
  await h.waitFor(() => later.ids().length === 2, { message: "the feed to drop the posts I follow" });
  assert.ok(later.calls.some(c => c.includes("getFollows")));
  assert.deepEqual(later.ids(), ["NEW", "SHARED"]);
});
