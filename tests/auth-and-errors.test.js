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
  assert.match(raw, new RegExp(`## \\[${v.replace(/\./g, "\\.")}\\]`), "changelog entry for this version");
});
