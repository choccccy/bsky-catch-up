"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

test("signed-out visitors see the sign-in screen", async () => {
  const page = await h.loadPage({ session: false });
  assert.ok(page.visible("viewLogin"));
  assert.match(page.$("#viewLogin").innerHTML, /bsky\.app\/settings\/app-passwords/, "links to the app password page");
});

test("sign-in with empty fields explains what's missing", async () => {
  const page = await h.loadPage({ session: false });
  page.$("#btnLogin").click();
  assert.match(page.$("#loginErr").textContent, /handle and an app password/);
});

test("successful sign-in goes to the start screen and saves the session", async () => {
  const page = await h.loadPage({ session: false });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "abcd-efgh";
  page.$("#btnLogin").click();
  await h.waitFor(() => page.visible("viewStart"), { message: "start screen" });
  assert.ok(page.window.localStorage.getItem("bcu:session"));
});

test("wrong app password shows a clear error", async () => {
  const page = await h.loadPage({ session: false });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "wrong";
  page.$("#btnLogin").click();
  await h.waitFor(() => page.$("#loginErr").textContent, { message: "error" });
  assert.match(page.$("#loginErr").textContent, /don't match/);
});

test("unreachable servers produce a visible message, not silence", async () => {
  const page = await h.loadPage({ session: false, server: { offline: true } });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "x";
  page.$("#btnLogin").click();
  await h.waitFor(() => page.$("#loginErr").textContent, { message: "error" });
  assert.match(page.$("#loginErr").textContent, /Couldn't connect/);
  assert.equal(page.$("#btnLogin").textContent, "Sign in", "button resets");
});

test("being offline at startup keeps the saved session", async () => {
  const page = await h.loadPage({ server: { offline: true } });
  await h.waitFor(() => page.$("#startErr").textContent, { timeout: 8000, message: "start error" });
  assert.ok(page.visible("viewStart"));
  assert.match(page.$("#startErr").textContent, /Couldn't connect/);
  assert.ok(page.window.localStorage.getItem("bcu:session"), "session not deleted");
});

test("the version shown matches APP_VERSION and the filename", async () => {
  const page = await h.loadPage();
  const v = page.eval("APP_VERSION");
  assert.match(page.document.title, new RegExp(`v${v.replace(/\./g, "\\.")}`));
  assert.ok(h.PAGE_PATH.includes(`v${v}`) || !/v\d+\.\d+\.\d+/.test(h.PAGE_PATH), "filename carries the same version");
  const raw = require("node:fs").readFileSync(h.PAGE_PATH, "utf8");
  assert.match(raw, new RegExp(`Version ${v.replace(/\./g, "\\.")}`), "header comment version");
  // boot() overwrites document.title from APP_VERSION, so the assertion on
  // page.document.title above passes even when the tag in <head> is stale --
  // it only looks like coverage. That tag is what shows before the script
  // runs, and VERSIONING counts it as one of the three spots that must stay
  // in sync, so check the source as well as the running page.
  assert.match(raw, new RegExp(`<title>[^<]*v${v.replace(/\./g, "\\.")}\\b`), "<title> in <head> matches APP_VERSION");
  assert.match(raw, new RegExp(`## \\[${v.replace(/\./g, "\\.")}\\]`), "changelog entry for this version");
  // The release workflow publishes this version's changelog section verbatim
  // as the release notes, so an empty section would ship an empty release.
  const after = raw.split(new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\][^\\n]*$`, "m"))[1] || "";
  const section = after.split(/^## \[/m)[0];
  assert.match(section, /^### \w/m, "changelog entry has a group heading and a body");
  // The About links are built from APP_VERSION, and the release workflow
  // builds the tag and the asset name from that same version. If the two
  // ever drift, these links 404 with nothing on the page to show it.
  const repo = page.eval("REPO_URL");
  assert.equal(page.$("#aboutDownload").getAttribute("href"),
    `${repo}/releases/download/v${v}/bluesky-catchup-v${v}.html`, "download link matches the released asset name");
  assert.equal(page.$("#aboutRelease").getAttribute("href"),
    `${repo}/releases/tag/v${v}`, "version link matches the release tag");
});

test("the tab icon is carried inside the file, not fetched", async () => {
  // Read the FILE, not the loaded DOM: loadPage strips <link> so tests never
  // touch the network, which would hide the very thing this checks.
  const src = require("node:fs").readFileSync(h.PAGE_PATH, "utf8");
  const head = src.slice(0, src.indexOf("</head>"));
  const icons = (head.match(/<link\s[^>]*rel="(?:icon|alternate icon)"[^>]*>/g) || []);
  assert.ok(icons.length, "the page has a tab icon at all");
  // The whole point of an inline icon: a copy opened from file:// keeps it,
  // and the page still fetches nothing but Bluesky. An href pointing at a
  // favicon file next to the page would fail silently -- the hosted copy
  // would look fine while every saved copy lost its icon.
  for (const tag of icons)
    assert.match(tag, /\shref="data:/, `icon must be inline: ${tag.slice(0, 60)}`);
  // The SVG is the real icon; the PNG is only Safari's fallback. Check the
  // SVG is actually the artwork, not an empty or truncated document.
  const svg = icons.find(t => t.includes('type="image/svg+xml"'));
  assert.ok(svg, "there is an SVG icon");
  const uri = svg.match(/\shref="([^"]*)"/)[1];
  const markup = decodeURIComponent(uri.replace(/^data:image\/svg\+xml,/, ""));
  assert.match(markup, /^<svg[^>]*viewBox=/, "the SVG has a viewBox");
  assert.match(markup, /<\/svg>$/, "the SVG is not truncated");
});

test("the home-screen icon is an inline 180px PNG", async () => {
  // Same file-not-DOM reading as the tab icon test above. iOS wants a
  // 180x180 apple-touch-icon; any other size gets rescaled and goes soft.
  const src = require("node:fs").readFileSync(h.PAGE_PATH, "utf8");
  const head = src.slice(0, src.indexOf("</head>"));
  const tag = (head.match(/<link\s[^>]*rel="apple-touch-icon"[^>]*>/) || [])[0];
  assert.ok(tag, "the page has an apple-touch-icon");
  const uri = tag.match(/\shref="([^"]*)"/)[1];
  assert.match(uri, /^data:image\/png;base64,/, "the touch icon is an inline PNG");
  const png = Buffer.from(uri.replace(/^data:image\/png;base64,/, ""), "base64");
  assert.equal(png.toString("latin1", 1, 4), "PNG", "it decodes to a PNG");
  // IHDR is always the first chunk: width and height are big-endian at 16 and 20.
  assert.equal(png.readUInt32BE(16), 180, "180px wide");
  assert.equal(png.readUInt32BE(20), 180, "180px tall");
});
