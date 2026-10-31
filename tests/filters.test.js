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
const FEED2 = "at://did:plc:owner/app.bsky.feed.generator/discover";
/** A page whose account has one saved feed, holding `items`. */
const withFeed = (items, extra = {}) => ({
  savedFeeds: [{ id: "1", type: "feed", value: FEED, pinned: true }],
  feedNames: { [FEED]: "For You" },
  feeds: { [FEED]: items },
  ...extra,
});
/** Two saved feeds, each holding its own copy of `items`. */
const withTwoFeeds = (items, extra = {}) => ({
  timeline: [h.item(h.post("TL", h.actor(1), 10))],
  savedFeeds: [{ id: "1", type: "feed", value: FEED, pinned: true },
               { id: "2", type: "feed", value: FEED2, pinned: true }],
  feedNames: { [FEED]: "For You", [FEED2]: "Discover" },
  feeds: { [FEED]: items, [FEED2]: items },
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

/* ---------- ...remembered for each feed (settings.hideFollowedBy) ----------
   The value is per feed: every feed it has been set on keeps its own, and a
   feed it has never been set on follows whatever was chosen last. Which is
   what makes switching between Following and For You cost nothing either
   way. See hideFollowedFor. */

test("a feed keeps the value set on it, and the other feed is left alone", async () => {
  const page = await h.loadPage({ server: withTwoFeeds(mixedFeed()) });

  await page.startDate(h.BASE, null, { feed: FEED });
  await page.setSetting("hideFollowed", "all");
  assert.deepEqual(page.ids(), ["NEW"], "on for For You");
  assert.equal(page.saved().hideFollowedBy[FEED], "all", "remembered against that feed");

  // Discover has never been set, so it follows the last choice.
  await page.startDate(h.BASE, null, { feed: FEED2 });
  assert.deepEqual(page.ids(), ["NEW"], "a feed never set follows the latest choice");

  // Turning it off here is about Discover, not about everything.
  await page.setSetting("hideFollowed", "off");
  assert.deepEqual(page.ids(), ["MINE", "NEW", "SHARED"]);
  assert.equal(page.saved().hideFollowedBy[FEED2], "off");
  assert.equal(page.saved().hideFollowedBy[FEED], "all", "For You is untouched");

  // ...and For You still hides them when you come back to it, with nothing set.
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.deepEqual(page.ids(), ["NEW"], "For You is still as it was left");
});

test("a feed's own value survives a reload", async () => {
  const first = await h.loadPage({ server: withTwoFeeds(mixedFeed()) });
  await first.startDate(h.BASE, null, { feed: FEED });
  await first.setSetting("hideFollowed", "posts");
  const stored = first.saved();

  const again = await h.loadPage({ settings: stored, server: withTwoFeeds(mixedFeed()) });
  await again.startDate(h.BASE, null, { feed: FEED });
  assert.deepEqual(again.ids(), ["NEW", "SHARED"]);
});

test("the Following feed never records a value of its own", async () => {
  const page = await h.loadPage({ server: withFeed(mixedFeed(), { timeline: [h.item(h.post("TL", a, 10))] }) });
  await page.startDate(h.BASE);                       // the Following feed
  // The drawer's control is disabled here, so this is the saved-settings and
  // shared-link route arriving at the same place: nothing to store, because
  // the filter has never applied to the timeline.
  await page.setSetting("hideFollowed", "all");
  assert.deepEqual(page.ids(), ["TL"], "every post is still shown");
  assert.ok(!page.saved()?.hideFollowedBy, "and no feed value was written");
});

test("a catch-up link's value outranks what that feed remembers", async () => {
  const base = await h.loadPage({ server: withFeed(mixedFeed()) });
  await base.startDate(h.BASE, null, { feed: FEED });
  await base.setSetting("hideFollowed", "off");
  const stored = base.saved();
  assert.equal(stored.hideFollowedBy[FEED], "off");

  // The link says "all" about the feed it names, and wins for the visit.
  const linked = await h.loadPage({
    settings: stored,
    url: "https://example.test/#from=" + new Date(h.BASE).toISOString()
       + "&feed=" + encodeURIComponent(FEED) + "&s.hideFollowed=all&v=3",
    server: withFeed(mixedFeed()),
  });
  await h.waitFor(() => linked.visible("viewFeed"), { message: "the linked catch-up" });
  assert.deepEqual(linked.ids(), ["NEW"], "the link's value is the one applied");

  // Changing it by hand is the visitor's own choice again: it leaves the
  // overlay, so the link stops outranking the feed's value.
  await linked.setSetting("hideFollowed", "posts");
  await h.waitFor(() => linked.ids().length === 2, { message: "the hand-made choice to apply" });
  assert.deepEqual(linked.ids(), ["NEW", "SHARED"]);
  assert.equal(linked.saved().hideFollowedBy[FEED], "posts");
});

test("the follow list is fetched when only this feed's own value turns it on", async () => {
  // The guard for startCatchup's needFollows: it has to ask about the feed it
  // is starting, not the bare setting, or the filter runs with no follow list
  // and quietly hides nothing.
  const first = await h.loadPage({ settings: { replies: "all" }, server: withTwoFeeds(mixedFeed()) });
  await first.startDate(h.BASE, null, { feed: FEED });
  await first.setSetting("hideFollowed", "posts");
  await first.startDate(h.BASE, null, { feed: FEED2 });
  await first.setSetting("hideFollowed", "off");       // the fallback is now "off"
  const stored = first.saved();
  assert.equal(first.json("settings.hideFollowed"), "off", "the last choice was off");
  assert.ok(!("hideFollowed" in stored), "which is the default, so it isn't stored at all");
  assert.equal(stored.hideFollowedBy[FEED], "posts", "but For You remembers posts");

  const page = await h.loadPage({ settings: stored, server: withTwoFeeds(mixedFeed()) });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.ok(page.calls.some(c => c.includes("getFollows")), "fetched before the feed was built");
  assert.deepEqual(page.ids(), ["NEW", "SHARED"], "and the filter had a list to work from");
});

test("the drawer shows the value for the feed picked on the start screen", async () => {
  const page = await h.loadPage({ server: withTwoFeeds(mixedFeed(), { timeline: [h.item(h.post("TL", a, 10))] }) });
  const ctl = () => page.$('#drawer [data-row="hideFollowed"] [data-k]');
  const row = () => page.$('#drawer [data-row="hideFollowed"]');

  await page.startDate(h.BASE, null, { feed: FEED });
  await page.setSetting("hideFollowed", "all");
  page.$("#btnNew").click();
  await h.wait(20);
  page.$("#btnSettings").click();

  // Still on For You from the picker's point of view.
  assert.equal(ctl().value, "all", "For You's own value");
  page.$("#inFeed").value = "";                        // Following
  page.$("#inFeed").dispatchEvent(new page.window.Event("change"));
  await h.wait(20);
  assert.ok(row().classList.contains("off"), "greyed out for Following");
  assert.equal(ctl().value, "off", "and shown as off, not as For You's value");

  page.$("#inFeed").value = FEED2;                     // Discover, never set
  page.$("#inFeed").dispatchEvent(new page.window.Event("change"));
  await h.wait(20);
  assert.ok(!row().classList.contains("off"));
  assert.equal(ctl().value, "all", "a feed never set follows the latest choice");
});

test("only the most recent feeds are remembered", async () => {
  const page = await h.loadPage({ server: withFeed(mixedFeed()) });
  await page.startDate(h.BASE, null, { feed: FEED });
  const cap = page.json("HIDE_FOLLOWED_MEMORY");
  page.$("#btnNew").click();                           // back to the picker
  await h.wait(20);
  // Fill past the cap directly: driving 100+ feeds through the picker would
  // test the picker, not the cap.
  page.window.eval(`(() => {
    for (let i = 0; i < ${cap} + 5; i++) {
      chosenFeed = { kind: "feed", uri: "at://did:plc:owner/app.bsky.feed.generator/f" + i, name: "f" + i };
      setHideFollowed("posts");
    }
  })()`);
  const by = page.json("settings.hideFollowedBy");
  const keys = Object.keys(by);
  assert.equal(keys.length, cap, "the map is capped");
  assert.ok(keys.at(-1).endsWith("/f" + (cap + 4)), "the newest is kept");
  assert.ok(!(FEED in by), "and the oldest fell off the end");
});

test("a feed that is all accounts you follow says so rather than counting", async () => {
  const allFollowed = [h.item(h.post("MINE", a, 10)), h.item(h.post("ALSO", h.actor(2), 11))];
  const page = await h.loadPage({ settings: { hideFollowed: "posts" }, server: withFeed(allFollowed) });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.deepEqual(page.ids(), [], "the page is empty");
  const note = page.$("#followNote");
  assert.ok(!note.classList.contains("hidden"));
  assert.match(note.textContent, /Everything on this feed is from accounts you follow/i);
  assert.match(note.textContent, /all 2 posts are hidden/i);
  note.querySelector("[data-note-btn]").click();
  await h.wait(30);
  assert.deepEqual(page.ids(), ["MINE", "ALSO"], "and the button brings them back");
});

test("picking Following after reading a custom feed goes back to Following", async () => {
  // The picker's "Following" is the absence of a feed, so it has to mean the
  // timeline rather than "whatever was read last" -- otherwise there is no way
  // back, and the filter stays in force on a feed you have left.
  const page = await h.loadPage({ settings: { hideFollowed: "all" }, server: withTwoFeeds(mixedFeed()) });
  await page.startDate(h.BASE, null, { feed: FEED });
  assert.deepEqual(page.ids(), ["NEW"], "the filter applies on the custom feed");

  page.$("#btnNew").click(); await h.wait(20);
  page.$("#inFeed").value = "";
  page.$("#inFeed").dispatchEvent(new page.window.Event("change"));
  await page.startDate(h.BASE);
  assert.deepEqual(page.ids(), ["TL"], "the Following feed is what was read");
  assert.equal(page.json("state.run.feed.kind"), "timeline");
  assert.ok(page.$("#followNote").classList.contains("hidden"), "and the filter is not in force");
});

test("a shared link carries the value the feed being read is using", async () => {
  const page = await h.loadPage({ server: withTwoFeeds(mixedFeed()) });
  await page.startDate(h.BASE, null, { feed: FEED });
  await page.setSetting("hideFollowed", "all");
  await page.startDate(h.BASE, null, { feed: FEED2 });
  await page.setSetting("hideFollowed", "off");         // the fallback moves on

  // Back on For You, the link has to say what For You is actually doing.
  await page.startDate(h.BASE, null, { feed: FEED });
  page.$("#btnCopyCatchupSettings").click();
  await h.wait(30);
  assert.match(page.clip.at(-1), /s\.hideFollowed=all/, "the feed's own value, not the fallback");

  // On Following it does nothing, so there is nothing to put in a link.
  // (The picker keeps its last feed, so Following has to be chosen in it.)
  page.$("#btnNew").click(); await h.wait(20);
  page.$("#inFeed").value = "";
  page.$("#inFeed").dispatchEvent(new page.window.Event("change"));
  await page.startDate(h.BASE);
  page.$("#btnCopyCatchupSettings").click();
  await h.wait(30);
  assert.ok(!page.clip.at(-1).includes("hideFollowed"), "nothing a Following link would use");
});
