"use strict";
/*
 * Which servers the page talks to, and which links it writes out.
 *
 * The point of these tests is routing, not rendering: the `appView` setting
 * must reach app.bsky.* reads as an atproto-proxy header and must NEVER touch
 * a com.atproto.* call (those are the user's own repository on their own
 * server), and `webHost` must reach every link the page writes.
 *
 * page.calls records only method names, so these use page.requests, which
 * records host, path and headers per request. A test written against
 * page.calls alone would pass against entirely wrong routing.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const a = h.actor(1);
const server = { timeline: [h.item(h.post("A", a, 10)), h.item(h.post("G", a, 12, { embed: h.embeds.gallery(5) }))] };
const proxied = page => page.requests.filter(r => r.headers["atproto-proxy"]);

/* ---------------------------------------------------------------- the AppView */

test("an AppView setting is sent as atproto-proxy on app.bsky reads only", async () => {
  const page = await h.loadPage({ settings: { appView: "api.example" }, server });
  await page.startDate(h.BASE);
  const reads = page.requests.filter(r => r.nsid.startsWith("app.bsky."));
  assert.ok(reads.length, "the feed made app.bsky reads at all");
  for (const r of reads) assert.equal(r.headers["atproto-proxy"], "did:web:api.example#bsky_appview", `${r.nsid} names the AppView`);
  for (const r of page.requests.filter(r => r.nsid.startsWith("com.atproto.")))
    assert.equal(r.headers["atproto-proxy"], undefined, `${r.nsid} is the user's own repo and must not be proxied`);
});

test("likes and reposts are written to the user's own server, never the AppView", async () => {
  const page = await h.loadPage({ settings: { appView: "api.example" }, server });
  await page.startDate(h.BASE);
  page.article("A").querySelector('[data-act="like"]').click();
  await h.waitFor(() => page.calls.includes("com.atproto.repo.createRecord"), { message: "createRecord" });
  const write = page.requests.find(r => r.nsid === "com.atproto.repo.createRecord");
  assert.equal(write.host, "pds.example", "went to the account's own server");
  assert.equal(write.headers["atproto-proxy"], undefined, "carried no proxy header");
});

test("a service DID is passed through, and a bare one gets the service name", async () => {
  const page = await h.loadPage({ server });
  const target = v => page.eval(`settings.appView = ${JSON.stringify(v)}; appViewTarget()`);
  assert.equal(target("did:web:api.example#bsky_appview"), "did:web:api.example#bsky_appview");
  assert.equal(target("did:plc:abc123"), "did:plc:abc123#bsky_appview");
  assert.equal(target("https://api.example/xrpc/"), "did:web:api.example#bsky_appview", "a pasted URL is reduced to its host");
  assert.equal(target("api.example:3000"), "did:web:api.example%3A3000#bsky_appview", "a port is percent-encoded, as did:web requires");
});

test("with no AppView set, nothing carries a proxy header", async () => {
  const page = await h.loadPage({ server });
  await page.startDate(h.BASE);
  assert.ok(page.requests.some(r => r.nsid.startsWith("app.bsky.")), "reads happened");
  assert.deepEqual(proxied(page), [], "no request named an AppView");
});

test("an unusable AppView sends no header rather than a broken one", async () => {
  for (const bad of ["not a host", "javascript:alert(1)", "did:#", "   ", "http://"]) {
    const page = await h.loadPage({ settings: { appView: bad }, server });
    await page.startDate(h.BASE);
    assert.deepEqual(proxied(page), [], `"${bad}" was not sent as a proxy target`);
    assert.deepEqual(page.ids(), ["A", "G"], `"${bad}" still loaded the feed`);
  }
});

/* ---------------------------------------------------------------- handle resolution */

test("a handle's own domain is asked first, and Bluesky is never asked", async () => {
  const page = await h.loadPage({ session: false, server: { ...server, wellKnown: { "me.test": "did:plc:me" } } });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "abcd-efgh"; page.$("#btnLogin").click();
  await h.waitFor(() => page.visible("viewStart"), { message: "start screen" });
  assert.ok(page.requests.some(r => r.host === "me.test" && r.path === "/.well-known/atproto-did"), "asked the handle's own domain");
  assert.ok(!page.requests.some(r => r.host === "public.api.bsky.app"), "never fell back to Bluesky's API");
});

const resolvers = page => page.requests
  .filter(r => r.path.includes("atproto-did") || r.nsid === "com.atproto.identity.resolveHandle").map(r => r.host);

test("resolution asks the chosen AppView before Bluesky", async () => {
  const page = await h.loadPage({ session: false, settings: { appView: "api.example" }, server });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "abcd-efgh"; page.$("#btnLogin").click();
  await h.waitFor(() => page.visible("viewStart"), { message: "start screen" });
  assert.deepEqual(resolvers(page).slice(0, 2), ["me.test", "api.example"], "the handle's own domain, then the chosen AppView");
  assert.ok(!page.requests.some(r => r.host === "public.api.bsky.app"), "the AppView answered, so Bluesky was never asked");
});

test("Bluesky's API is the last resort, not the first stop", async () => {
  const page = await h.loadPage({ session: false, server });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "abcd-efgh"; page.$("#btnLogin").click();
  await h.waitFor(() => page.visible("viewStart"), { message: "start screen" });
  assert.deepEqual(resolvers(page).slice(0, 2), ["me.test", "public.api.bsky.app"],
    "nothing configured: the handle's own domain first, Bluesky only after it fails");
});

test("unreachable servers are not reported as a misspelled handle", async () => {
  const page = await h.loadPage({ session: false, server: { ...server, offline: true } });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "abcd-efgh"; page.$("#btnLogin").click();
  await h.waitFor(() => page.$("#loginErr").textContent, { message: "error" });
  assert.match(page.$("#loginErr").textContent, /Couldn't connect/);
});

/* ---------------------------------------------------------------- the web front-end */

test("webHost reaches post, profile and hashtag links", async () => {
  const page = await h.loadPage({ settings: { webHost: "deer.example" }, server });
  await page.startDate(h.BASE);
  const art = page.article("A");
  assert.match(art.querySelector('.pv-head a[href*="/profile/"]').href, /^https:\/\/deer\.example\/profile\//);
  assert.match(art.querySelector('a[href*="/post/"]').href, /^https:\/\/deer\.example\/profile\/[^/]+\/post\//);
  assert.equal(page.eval(`postLinkFor("u1.test", "abc")`), "https://deer.example/profile/u1.test/post/abc");
  assert.equal(page.eval(`profileLinkFor("u1.test")`), "https://deer.example/profile/u1.test");
  assert.match(page.eval(`richText("#x", [{index:{byteStart:0,byteEnd:2},features:[{"$type":"app.bsky.richtext.facet#tag",tag:"x"}]}])`),
    /https:\/\/deer\.example\/hashtag\/x/);
});

test("webHost reaches the sign-in screen's own links", async () => {
  const page = await h.loadPage({ session: false, settings: { webHost: "deer.example" }, server });
  for (const el of page.$$("[data-weblink]")) assert.match(el.href, /^https:\/\/deer\.example\//);
  assert.equal(page.$(".web-host").textContent, "deer.example");
});

test("an empty or unusable webHost falls back to bsky.app", async () => {
  for (const bad of ["", "   ", "not a host"]) {
    const page = await h.loadPage({ settings: { webHost: bad }, server });
    assert.equal(page.eval(`webLinkHost()`), "bsky.app", `"${bad}" fell back`);
  }
});

test("the gallery proxy replaces whichever front-end is in use", async () => {
  const page = await h.loadPage({ settings: { webHost: "deer.example", galleryProxy: true, galleryProxyHost: "xbsky.app" }, server });
  await page.startDate(h.BASE);
  const post = id => `state.view.find(x => x.fi.post.record.text === "post ${id}").fi.post`;
  assert.deepEqual(page.json(`shareUrl(${post("G")})`),
    { url: "https://xbsky.app/profile/u1.test/post/G", proxied: "xbsky.app" },
    "the proxy swapped deer.example, not a hardcoded bsky.app");
  // A plain post is untouched, and the proxy being the same host is no swap.
  assert.deepEqual(page.json(`shareUrl(${post("A")})`),
    { url: "https://deer.example/profile/u1.test/post/A", proxied: false });
  assert.deepEqual(page.json(`(settings.galleryProxyHost = "deer.example", shareUrl(${post("G")}))`),
    { url: "https://deer.example/profile/u1.test/post/G", proxied: false });
});

test("pasted links from any front-end are understood", async () => {
  const page = await h.loadPage({ server });
  assert.deepEqual(page.json(`parsePostRef("https://deer.example/profile/u1.test/post/G")`), { actor: "u1.test", rkey: "G" });
  assert.deepEqual(page.json(`parsePostRef("bsky.app/profile/u1.test/post/G")`), { actor: "u1.test", rkey: "G" });
  assert.deepEqual(page.json(`parsePostRef("at://did:plc:u1/app.bsky.feed.post/G")`), { actor: "did:plc:u1", rkey: "G" });
  assert.equal(page.eval(`parsePostRef("just some words")`), null);
});

/* ---------------------------------------------------------------- media hosts */

test("the deep-quote thumbnail hosts follow the AppView", async () => {
  const page = await h.loadPage({ server });
  const host = v => page.eval(`settings.appView = ${JSON.stringify(v)}; JSON.stringify([mediaHost("cdn"), mediaHost("video")])`);
  assert.equal(host(""), '["cdn.bsky.app","video.bsky.app"]', "unset keeps Bluesky's CDN");
  assert.equal(host("api.example"), '["cdn.example","video.example"]', "api. is swapped for cdn./video.");
  assert.equal(host("appview.example"), "[null,null]", "an AppView whose CDN can't be worked out answers unknown");
  assert.equal(page.eval(`settings.appView = "appview.example"; cdnImg("feed_thumbnail", "did:plc:x", "cid")`), "",
    "and builds no URL at all, rather than quietly calling Bluesky");
});

/* ---------------------------------------------------------------- not shareable */

test("a catch-up link cannot redirect where Reply and Open send you", async () => {
  // webHost decides where the password gets typed, so unlike galleryProxyHost
  // it must not be settable by someone else's link.
  const page = await h.loadPage({ url: "https://site.example/i.html#s.webHost=evil.example&s.galleryProxyHost=ok.example", server });
  assert.equal(page.eval(`settings.webHost`), "bsky.app", "the link's webHost was refused");
  assert.equal(page.eval(`settings.galleryProxyHost`), "ok.example", "a linkable host setting still arrives");
  assert.match(page.$("#linkSettingsNote").textContent, /webHost/, "and the visitor is told it was ignored");
});

test("an AppView that can't be reached is named, not retried into the ground", async () => {
  // A wrong hostname in the setting makes the PDS answer 5xx (measured
  // against bsky.network, which returns 500). The generic 5xx path retries
  // eight times over minutes and then blames Bluesky, which is both slow and
  // wrong when the cause is a typo in a setting.
  let hits = 0;
  const page = await h.loadPage({
    settings: { appView: "nope.invalid" },
    server: { ...server, handlers: { "app.bsky.feed.getTimeline": () => { hits++; return { status: 500, error: "InternalServerError" }; } } },
  });
  // The one retry sleeps past settle()'s own timeout, so wait for the message.
  await page.startDate(h.BASE).catch(() => {});
  const msg = await h.waitFor(() => page.$("#startErr").textContent || page.banner(), { timeout: 20000, message: "the AppView error" });
  assert.match(msg, /AppView .nope\.invalid./, "names the setting that's wrong");
  assert.ok(hits <= 2, `gave up after ${hits} attempts, not eight`);
});

test("an ordinary 5xx with no AppView set still retries as before", async () => {
  let hits = 0;
  const page = await h.loadPage({
    // An override replaces the route, so the success case has to serve the
    // feed itself: newest first, the way the real getTimeline does.
    server: { ...server, handlers: { "app.bsky.feed.getTimeline": () => (++hits < 2 ? { status: 500, error: "InternalServerError" } : { feed: [...server.timeline].reverse() }) } },
  });
  await page.startDate(h.BASE).catch(() => {});
  await h.waitFor(() => page.visible("viewFeed"), { timeout: 20000, message: "the feed" });
  assert.ok(hits >= 2, "retried through the transient failure");
  assert.deepEqual(page.ids(), ["A", "G"], "and recovered");
});

/* ---------------------------------------------------------------- the readout */

test("the Advanced group prints what this copy is actually talking to", async () => {
  const page = await h.loadPage({ settings: { appView: "api.bsky.app", webHost: "deer.social" }, server });
  page.eval("renderDrawer()");
  const terms = page.$$("#drawer .infra dt").map(el => el.textContent);
  assert.deepEqual(terms, ["Account", "Your server", "AppView", "Pictures and video", "Identity", "Handle resolved by", "Catch-up assembled by", "Links open at"]);
  const text = page.$("#drawer .infra").textContent;
  assert.match(text, /pds\.example/, "names the account's own server");
  assert.match(text, /did:web:api\.bsky\.app#bsky_appview/, "names the chosen AppView");
  assert.match(text, /cdn\.bsky\.app · video\.bsky\.app/, "names the media hosts it would build");
  assert.match(text, /deer\.social/, "names the front-end links open at");
});

test("the readout says 'not known' rather than guessing", async () => {
  const page = await h.loadPage({ server });   // no AppView chosen
  page.eval("renderDrawer()");
  const dd = i => page.$$("#drawer .infra dd")[i];
  assert.match(dd(2).textContent, /not known/, "an unchosen AppView is not known, not assumed to be Bluesky's");
  assert.ok(dd(2).classList.contains("none"), "and is marked as absent");
  assert.match(dd(2).textContent, /whichever AppView it prefers/, "but explains what happens instead");
});

test("the readout follows a setting as it is changed", async () => {
  const page = await h.loadPage({ server });
  page.eval("renderDrawer()");
  assert.match(page.$("#drawer .infra").textContent, /not known/);
  const input = page.$('#drawer [data-k="appView"]');
  input.focus();                       // as a person typing into it would be
  assert.equal(page.document.activeElement, input, "focused to begin with");
  input.value = "api.example";
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  assert.match(page.$("#drawer .infra").textContent, /did:web:api\.example#bsky_appview/, "updated without reopening the drawer");
  assert.equal(page.document.activeElement, page.$('#drawer [data-k="appView"]'), "and without stealing focus from the field");
});

test("every row that can read 'not known' says why", async () => {
  // Signed out, with an AppView whose CDN can't be worked out: the state in
  // which the most rows are unknown at once.
  const page = await h.loadPage({ session: false, settings: { appView: "appview.example" }, server });
  page.eval("renderDrawer()");
  const unknown = page.$$("#drawer .infra dd").filter(dd => dd.classList.contains("none"));
  assert.ok(unknown.length >= 4, `expected several unknown rows, got ${unknown.length}`);
  for (const dd of unknown) {
    const note = dd.querySelector(".note");
    assert.ok(note && note.textContent.trim().length > 20, `"${dd.textContent.slice(0,40)}" explains itself`);
  }
  const text = page.$("#drawer .infra").textContent;
  assert.match(text, /isn't named api\.something/, "says why the media hosts are unknown");
  assert.match(text, /Recorded when you sign in/, "says why the resolution source is unknown");
});

test("a session saved before the page recorded it says so", async () => {
  const page = await h.loadPage({ server });   // harness session has no resolvedVia
  page.eval("renderDrawer()");
  const dd = page.$$("#drawer .infra dd")[5];
  assert.match(dd.textContent, /saved before the page started recording it/);
});

test("the readout links to the protocol's own documentation", async () => {
  const page = await h.loadPage({ server });
  page.eval("renderDrawer()");
  // The per-row "further reading" links, not the operator marks (those point
  // at whoever runs the thing, which is the point of them).
  const links = page.$$("#drawer .infra .docs a, #drawer .infra-intro a");
  assert.ok(links.length >= 8, `expected links on most rows, got ${links.length}`);
  for (const a of links) {
    assert.match(a.href, /^https:\/\/atproto\.com\//, `${a.textContent} points at the canonical docs`);
    assert.equal(a.getAttribute("rel"), "noopener");
  }
  assert.ok(links.some(a => /specs\/handle/.test(a.href)), "handle resolution is linked");
  assert.ok(links.some(a => /specs\/did/.test(a.href)), "DIDs are linked");
});

/* ---------------------------------------------------------------- who runs what */

test("each row is marked Bluesky-run or protocol-generic", async () => {
  const page = await h.loadPage({ settings: { appView: "api.bsky.app", webHost: "bsky.app" }, server });
  page.eval("renderDrawer()");
  const marks = page.$$("#drawer .infra dd").map(dd => dd.querySelector(".op")?.className.replace("op op-", "") ?? null);
  // The harness session is me.test on pds.example with a did:plc — a
  // deliberate mix. "Handle resolved by" is unmarked because that session
  // predates the field, which is the same reason it reads "not known".
  assert.deepEqual(marks, ["atproto", "atproto", "bluesky", "bluesky", "bluesky", null, "bluesky", "bluesky"],
    "handle and PDS are independent here; AppView, CDN, did:plc, assembly and bsky.app links are Bluesky's");
});

test("a fresh sign-in marks where the handle was actually resolved", async () => {
  // Nothing configured, no .well-known: resolution lands on Bluesky's API,
  // and the row should say so rather than quietly leaving it blank.
  const page = await h.loadPage({ session: false, server });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "abcd-efgh"; page.$("#btnLogin").click();
  await h.waitFor(() => page.visible("viewStart"), { message: "start screen" });
  page.eval("renderDrawer()");
  const dd = page.$$("#drawer .infra dd")[5];
  assert.ok(!dd.classList.contains("none"), "the source is known after signing in");
  assert.equal(dd.querySelector(".op")?.className, "op op-bluesky", "and is marked as Bluesky's");

  // The same sign-in against a handle that publishes its own DID is not.
  const own = await h.loadPage({ session: false, server: { ...server, wellKnown: { "me.test": "did:plc:me" } } });
  own.$("#inHandle").value = "me.test"; own.$("#inPass").value = "abcd-efgh"; own.$("#btnLogin").click();
  await h.waitFor(() => own.visible("viewStart"), { message: "start screen" });
  own.eval("renderDrawer()");
  assert.equal(own.$$("#drawer .infra dd")[5].querySelector(".op")?.className, "op op-atproto",
    "resolved from the handle's own domain, so not Bluesky's");
});

test("the classifier only claims hosts Bluesky actually runs", async () => {
  const page = await h.loadPage({ server });
  const is = host => page.eval(`isBlueskyHost(${JSON.stringify(host)})`);
  for (const h2 of ["bsky.app", "cdn.bsky.app", "api.bsky.app", "bsky.social", "boletus.us-west.host.bsky.network", "plc.directory"])
    assert.equal(is(h2), true, `${h2} is Bluesky's`);
  // The safe direction to be wrong in is never claiming someone else is Bluesky.
  for (const h2 of ["deer.social", "zeppelin.social", "pds.example", "my-bsky.app.example.com", "notbsky.app", ""])
    assert.equal(is(h2), false, `${h2} is not Bluesky's`);
});

test("an unknown row carries no mark at all", async () => {
  const page = await h.loadPage({ session: false, server });
  page.eval("renderDrawer()");
  for (const dd of page.$$("#drawer .infra dd").filter(d => d.classList.contains("none")))
    assert.equal(dd.querySelector(".op"), null, "nothing is claimed about a piece that isn't known");
});

test("the marks are inlined, never fetched from Bluesky", async () => {
  const src = require("node:fs").readFileSync(h.PAGE_PATH, "utf8");
  const icons = src.slice(src.indexOf("const ICON = {"), src.indexOf("const ICON = {") + 4000);
  assert.match(icons, /bsky: '<svg/, "the butterfly is an inline svg");
  assert.match(icons, /atproto: '<svg/, "so is the at-sign");
  assert.ok(!/<img[^>]+bsky\.app/.test(src), "no mark is loaded from Bluesky's servers");
});

test("the marks say in words what they mean", async () => {
  const page = await h.loadPage({ settings: { appView: "api.bsky.app" }, server });
  page.eval("renderDrawer()");
  const ops = page.$$("#drawer .infra .op");
  assert.ok(ops.length >= 5);
  for (const op of ops) {
    assert.match(op.getAttribute("aria-label"), /Run by Bluesky|open protocol/);
    assert.equal(op.getAttribute("title"), op.getAttribute("aria-label"));
  }
});

test("each mark links to the documentation of whoever runs that piece", async () => {
  const page = await h.loadPage({ settings: { appView: "api.bsky.app" }, server });
  page.eval("renderDrawer()");
  const ops = page.$$("#drawer .infra .op");
  assert.ok(ops.length >= 5);
  for (const op of ops) {
    assert.equal(op.tagName, "A", "the mark itself is clickable");
    assert.equal(op.getAttribute("rel"), "noopener");
    assert.equal(op.getAttribute("target"), "_blank");
    const bluesky = op.classList.contains("op-bluesky");
    assert.match(op.getAttribute("href"), bluesky ? /^https:\/\/(docs\.bsky\.app|web\.plc\.directory)\// : /^https:\/\/atproto\.com\//,
      `a ${bluesky ? "Bluesky" : "protocol"} mark goes to that side's docs`);
  }
  assert.ok(ops.some(o => o.classList.contains("op-bluesky")), "both kinds are present here");
  assert.ok(ops.some(o => o.classList.contains("op-atproto")));
});

test("a mark links to the page about that piece, not a documentation front door", async () => {
  const page = await h.loadPage({ settings: { appView: "api.bsky.app" }, server });
  page.eval("renderDrawer()");
  const href = term => {
    const dt = page.$$("#drawer .infra dt").find(d => d.textContent === term);
    return dt.nextElementSibling.querySelector(".op")?.getAttribute("href") ?? null;
  };
  // Every mark goes somewhere deeper than the site root.
  for (const term of ["Account", "Your server", "AppView", "Pictures and video", "Identity", "Handle resolved by", "Links open at"]) {
    const h2 = href(term);
    if (h2 === null) continue;                      // unmarked rows are allowed
    assert.ok(new URL(h2).pathname.length > 1, `${term} links to a page, not just a host (${h2})`);
  }
  // And the destinations differ per row rather than all being the same link.
  const all = ["Account", "AppView", "Identity", "Links open at"].map(href);
  assert.equal(new Set(all).size, all.length, `each row has its own destination: ${all.join(", ")}`);
  assert.match(href("Identity"), /plc\.directory\/spec/, "did:plc points at the method spec that defines it");
});

/* ================================================================ 1.2.0pre2 */
/* Identity: resolving a handle, and finding the server behind it, without
   having to ask Bluesky. */

const resolvedBy = page => {
  const dt = page.$$("#drawer .infra dt").find(d => d.textContent === "Handle resolved by");
  return dt.nextElementSibling;
};
const signIn = async (page, handle = "me.test", pds = "") => {
  page.$("#inHandle").value = handle; page.$("#inPass").value = "abcd-efgh";
  if (pds) page.$("#inPds").value = pds;
  page.$("#btnLogin").click();
  await h.waitFor(() => page.visible("viewStart") || page.$("#loginErr").textContent,
    { timeout: 8000, message: "start screen or error" });
};

test("a handle's DNS record is read over HTTPS when its site won't answer", async () => {
  const page = await h.loadPage({ session: false, server: { ...server, dns: { "me.test": "did:plc:fromdns" } } });
  await signIn(page);
  assert.ok(page.visible("viewStart"), page.$("#loginErr").textContent);
  assert.ok(page.requests.some(r => r.host === "cloudflare-dns.com" && r.search.get("name") === "_atproto.me.test"),
    "asked the resolver for the handle's TXT record");
  assert.ok(!page.requests.some(r => r.host === "public.api.bsky.app"), "and never needed Bluesky's API");
  // The session's own DID comes back from createSession, so the proof that
  // the DNS answer was USED is which DID the directory was then asked about.
  assert.ok(page.requests.some(r => r.path === "/did:plc:fromdns"), "looked the DNS-derived DID up in the directory");
});

test("the DNS answer is parsed the way resolvers actually return TXT", async () => {
  const page = await h.loadPage({ server });
  const read = body => page.eval(`didFromDnsJson(${JSON.stringify(JSON.stringify(body))})`);
  assert.equal(read({ Answer: [{ data: '"did=did:plc:abc"' }] }), "did:plc:abc", "quoted, as Cloudflare sends it");
  assert.equal(read({ Answer: [{ data: "did=did:plc:abc" }] }), "did:plc:abc", "bare, as Google sends it");
  assert.equal(read({ Answer: [{ data: '"did=did:plc:" "abc"' }] }), "did:plc:abc", "split into chunks, as long TXT values arrive");
  assert.equal(read({ Answer: [{ data: '"v=spf1 -all"' }, { data: '"did=did:plc:abc"' }] }), "did:plc:abc", "alongside unrelated TXT records");
  assert.equal(read({ Answer: [] }), null, "no answer");
  assert.equal(read({ Answer: [{ data: '"did=not-a-did"' }] }), null, "an answer that isn't a DID is not believed");
  assert.equal(page.eval(`didFromDnsJson("<html>")`), null, "nor is a non-JSON body");
});

const resolveHosts = page => page.requests
  .filter(r => r.path.includes("atproto-did") || r.path.includes("dns-query") || r.nsid === "com.atproto.identity.resolveHandle")
  .map(r => r.host);

test("resolution order: DNS, then the handle's own site, then AppView, then Bluesky", async () => {
  const page = await h.loadPage({
    session: false, settings: { appView: "api.example" },
    server: { ...server, wellKnown: { "me.test": "did:plc:fromsite" } },
  });
  await signIn(page);
  assert.deepEqual(resolveHosts(page).slice(0, 2), ["cloudflare-dns.com", "me.test"],
    "the protocol puts the DNS record first, so this does too");
  assert.ok(page.requests.some(r => r.path === "/did:plc:fromsite"), "the site answered and its DID was used");
  assert.ok(!resolveHosts(page).includes("public.api.bsky.app"), "so Bluesky was never asked");
});

test("the DNS record wins over the handle's own site, as the protocol says", async () => {
  // A domain publishing both, disagreeing: the usual cause is a file left
  // stale after the DNS record was updated. The spec says DNS is right.
  const page = await h.loadPage({
    session: false,
    server: { ...server, dns: { "me.test": "did:plc:fromdns" }, wellKnown: { "me.test": "did:plc:stale" } },
  });
  await signIn(page);
  assert.ok(page.requests.some(r => r.path === "/did:plc:fromdns"), "took the DNS answer");
  assert.ok(!page.requests.some(r => r.path === "/did:plc:stale"), "and never used the stale file");
});

test("a PDS-hosted handle still works though it publishes no DNS record", async () => {
  // Measured against the real network: *.bsky.social handles have no
  // _atproto TXT record, so the resolver answers empty and the site answers.
  // That costs one wasted request, which is the price of spec order.
  const page = await h.loadPage({ session: false, server: { ...server, wellKnown: { "me.test": "did:plc:fromsite" } } });
  await signIn(page);
  assert.ok(page.visible("viewStart"), page.$("#loginErr").textContent);
  assert.deepEqual(resolveHosts(page).slice(0, 2), ["cloudflare-dns.com", "me.test"]);
  assert.ok(page.requests.some(r => r.path === "/did:plc:fromsite"), "the empty DNS answer fell through to the site");
});

test("clearing the resolver means no DNS query is made at all", async () => {
  const page = await h.loadPage({
    session: false, settings: { dnsResolver: "" },
    server: { ...server, dns: { "me.test": "did:plc:fromdns" } },
  });
  await signIn(page);
  assert.ok(!page.requests.some(r => r.path.includes("dns-query")), "asked no resolver");
  assert.ok(page.requests.some(r => r.host === "public.api.bsky.app"), "fell through to the public API instead");
});

test("an unusable resolver address is ignored rather than requested", async () => {
  for (const bad of ["not a url", "http://insecure.example/dns-query", "javascript:alert(1)"]) {
    const page = await h.loadPage({ session: false, settings: { dnsResolver: bad }, server });
    assert.equal(page.eval("dohEndpoint()"), null, `"${bad}" is refused`);
    await signIn(page);
    assert.ok(page.visible("viewStart"), `"${bad}" still allowed sign-in`);
    // Anchored: "resolve" alone also matches com.atproto.identity.resolveHandle.
    assert.ok(!page.requests.some(r => /\/dns-query$|\/resolve$/.test(r.path)), `"${bad}" was never contacted`);
  }
});

/* ---------------------------------------------------------------- your server */

test("naming your server skips every lookup", async () => {
  const page = await h.loadPage({ session: false, server: { ...server, dns: { "me.test": "did:plc:fromdns" } } });
  await signIn(page, "me.test", "https://my-pds.example");
  assert.ok(page.visible("viewStart"), page.$("#loginErr").textContent);
  assert.equal(page.eval("state.session.pds"), "https://my-pds.example");
  for (const r of page.requests)
    assert.ok(!/atproto-did|dns-query|identity\.resolveHandle/.test(r.path + r.nsid) && !r.path.startsWith("/did:"),
      `nothing was looked up, but ${r.host}${r.path} was requested`);
  page.eval("renderDrawer()");
  assert.match(resolvedBy(page).textContent, /the server you named \(my-pds\.example\)/);
});

test("a malformed server address is refused, not quietly replaced", async () => {
  // The old fallback silently used bsky.social when discovery failed. Doing
  // that to someone who typed an address would sign them in somewhere they
  // didn't choose, which is the opposite of what the field is for.
  const page = await h.loadPage({ session: false, server });
  await signIn(page, "me.test", "not a server");
  assert.match(page.$("#loginErr").textContent, /doesn't look right/);
  assert.match(page.$("#loginErr").textContent, /bsky\.social/, "and hints at a way out of a broken setting");
  assert.equal(page.eval("state.session"), null, "but nobody was signed in anywhere meanwhile");
});

/* ---------------------------------------------------------------- the directory */

test("did:plc is looked up in the directory named in settings", async () => {
  const page = await h.loadPage({
    session: false, settings: { plcDirectory: "https://plc.mirror.example" },
    server: { ...server, didDocs: { "did:plc:me": { service: [{ id: "#atproto_pds", serviceEndpoint: "https://mirror-found.example" }] } } },
  });
  await signIn(page);
  assert.ok(page.requests.some(r => r.host === "plc.mirror.example" && r.path.startsWith("/did:")), "asked the mirror");
  assert.ok(!page.requests.some(r => r.host === "plc.directory"), "and not Bluesky's directory");
});

test("an unusable directory falls back rather than stranding the account", async () => {
  const page = await h.loadPage({ settings: { plcDirectory: "nonsense !!" }, server });
  assert.equal(page.eval("plcDirectory()"), "https://plc.directory",
    "a did:plc account with no directory could not sign in at all, so this must not break");
});

test("did:web needs no directory at all", async () => {
  const page = await h.loadPage({
    session: false,
    server: { ...server, wellKnown: { "me.test": "did:web:me.test" },
      didDocs: { "did:web:me.test": { service: [{ id: "#atproto_pds", serviceEndpoint: "https://own.example" }] } } },
  });
  await signIn(page);
  assert.ok(page.visible("viewStart"), page.$("#loginErr").textContent);
  assert.equal(page.eval("state.session.pds"), "https://own.example");
  assert.ok(page.requests.some(r => r.host === "me.test" && r.path === "/.well-known/did.json"), "read the domain's own document");
  assert.ok(!page.requests.some(r => /plc/.test(r.host)), "no directory was involved");
});

/* ---------------------------------------------------------------- the readout */

test("the readout names the directory and marks a mirror as someone else's", async () => {
  const page = await h.loadPage({ settings: { plcDirectory: "https://plc.mirror.example" }, server });
  page.eval("renderDrawer()");
  const dt = page.$$("#drawer .infra dt").find(d => d.textContent === "Identity");
  assert.match(dt.nextElementSibling.textContent, /plc\.mirror\.example \(did:plc\)/);
  assert.equal(dt.nextElementSibling.querySelector(".op").className, "op op-other", "a mirror is neither Bluesky's nor the protocol's");
  assert.match(dt.nextElementSibling.textContent, /mirror of the did:plc register/);
});

test("a DNS resolver is marked as a third party, not as 'the open protocol'", async () => {
  const page = await h.loadPage({ session: false, server: { ...server, dns: { "me.test": "did:plc:fromdns" } } });
  await signIn(page);
  page.eval("renderDrawer()");
  const dd = resolvedBy(page);
  assert.match(dd.textContent, /cloudflare-dns\.com/);
  assert.equal(dd.querySelector(".op").className, "op op-other");
  assert.match(dd.querySelector(".op").getAttribute("aria-label"), /third party you chose/);
});

test("the About block says which servers this copy is actually set to use", async () => {
  // These are the claims people decide whether to type a password on, so they
  // must name the settings in force rather than describe a default.
  const page = await h.loadPage({ session: false, settings: { appView: "api.example" }, server });
  const note = page.$("#aboutServers").textContent;
  assert.match(note, /reads from api\.example/);
  assert.match(note, /asks cloudflare-dns\.com to resolve handles/);
  assert.match(note, /never sent anywhere but your own account's server/);

  const quiet = await h.loadPage({ session: false, settings: { dnsResolver: "" }, server });
  const note2 = quiet.$("#aboutServers").textContent;
  assert.ok(!/cloudflare/.test(note2), "a resolver that won't be asked is not claimed to be");
  assert.ok(!/reads from/.test(note2), "nor is an AppView that wasn't chosen");
});

test("the privacy claims name every third party sign-in can reach", async () => {
  // A standing check on prose: the About list is what people judge the page
  // on, and it has gone stale before (it named Google Fonts for versions
  // after the font was embedded). Each party below is one resolveHandleDid
  // or resolvePds can contact.
  const page = await h.loadPage({ session: false, server });
  const about = page.$$("#viewLogin .about li").map(li => li.textContent).join(" ");
  for (const party of [/AppView/, /DNS-over-HTTPS resolver/i, /did:plc directory/, /jsDelivr/, /the site your handle is named after/])
    assert.match(about, party, `the claims mention ${party}`);
});

test("did:web works in both forms, including the path form", async () => {
  // did:web:host is served from /.well-known/did.json; did:web:host:a:b from
  // /a/b/did.json. The second form was unexercised until a sabotage run
  // showed breaking it changed nothing.
  const cases = [
    ["did:web:me.test", "/.well-known/did.json", "https://plain.example"],
    ["did:web:me.test:user:alice", "/user/alice/did.json", "https://pathform.example"],
  ];
  for (const [did, path, pds] of cases) {
    const page = await h.loadPage({
      session: false,
      server: { ...server, wellKnown: { "me.test": did },
        didDocs: { [did]: { service: [{ id: "#atproto_pds", serviceEndpoint: pds }] } } },
    });
    await signIn(page);
    assert.ok(page.visible("viewStart"), `${did}: ${page.$("#loginErr").textContent}`);
    assert.equal(page.eval("state.session.pds"), pds, `${did} resolved to its own server`);
    assert.ok(page.requests.some(r => r.host === "me.test" && r.path === path), `${did} was read from ${path}`);
    assert.ok(!page.requests.some(r => /plc/.test(r.host)), `${did} needed no directory`);
  }
});

/* ---------------------------------------------------------------- docs in the drawer */

test("the server settings link to the documentation, inline and after", async () => {
  const page = await h.loadPage({ server });
  page.eval("renderDrawer()");
  for (const key of ["appView", "webHost", "dnsResolver", "plcDirectory", "protocolOnly"]) {
    const row = page.$(`[data-row="${key}"]`);
    const links = [...row.querySelectorAll(".sub a")];
    assert.ok(links.length >= 2, `${key} carries links (got ${links.length})`);
    assert.ok(row.querySelector(".sub .docs a"), `${key} has a further-reading line`);
    assert.ok(links.some(a => !a.closest(".docs")), `${key} also links inline in its explanation`);
    for (const a of links) {
      assert.match(a.getAttribute("href"), /^https:\/\/(atproto\.com|docs\.bsky\.app|web\.plc\.directory)\//, `${key} -> ${a.href}`);
      assert.equal(a.getAttribute("rel"), "noopener");
    }
  }
});

test("a setting can only link to a listed destination", async () => {
  // The explanation carries markup, so this is the guard that stops that
  // markup from becoming a way to put arbitrary HTML or links in the drawer.
  const page = await h.loadPage({ server });
  const sub = t => page.eval(`subHtml(${JSON.stringify(t)})`);
  assert.match(sub("see [DIDs](did) for more"), /<a href="https:\/\/atproto\.com\/specs\/did"[^>]*>DIDs<\/a>/);
  assert.equal(sub("see [this](nowhere) for more"), "see [this](nowhere) for more", "an unlisted name stays plain text");
  assert.equal(sub("see [this](https://evil.example) now"), "see [this](https://evil.example) now", "a URL is not a destination");
  assert.ok(!/<script/.test(sub("<script>alert(1)</script> [x](did)")), "and the text is still escaped");
  assert.match(sub("<b>hi</b>"), /&lt;b&gt;hi&lt;\/b&gt;/, "ordinary markup is shown, not rendered");
});

test("every documented destination is reachable and named once", async () => {
  const page = await h.loadPage({ server });
  const doc = page.json("DOC");
  assert.ok(Object.keys(doc).length >= 12);
  for (const [name, url] of Object.entries(doc)) {
    assert.match(url, /^https:\/\/(atproto\.com|docs\.bsky\.app|web\.plc\.directory)\//, `${name} points at documentation`);
  }
  assert.equal(new Set(Object.values(doc)).size, Object.values(doc).length, "no two names share a URL");
});

test("the readout introduces itself without calling itself a copy", async () => {
  const page = await h.loadPage({ server });
  page.eval("renderDrawer()");
  const intro = page.$("#drawer .infra-intro").textContent;
  assert.ok(!/this copy/i.test(intro), "reads as a page, not a photocopy");
  assert.match(intro, /AT Protocol/);
  assert.ok(page.$("#drawer .infra-intro a"), "and links to it");
});

/* ---------------------------------------------------------------- review fixes */

test("typing in a server setting doesn't stack up copies of the readout", async () => {
  const page = await h.loadPage({ server });
  page.eval("renderDrawer()");
  const input = page.$('#drawer [data-k="webHost"]');
  for (const v of ["d", "de", "deer"]) {
    input.value = v;
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  }
  assert.equal(page.$$("#drawer .infra-intro").length, 1, "one introduction, not one per keystroke");
  assert.equal(page.$$("#drawer dl.infra").length, 1, "and one list");
});

test("the readout refreshes for every setting it reports on", async () => {
  const page = await h.loadPage({ server });
  page.eval("renderDrawer()");
  const assembledBy = () => {
    const dt = page.$$("#drawer .infra dt").find(d => d.textContent === "Catch-up assembled by");
    return dt.nextElementSibling.textContent;
  };
  assert.match(assembledBy(), /an AppView/);
  const box = page.$('#drawer [data-k="protocolOnly"]');
  box.checked = true;
  box.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  assert.match(assembledBy(), /each account's own repository/, "the row two lines below the switch kept up");
});

test("a did:plc AppView doesn't send pictures back to Bluesky", async () => {
  // appViewHost() is null for a did:plc AppView because the identifier has no
  // host in it. Treating that as "none chosen" sent nested-quote thumbnails
  // to Bluesky's CDN while the reads went somewhere else entirely.
  const page = await h.loadPage({ server });
  assert.equal(page.eval(`settings.appView = ""; mediaHost("cdn")`), "cdn.bsky.app", "unset still means Bluesky's");
  assert.equal(page.eval(`settings.appView = "did:plc:someappview"; mediaHost("cdn")`), null,
    "but a chosen AppView with no knowable host answers 'unknown'");
  assert.equal(page.eval(`settings.appView = "api.example"; mediaHost("cdn")`), "cdn.example");
});

test("a failed sign-in doesn't leave its resolution source behind", async () => {
  const page = await h.loadPage({ session: false, server: { ...server, wellKnown: { "me.test": "did:plc:me" } } });
  page.$("#inHandle").value = "me.test"; page.$("#inPass").value = "wrong"; page.$("#btnLogin").click();
  await h.waitFor(() => page.$("#loginErr").textContent, { message: "the error" });
  assert.equal(page.eval("lastResolvedVia"), "me.test", "the first attempt resolved");
  page.$("#inHandle").value = "did:plc:me"; page.$("#inPass").value = "abcd-efgh"; page.$("#btnLogin").click();
  await h.waitFor(() => page.visible("viewStart"), { message: "the start screen" });
  assert.ok(!/me\.test/.test(page.eval("state.session.resolvedVia")),
    `a DID needs no resolving, so nothing should be claimed: got ${page.eval("state.session.resolvedVia")}`);
});
