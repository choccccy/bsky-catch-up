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
    return g.querySelector(".group-sum")?.textContent || null;   // empty = nothing changed
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

test("how many videos to preload by default follows the device", async () => {
  // A cheap phone shouldn't start by buffering three HLS streams. The setting
  // still overrides this; only the starting value is decided here.
  const page = await h.loadPage({});
  const w = page.window;
  const forDevice = (deviceMemory, hardwareConcurrency) => {
    Object.defineProperty(w.navigator, "deviceMemory", { value: deviceMemory, configurable: true });
    Object.defineProperty(w.navigator, "hardwareConcurrency", { value: hardwareConcurrency, configurable: true });
    return w.defaultPreloadVideos();
  };
  assert.equal(forDevice(32, 10), 3, "desktop");
  assert.equal(forDevice(4, 8), 1, "little memory");
  assert.equal(forDevice(8, 4), 1, "few cores");
  assert.equal(forDevice(undefined, undefined), 3, "a browser that won't say: assume a desktop");
});

test("each setting you've changed is marked, and the marks keep up", async () => {
  const page = await h.loadPage({ settings: { theme: "dark" } });
  page.window.openDrawer();
  const marked = () => page.$$("#drawer .set.changed").map(r => r.dataset.row).sort();
  const badge = name => {
    const g = page.$$("#drawer details.group").find(x => x.querySelector("summary").textContent.startsWith(name));
    return g.querySelector(".group-sum").textContent || null;
  };
  // fetchMethod and rpm come from the harness's own settings, theme from here.
  assert.deepEqual(marked(), ["fetchMethod", "rpm", "theme"]);
  assert.equal(page.$('[data-row="theme"]').title, "Changed from the default");

  // Changing another one marks it immediately, without reopening the drawer.
  await page.setSetting("hourDividers", false);
  assert.deepEqual(marked(), ["fetchMethod", "hourDividers", "rpm", "theme"]);
  assert.equal(badge("Appearance"), "2 changed");

  // Putting one back clears its mark and the count with it.
  await page.setSetting("theme", "system");
  assert.deepEqual(marked(), ["fetchMethod", "hourDividers", "rpm"]);
  assert.equal(badge("Appearance"), "1 changed");
  assert.equal(page.$('[data-row="theme"]').title, "");
});

test("no JavaScript-style escape sequences leak into the markup", async () => {
  // A \uXXXX escape means something inside a JS string, and nothing at all in
  // HTML text or an attribute, where it shows up literally on screen. 0.14.0
  // shipped one to the start screen ("where “from a date”"), so
  // guard the markup region: everything before <script> is HTML and CSS.
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const markup = src.slice(0, src.indexOf('<script>\n"use strict"'));
  const found = [...markup.matchAll(/\\u[0-9a-fA-F]{4}/g)].map(m => {
    const line = markup.slice(0, m.index).split("\n").length;
    return `line ${line}: ${m[0]}`;
  });
  assert.deepEqual(found, [], "use the real character in markup, not an escape");
});

test("the page tells the browser which way it is shaded", async () => {
  // Without color-scheme, the controls the browser draws itself (number
  // spinners, the date picker, dropdowns, scrollbars) stay light on a dark
  // page: a white box with our light text in it, unreadable.
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const css = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  const darkBlocks = [...css.matchAll(/(:root\[data-theme="dark"\]|:root:not\(\[data-theme="light"\]\))\s*\{([^}]*)\}/g)];
  assert.ok(darkBlocks.length >= 2, "both ways of being dark are covered");
  for (const [, sel, body] of darkBlocks) {
    assert.match(body, /color-scheme\s*:\s*dark/, `${sel} must set color-scheme`);
  }
  assert.match(css, /:root\{[^}]*color-scheme\s*:\s*light/s, "the light palette sets it too");
});

test("every text-like field in the start form is actually styled", async () => {
  // An input type that no rule matches falls back to the browser's own white
  // box, which is how the recent-posts count became unreadable in 0.14.0.
  // Checked against the stylesheet text, not getComputedStyle: jsdom doesn't
  // resolve var() or the cascade, so a DOM check here passes either way.
  const page = await h.loadPage({});
  const src = require("fs").readFileSync(h.PAGE_PATH, "utf8");
  const css = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  // Only a rule that actually paints a background counts: a .field rule that
  // just sets a width leaves the browser's own white box showing through.
  const covered = new Set();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/background/.test(body)) continue;
    for (const m of selector.matchAll(/\.field input\[type=([a-z-]+)\]/g)) covered.add(m[1]);
  }
  for (const el of page.$$("#startForm input")) {
    if (["radio", "checkbox"].includes(el.type)) continue;
    const inline = /background/.test(el.getAttribute("style") || "");
    assert.ok(covered.has(el.type) || inline,
      `#${el.id} is type=${el.type}, which no .field rule covers and which has no inline background`);
  }
});
