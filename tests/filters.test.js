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
  page.$("#btnClearTypes").click();
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
