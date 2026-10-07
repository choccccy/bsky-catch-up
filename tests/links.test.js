"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const a = h.actor(1);
const server = { timeline: [
  h.item(h.post("A", a, 10)),
  h.item(h.post("G", a, 12, { embed: h.embeds.gallery(5) })),
  h.item(h.post("B", a, 20)),
  h.item(h.post("OLD", a, -300)),
] };
const url = frag => `https://site.example/catchup/index.html#${frag}`;
const from = h.iso(h.BASE);

test("a #from link opens straight into that catch-up", async () => {
  const page = await h.loadPage({ url: url(`from=${from}`), server });
  await page.settle();
  assert.deepEqual(page.ids(), ["A", "G", "B"]);
  assert.match(page.window.location.hash, /v=1/, "address rewritten with the link format");
});

test("from/to accept dates, unix time and post links", async () => {
  const page = await h.loadPage({ url: url(`from=${Math.floor(h.BASE / 1000)}&to=https://bsky.app/profile/u1.test/post/G`), server });
  await page.settle();
  assert.deepEqual(page.ids(), ["A", "G"]);
});

test("an unreadable link shows an error on the start screen", async () => {
  const page = await h.loadPage({ url: url("from=not-a-date"), server });
  assert.match(page.$("#startErr").textContent, /couldn't be read/);
});

test("signed-out visitors sign in first, then the link opens", async () => {
  const page = await h.loadPage({ session: false, url: url(`from=${from}`), server });
  assert.ok(page.visible("viewLogin"));
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "x"; page.$("#btnLogin").click();
  await h.waitFor(() => page.visible("viewFeed"), { message: "feed" });
  assert.deepEqual(page.ids(), ["A", "G", "B"]);
});

test("link settings apply for the visit only, until kept", async () => {
  const page = await h.loadPage({ url: url(`from=${from}&s.onlyTypes=gallery&s.bogus=1&s.rpm=60`), server });
  await page.settle();
  assert.deepEqual(page.ids(), ["G"]);
  assert.match(page.$("#linkSettingsNote").textContent, /Only show posts with/);
  assert.match(page.$("#linkSettingsNote").textContent, /bogus, rpm/, "unknown and non-shareable settings are listed as ignored");
  assert.ok(!("onlyTypes" in page.saved()), "not saved yet");
  assert.match(page.window.location.hash, /s\.onlyTypes=gallery/, "kept in the address while applied");
  page.$("#btnKeepLinkSettings").click();
  assert.deepEqual(page.saved().onlyTypes, ["gallery"]);
  assert.ok(!page.window.location.hash.includes("s."));
});

test("'use my own settings' undoes link settings", async () => {
  const page = await h.loadPage({ url: url(`from=${from}&s.onlyTypes=gallery`), server });
  await page.settle();
  page.$("#btnDropLinkSettings").click();
  await h.wait(30);
  assert.deepEqual(page.ids(), ["A", "G", "B"]);
  assert.ok(!("onlyTypes" in page.saved()));
});

test("changing a link-provided setting by hand makes it your own", async () => {
  const page = await h.loadPage({ url: url(`from=${from}&s.onlyTypes=gallery&s.hourDividers=0`), server });
  await page.settle();
  await page.setSetting("hourDividers", true);
  assert.equal(page.saved().hourDividers, undefined, "true is the default, so nothing saved");
  assert.ok(!("onlyTypes" in page.saved()), "other link settings still temporary");
  assert.deepEqual(page.json("Object.keys(linkOverrides)"), ["onlyTypes"]);
});

test("copied links use the current address and include changed shareable settings", async () => {
  const page = await h.loadPage({ url: url(`from=${from}`), settings: { rpm: 999 }, server });
  await page.settle();
  await page.setSetting("replyContext", "moveUp");
  page.$("#btnCopyCatchupSettings").click(); await h.wait(20);
  const copied = page.clip.at(-1);
  assert.ok(copied.startsWith("https://site.example/catchup/index.html#from="));
  assert.match(copied, /&v=1/);
  assert.match(copied, /s\.replyContext=moveUp/);
  assert.match(copied, /s\.fetchMethod=timeline/);
  assert.ok(!copied.includes("rpm"), "request tuning is never shared");
  page.$("#btnCopyCatchup").click(); await h.wait(20);
  assert.ok(!page.clip.at(-1).includes("s."), "plain link has no settings");
});

test("renamed settings and values in old links are translated", async () => {
  const page = await h.loadPage({ url: url(`from=${from}`), server });
  await page.settle();
  page.eval(`LINK_ALIASES.keys.mediaOnly = "onlyTypes"; LINK_ALIASES.values.onlyTypes = { pics: "gallery" };`);
  page.window.location.hash = `from=${from}&v=1&s.mediaOnly=pics`;
  await h.wait(50); await page.settle();
  assert.deepEqual(page.json("settings.onlyTypes"), ["gallery"]);
});

test("older-format links get the defaults of their time for omitted settings", async () => {
  const page = await h.loadPage({ url: url(`from=${from}`), server });
  await page.settle();
  page.eval("LINK_FORMAT_DEFAULTS[0].hourDividers = false;");
  page.window.location.hash = `from=${from}&s.onlyTypes=gallery`;   // no v: format 0
  await h.wait(50); await page.settle();
  assert.equal(page.eval("settings.hourDividers"), false);
});

test("older-format links without settings don't impose old defaults", async () => {
  const page = await h.loadPage({ url: url(`from=${from}`), server });
  await page.settle();
  page.eval("LINK_FORMAT_DEFAULTS[0].hourDividers = false;");
  page.window.location.hash = `from=${h.iso(h.BASE + 60e3)}`;
  await h.wait(50); await page.settle();
  assert.equal(page.eval("settings.hourDividers"), true);
});

test("links from a newer page version show a notice", async () => {
  const page = await h.loadPage({ url: url(`from=${from}&v=99&s.onlyTypes=gallery`), server });
  assert.match(page.$("#bannerText").textContent, /newer version/);
});
