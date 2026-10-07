"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const a = h.actor(1);
const server = { timeline: [h.item(h.post("A", a, 5)), h.item(h.post("B", a, 70)), h.item(h.post("OLD", a, -300))] };

test("old full-object saved settings are migrated once", async () => {
  // Pre-0.2.2 saves had no _v and stored every value, including old defaults.
  const page = await h.loadPage({ settings: null, storage: { settings: { showParent: false, hourDividers: false, fontSize: 18 } } });
  assert.equal(page.eval("settings.hourDividers"), true, "old default dropped, new default applies");
  assert.equal(page.eval("settings.replyContext"), "none", "showParent:false carried over");
  assert.equal(page.eval("settings.fontSize"), 18, "real choices kept");
  assert.deepEqual(page.saved(), { _v: 2, fontSize: 18, replyContext: "none" });
});

test("only non-default settings are saved", async () => {
  const page = await h.loadPage();
  await page.setSetting("showCounts", false);
  const saved = page.saved();
  assert.equal(saved.showCounts, false);
  assert.ok(!("dayDividers" in saved));
});

test("display settings apply immediately while reading", async () => {
  const page = await h.loadPage({ server });
  await page.startDate(h.BASE);
  assert.ok(page.$$(".hour").length >= 2, "hour dividers on by default");
  await page.setSetting("hourDividers", false);
  assert.equal(page.$$(".hour").length, 0);
  await page.setSetting("hourDividers", true);
  assert.ok(page.$$(".hour").length >= 2);
  await page.setSetting("dayDividers", false);
  assert.equal(page.$$(".day").length, 0);
});

test("every schema setting has a default and a drawer control", async () => {
  const page = await h.loadPage();
  page.$("#btnSettings").click();
  const keys = page.eval("SETTINGS_SCHEMA.filter(s => s.key).map(s => s.key)");
  for (const k of keys) {
    assert.ok(page.eval(`"${k}" in DEFAULTS`), `${k} has a default`);
    assert.ok(page.$(`#drawer [data-k="${k}"]`), `${k} has a control`);
  }
});

test("request-tuning settings are not shareable", async () => {
  const page = await h.loadPage();
  for (const k of ["rpm", "concurrency", "batchSize", "trackPosition"]) {
    assert.equal(page.eval(`linkable(SETTINGS_SCHEMA.find(s => s.key === "${k}"))`), false, k);
  }
});

test("the drawer opens with every group collapsed", async () => {
  const page = await h.loadPage({});
  page.window.openDrawer();
  const groups = page.$$("#drawer details.group");
  assert.ok(groups.length >= 5, "the groups are rendered as collapsible sections");
  assert.deepEqual(groups.map(g => g.open), groups.map(() => false), "all start closed");
  // Every setting lives inside a group, so nothing is stranded outside one.
  const rows = page.$$("#drawer .set");
  assert.ok(rows.length > 20);
  for (const r of rows) assert.ok(r.closest("details.group"), `${r.dataset.row || "a row"} is outside a group`);
});

test("a group says how many of its settings you've changed", async () => {
  const page = await h.loadPage({ settings: { hourDividers: false, theme: "dark" } });
  page.window.openDrawer();
  const badge = name => {
    const g = page.$$("#drawer details.group").find(x => x.querySelector("summary").textContent.startsWith(name));
    return g.querySelector(".group-sum")?.textContent ?? null;
  };
  assert.equal(badge("Appearance"), "2 changed", "theme and hourDividers both live here");
  assert.equal(badge("What's in the feed"), null, "untouched groups say nothing");
  // The harness itself loads with fetchMethod "timeline" (not the default
  // "auto"), so this group is legitimately marked -- which is the badge
  // doing its job, not a stray.
  assert.equal(badge("Catching up"), "1 changed");
});

test("sub-settings are marked off while their parent setting doesn't apply", async () => {
  const page = await h.loadPage({ settings: { wholeImages: "app" } });
  page.window.openDrawer();
  const subs = page.$$("#drawer .set.sub-set");
  assert.ok(subs.length >= 4);
  for (const r of subs) {
    assert.ok(r.classList.contains("off"), `${r.dataset.row} should be marked off`);
    assert.ok(r.querySelector("[data-k]").disabled, `${r.dataset.row} should be disabled`);
  }
  await page.setSetting("wholeImages", "whole");
  for (const r of page.$$("#drawer .set.sub-set")) {
    assert.ok(!r.classList.contains("off"), `${r.dataset.row} should be live now`);
    assert.ok(!r.querySelector("[data-k]").disabled);
  }
});
