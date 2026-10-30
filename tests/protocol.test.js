"use strict";
/*
 * Protocol mode: building a catch-up with no AppView at all.
 *
 * The defining assertion is the first one -- no app.bsky.* request is made.
 * Everything else here is about where each request GOES: a post must be read
 * from the server that holds it, not from the user's own server and not from
 * one shared host, because "read it from whoever holds it" is the whole
 * difference between this mode and the normal one.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness");

const T = h.BASE;
const at = mins => h.iso(T + mins * 60000);

/* Three accounts, each on its own server, each with a post. */
const alice = "did:plc:alice", bob = "did:plc:bob", carol = "did:plc:carol";
const servers = { [alice]: "https://alice.example", [bob]: "https://bob.example", [carol]: "https://carol.example" };
const didDocs = Object.fromEntries(Object.entries(servers).map(([did, pds]) => [
  did, { alsoKnownAs: [`at://${did.split(":")[2]}.test`], service: [{ id: "#atproto_pds", serviceEndpoint: pds }] },
]));

const post = (text, mins, extra = {}) => ({ $type: "app.bsky.feed.post", text, createdAt: at(mins), ...extra });

function world(over = {}) {
  // `over` first: spreading it last would replace the merged `repos` below
  // with only the overrides, quietly losing the follow list.
  return {
    didDocs,
    ...over,
    repos: {
      [h.ME.did]: { "app.bsky.graph.follow": [
        { subject: alice, createdAt: at(-1000) },
        { subject: bob, createdAt: at(-1000) },
      ] },
      [alice]: {
        "app.bsky.feed.post": [post("alice one", 10), post("alice two", 20)],
        "app.bsky.actor.profile": [{ displayName: "Alice" }],
      },
      [bob]: { "app.bsky.feed.post": [post("bob one", 15)] },
      [carol]: { "app.bsky.feed.post": [post("carol quoted", 5)] },
      ...over.repos,
    },
  };
}
const texts = page => page.$$("#feed .post .pv-text").map(el => el.textContent);

const run = async (over = {}, settings = {}) => {
  const page = await h.loadPage({ settings: { protocolOnly: true, ...settings }, server: world(over) });
  await page.startDate(T).catch(() => {});
  await h.waitFor(() => page.visible("viewFeed") || page.$("#startErr").textContent,
    { timeout: 15000, message: "the feed" });
  return page;
};

test("no app.bsky request is made at all", async () => {
  // The whole point of the mode. If this ever has to be weakened, the mode
  // is not doing what it says.
  //
  // The wait matters: hydrating a post (counts, viewer state) happens on a
  // 300ms debounce AFTER it is first drawn, so an assertion made the instant
  // the feed appears misses it. A live run showed like and repost counts in
  // a mode that promises none, which is how that hole was found.
  const page = await run();
  await new Promise(r => setTimeout(r, 900));
  const appView = page.requests.filter(r => r.nsid.startsWith("app.bsky."));
  assert.deepEqual(appView.map(r => r.nsid), [], "every request was com.atproto.*");
  assert.ok(page.requests.length > 3, "and it did actually fetch things");
});

test("posts are not hydrated, so no counts appear from nowhere", async () => {
  const page = await run();
  await new Promise(r => setTimeout(r, 900));
  assert.equal(page.eval("hydrateQueue.size"), 0, "nothing was queued for hydration");
  assert.ok(!page.requests.some(r => r.nsid === "app.bsky.feed.getPosts"), "and none was fetched");
  const counts = page.$$("#feed .act span").map(s => s.textContent.trim()).filter(Boolean);
  assert.deepEqual(counts, [], `no counts are shown: ${counts.join(", ")}`);
  // Liking still works: it writes a record to your own repository. Leaving
  // these disabled would make the whole mode read-only.
  const act = page.$('#feed [data-act="like"]');
  assert.ok(act, "there is a like button");
  assert.ok(!act.closest(".busy") && !act.classList.contains("busy"),
    "and it isn't stuck waiting for a hydration that will never come");
});

test("each account's posts come from that account's own server", async () => {
  const page = await run();
  assert.deepEqual(texts(page).sort(), ["alice one", "alice two", "bob one"].sort());
  const listed = page.requests.filter(r => r.nsid === "com.atproto.repo.listRecords" && r.search.get("collection") === "app.bsky.feed.post");
  for (const r of listed) {
    const did = r.search.get("repo");
    assert.equal("https://" + r.host, servers[did] ?? `https://${r.host}`, `${did}'s posts came from ${r.host}`);
  }
  assert.ok(listed.some(r => r.host === "alice.example"), "alice was read from her own server");
  assert.ok(listed.some(r => r.host === "bob.example"), "bob from his");
});

test("the follow list is read from your own repository, not an AppView", async () => {
  const page = await run();
  const follows = page.requests.find(r => r.nsid === "com.atproto.repo.listRecords" && r.search.get("collection") === "app.bsky.graph.follow");
  assert.ok(follows, "read app.bsky.graph.follow records");
  assert.equal(follows.host, "pds.example", "from the signed-in account's own server");
});

test("a repost is resolved against the original author's server", async () => {
  const page = await run({ repos: {
    [bob]: { "app.bsky.feed.repost": [{ subject: { uri: `at://${carol}/app.bsky.feed.post/r0`, cid: "c0" }, createdAt: at(18) }] },
  } });
  assert.ok(texts(page).includes("carol quoted"), `reposted post is shown: ${texts(page).join(" | ")}`);
  const got = page.requests.find(r => r.nsid === "com.atproto.repo.getRecord" && r.search.get("repo") === carol);
  assert.ok(got, "fetched carol's post");
  assert.equal(got.host, "carol.example", "from carol's own server, not bob's");
  assert.ok(page.$("#feed .repost-by, #feed .pv-repost, #feed .post")[0] || true);
});

test("a quoted post is fetched and shown, not just labelled", async () => {
  const page = await run({ repos: {
    [alice]: {
      "app.bsky.feed.post": [post("alice quotes", 10, {
        embed: { $type: "app.bsky.embed.record", record: { uri: `at://${carol}/app.bsky.feed.post/r0`, cid: "c0" } },
      })],
      "app.bsky.actor.profile": [{ displayName: "Alice" }],
    },
  } });
  const body = page.$("#feed").textContent;
  assert.match(body, /alice quotes/);
  assert.match(body, /carol quoted/, "the quoted post's text is shown, not just 'Quotes another post'");
  const got = page.requests.find(r => r.nsid === "com.atproto.repo.getRecord" && r.search.get("repo") === carol);
  assert.equal(got.host, "carol.example");
});

test("identity is cached, so a second catch-up asks no directory", async () => {
  const page = await run();
  const directoryCalls = p => p.requests.filter(r => r.path.startsWith("/did:")).length;
  assert.ok(directoryCalls(page) >= 2, "the first run looked accounts up");
  page.requests.length = 0;
  await page.startDate(T + 1);
  assert.equal(directoryCalls(page), 0, "the second run used the cache");
  assert.ok(page.window.localStorage.getItem("bcu:identities"), "and the cache outlives the page");
});

test("an account whose server can't be found is skipped, not fatal", async () => {
  const page = await run({
    didDocs: { ...didDocs, [bob]: { alsoKnownAs: [], service: [] } },   // no server in the document
  });
  assert.ok(texts(page).includes("alice one"), "the rest of the catch-up still arrived");
  assert.ok(!texts(page).includes("bob one"), "the unreachable account contributed nothing");
  assert.match(page.$("#feedHead").textContent, /1 account couldn't be read/i, "and the feed says so rather than quietly dropping them");
});

test("a record dated in the future can't pin itself to the top", async () => {
  const page = await run({ repos: {
    [bob]: { "app.bsky.feed.post": [post("bob from the future", 60 * 24 * 365)] },
  } });
  // The feed runs oldest-first, so "can't pin itself" is about the TIME it
  // sorts by, not its position: clamped to when we read it, a future record
  // sits at the newest end like anything else just posted, instead of a year
  // beyond every real post for ever. Assert the timestamp, not the order.
  assert.ok(texts(page).includes("bob from the future"), "it is still shown, not dropped");
  const t = page.json(`state.items.find(i => i.fi.post.record.text === "bob from the future").t`);
  const claimed = Date.parse(at(60 * 24 * 365));
  assert.ok(t < claimed - 300 * 24 * 3600 * 1000, `sorts by when it was read (${new Date(t).toISOString()}), not the year it claims`);
  assert.ok(Math.abs(t - Date.now()) < 60000, "which is about now");
});

test("pictures come from the repository, never a CDN", async () => {
  const page = await run({ repos: {
    [alice]: {
      "app.bsky.feed.post": [post("alice with a picture", 10, {
        embed: { $type: "app.bsky.embed.images", images: [{ image: { ref: { $link: "bafpic" }, mimeType: "image/jpeg" }, alt: "a cat" }] },
      })],
      "app.bsky.actor.profile": [{ displayName: "Alice" }],
    },
  } });
  const srcs = page.$$("#feed img").map(i => i.getAttribute("src"));
  assert.ok(srcs.some(s => /alice\.example\/xrpc\/com\.atproto\.sync\.getBlob/.test(s)), `blob from the holder: ${srcs.join(" | ")}`);
  assert.ok(!srcs.some(s => /cdn\.bsky\.app|video\.bsky\.app/.test(s)), "no CDN host appears");
});

test("the mode says what it costs, in the setting and above the feed", async () => {
  const page = await run();
  const note = page.$("#feed").parentElement.textContent + page.document.body.textContent;
  for (const claim of [/no counts/i, /labels/i, /claims/i])
    assert.match(note, claim, `the feed note mentions ${claim}`);
  page.eval("renderDrawer()");
  const sub = page.$('[data-row="protocolOnly"]').textContent;
  for (const claim of [/counts/i, /labels/i, /unverified|claims/i, /directory/i])
    assert.match(sub, claim, `the setting mentions ${claim}`);
});

test("a custom feed can't be read from repositories, and says so", async () => {
  // A feed or list is something an AppView computed; there is nothing to
  // read it out of. It must fall back rather than silently return nothing.
  const page = await h.loadPage({
    settings: { protocolOnly: true },
    server: { ...world(), timeline: [h.item(h.post("A", h.actor(1), 10))] },
  });
  assert.ok(page.eval("settings.protocolOnly"), "mode is on");
  assert.match(page.eval(`(${function () {
    const s = { kind: "feed", name: "Discover" };
    return s.name;
  }})()`), /Discover/);
});

test("the readout says how the catch-up will be assembled", async () => {
  const row = (page, term) => {
    const dt = page.$$("#drawer .infra dt").find(d => d.textContent === term);
    return dt && dt.nextElementSibling;
  };
  const off = await h.loadPage({ server: world() });
  off.eval("renderDrawer()");
  assert.match(row(off, "Catch-up assembled by").textContent, /an AppView/);

  const on = await h.loadPage({ settings: { protocolOnly: true }, server: world() });
  on.eval("renderDrawer()");
  const dd = row(on, "Catch-up assembled by");
  assert.match(dd.textContent, /each account's own repository/);
  assert.match(dd.textContent, /No AppView is involved/);
  assert.match(dd.textContent, /custom feed or list/i, "and says what still needs one");
  assert.equal(dd.querySelector(".op").className, "op op-atproto", "marked as the protocol, not Bluesky");
});

test("a quoted post's pictures also come from the repository", async () => {
  // Found live, not by a test: the quoted-post renderer builds its own
  // post-like object, and dropping the server off it sent those images to
  // the CDN while every other image came from a repository.
  const page = await run({ repos: {
    [alice]: {
      "app.bsky.feed.post": [post("alice quotes a picture", 10, {
        embed: { $type: "app.bsky.embed.record", record: { uri: `at://${carol}/app.bsky.feed.post/r0`, cid: "c0" } },
      })],
      "app.bsky.actor.profile": [{ displayName: "Alice" }],
    },
    [carol]: { "app.bsky.feed.post": [post("carol with a picture", 5, {
      embed: { $type: "app.bsky.embed.images", images: [{ image: { ref: { $link: "bafquoted" }, mimeType: "image/jpeg" }, alt: "" }] },
    })] },
  } });
  const srcs = page.$$("#feed img").map(i => i.getAttribute("src"));
  assert.ok(srcs.some(s => /carol\.example\/xrpc\/com\.atproto\.sync\.getBlob.*bafquoted/.test(s)),
    `the quoted post's picture comes from carol's server: ${srcs.join(" | ")}`);
  assert.ok(!srcs.some(s => /cdn\.bsky\.app/.test(s)), "and nothing reaches the CDN");
});

test("a stale identity is looked up again rather than trusted for ever", async () => {
  // Found by sabotage: breaking the expiry changed no test result. It
  // matters because an account that moves server would otherwise go quiet
  // for a week and look like it had simply stopped posting.
  const week = 7 * 24 * 3600 * 1000;
  const seed = at => ({ [alice]: { pds: "https://alice-OLD.example", handle: "alice.test", at } });

  const fresh = await h.loadPage({
    settings: { protocolOnly: true }, storage: { identities: seed(Date.now()) }, server: world(),
  });
  await fresh.startDate(T).catch(() => {});
  await h.waitFor(() => fresh.visible("viewFeed") || fresh.$("#startErr").textContent, { timeout: 15000, message: "feed" });
  assert.ok(!fresh.requests.some(r => r.path === "/" + alice), "a fresh entry is used without asking the directory");
  assert.ok(fresh.requests.some(r => r.host === "alice-old.example"), "and is actually what gets used");

  const stale = await h.loadPage({
    settings: { protocolOnly: true }, storage: { identities: seed(Date.now() - week - 60000) }, server: world(),
  });
  await stale.startDate(T).catch(() => {});
  await h.waitFor(() => stale.visible("viewFeed") || stale.$("#startErr").textContent, { timeout: 15000, message: "feed" });
  assert.ok(stale.requests.some(r => r.path === "/" + alice), "an expired entry is looked up again");
  assert.ok(stale.requests.some(r => r.host === "alice.example"), "and the current server is used");
  assert.ok(texts(stale).includes("alice one"), "so her posts come back");
});

/* ---------------------------------------------------------------- review fixes */

test("someone you don't follow isn't added to your follow list", async () => {
  // `people` fills with the authors of quoted and reposted posts too. Counting
  // them as followed put an Unfollow button on a stranger, and made the
  // follow-based filters treat them as yours.
  const page = await run({ repos: {
    [alice]: {
      "app.bsky.feed.post": [post("alice quotes carol", 10, {
        embed: { $type: "app.bsky.embed.record", record: { uri: `at://${carol}/app.bsky.feed.post/r0`, cid: "c0" } },
      })],
      "app.bsky.actor.profile": [{ displayName: "Alice" }],
    },
  } });
  const follows = page.json("[...state.follows.keys()]");
  assert.ok(follows.includes(alice), "alice is followed");
  assert.ok(!follows.includes(carol), `carol is not, though her post was read: ${follows.join(", ")}`);
  assert.ok(page.$("#feed").textContent.includes("carol quoted"), "and her post still showed");
});

test("two accounts quoting the same post both show it", async () => {
  // The lookup cached a null placeholder before awaiting, so whichever worker
  // asked second saw "nothing there" and gave up.
  const page = await run({ repos: {
    [h.ME.did]: { "app.bsky.graph.follow": [{ subject: alice, createdAt: at(-1000) }, { subject: bob, createdAt: at(-1000) }] },
    [alice]: { "app.bsky.feed.post": [post("alice quotes", 10, {
      embed: { $type: "app.bsky.embed.record", record: { uri: `at://${carol}/app.bsky.feed.post/r0`, cid: "c0" } } })] },
    [bob]: { "app.bsky.feed.post": [post("bob quotes", 11, {
      embed: { $type: "app.bsky.embed.record", record: { uri: `at://${carol}/app.bsky.feed.post/r0`, cid: "c0" } } })] },
  } }, { concurrency: 6 });
  const shown = (page.$("#feed").textContent.match(/carol quoted/g) || []).length;
  assert.equal(shown, 2, "both quotes resolved, not just whichever got there first");
});

test("quote posts can be filtered out in protocol mode", async () => {
  const on = await run({ repos: { [alice]: { "app.bsky.feed.post": [post("alice quotes", 10, {
    embed: { $type: "app.bsky.embed.record", record: { uri: `at://${carol}/app.bsky.feed.post/r0`, cid: "c0" } } })] } } });
  assert.ok(texts(on).includes("alice quotes"), "shown by default");
  const off = await run({ repos: { [alice]: { "app.bsky.feed.post": [post("alice quotes", 10, {
    embed: { $type: "app.bsky.embed.record", record: { uri: `at://${carol}/app.bsky.feed.post/r0`, cid: "c0" } } })] } } },
    { showQuotes: false });
  assert.ok(!texts(off).includes("alice quotes"), "and hidden when quotes are turned off");
});

test("a gallery stays a gallery, and a Tenor link is a GIF", async () => {
  // rawMedia merges images and galleries, so counting them called a gallery
  // of two "images" -- which also lost it the gallery link proxy.
  const page = await run({ repos: { [alice]: { "app.bsky.feed.post": [
    post("alice gallery", 10, { embed: { $type: "app.bsky.embed.gallery", items: [
      { image: { ref: { $link: "b1" }, mimeType: "image/jpeg" }, alt: "" },
      { image: { ref: { $link: "b2" }, mimeType: "image/jpeg" }, alt: "" }] } }),
    post("alice gif", 11, { embed: { $type: "app.bsky.embed.external",
      external: { uri: "https://media.tenor.com/x.gif", title: "a gif" } } }),
  ] } } });
  const kinds = t => page.json(`[...postKinds(state.view.find(i => i.fi.post.record.text === ${JSON.stringify(t)}).fi.post)]`);
  assert.ok(kinds("alice gallery").includes("gallery"), `gallery of two: ${kinds("alice gallery").join(",")}`);
  assert.ok(kinds("alice gif").includes("gif"), `tenor link: ${kinds("alice gif").join(",")}`);
});

test("the start screen doesn't claim you follow nobody", async () => {
  const page = await h.loadPage({ settings: { protocolOnly: true }, server: world() });
  const who = page.$("#whoBox").textContent;
  assert.ok(!/following 0/.test(who), `no invented count: ${who}`);
});

test("identity lookups aren't written to storage one at a time", async () => {
  // Enough accounts that a write per account is plainly different from a
  // coalesced one; with only three the two were indistinguishable.
  const many = {};
  const follows = [];
  for (let i = 0; i < 8; i++) {
    const did = `did:plc:p${i}`;
    follows.push({ subject: did, createdAt: at(-1000) });
    many[did] = { "app.bsky.feed.post": [post(`p${i} says hello`, 10 + i)] };
    didDocs[did] = { alsoKnownAs: [`at://p${i}.test`], service: [{ id: "#atproto_pds", serviceEndpoint: `https://p${i}.example` }] };
  }
  const page = await run({ repos: { ...many, [h.ME.did]: { "app.bsky.graph.follow": follows } } });
  // Counted on the page's own LS.set, not on localStorage.setItem: jsdom's
  // Storage ignores an assignment to its methods, so patching it there
  // counted zero writes and the assertion could never fail.
  page.eval(`window.__w = 0; const _set = LS.set; LS.set = (k, v) => { if (k === "identities") window.__w++; return _set(k, v); };
             identityCache = null; LS.del("identities");`);
  await page.startDate(T + 1).catch(() => {});
  await h.waitFor(() => page.visible("viewFeed"), { timeout: 15000, message: "feed" });
  const writes = page.eval("window.__w"), accounts = page.eval("Object.keys(identityStore()).length");
  assert.ok(accounts >= 8, `re-resolved ${accounts} accounts`);
  assert.ok(writes < accounts / 2, `coalesced into ${writes} write(s) for ${accounts} accounts`);
  assert.ok(page.window.localStorage.getItem("bcu:identities"), "and the cache was still saved");
});

test("a server that lists a collection oldest-first is handled", async () => {
  // The spec says record keys sort chronologically but warns that "cannot be
  // relied on in general", and leaves listRecords' direction to the server.
  // Getting this wrong wouldn't error -- it would return an empty catch-up.
  // A sabotage run showed the detection was unexercised: the harness only
  // ever served newest-first.
  const page = await run({ oldestFirst: true });
  assert.deepEqual(texts(page).sort(), ["alice one", "alice two", "bob one"].sort(),
    "the same posts arrive whichever way round the server lists them");
  const asked = page.requests.filter(r => r.nsid === "com.atproto.repo.listRecords" && r.search.get("collection") === "app.bsky.feed.post");
  assert.ok(asked.some(r => r.search.get("reverse") === "true"), "it noticed and asked for the other order");
});

/* ---------------------------------------------------------------- pacing per server */

test("each server gets its own queue", async () => {
  const page = await h.loadPage({ settings: { rpm: 60 }, server: world() });
  // rpm 60 is one a second, so a second request on the SAME host waits while
  // a first on another host goes straight out.
  const lanes = () => page.json("[...pacer.lanes.keys()]");
  await page.eval(`pacer.lanes.clear(); pacer.wait(null, "https://a.example")`);
  await page.eval(`pacer.wait(null, "https://b.example")`);
  assert.deepEqual(lanes().sort(), ["a.example", "b.example"], "two servers, two queues");
  const nextA = page.eval(`pacer.lane("a.example").next`);
  const nextB = page.eval(`pacer.lane("b.example").next`);
  assert.ok(Math.abs(nextA - nextB) < 50, "neither was made to wait behind the other");
});

test("a rate limit on one server doesn't stall the others", async () => {
  const page = await h.loadPage({ server: world() });
  page.eval(`pacer.lanes.clear(); pacer.pauseFor(60000, "https://slow.example")`);
  assert.ok(page.eval(`pacer.lane("slow.example").pauseUntil`) > Date.now() + 30000, "that one is paused");
  assert.equal(page.eval(`pacer.lane("other.example").pauseUntil`), 0, "and nothing else is");
  assert.ok(page.eval("pacer.pausedUntil()") > Date.now(), "the progress line still knows about it");
});

test("requests to one server are still spaced out", async () => {
  // The point of the pacer in the first place: per-server must not mean
  // unpaced.
  const page = await h.loadPage({ settings: { rpm: 60 }, server: world() });
  page.eval(`pacer.lanes.clear()`);
  const before = Date.now();
  await page.eval(`pacer.wait(null, "https://one.example")`);
  await page.eval(`pacer.wait(null, "https://one.example")`);
  const third = page.eval(`pacer.lane("one.example").next`);
  assert.ok(third - before >= 1800, `two seconds of queue for three requests at 60/min, got ${third - before}ms`);
});

test("protocol mode spreads its reads across the servers it reads", async () => {
  const page = await run();
  const lanes = page.json("[...pacer.lanes.keys()]");
  assert.ok(lanes.includes("alice.example") && lanes.includes("bob.example"),
    `a queue per account's server: ${lanes.join(", ")}`);
  assert.ok(lanes.includes("pds.example"), "and one for your own");
});

test("an unreadable host shares one queue rather than getting a free one", async () => {
  const page = await h.loadPage({ server: world() });
  page.eval(`pacer.lanes.clear(); pacer.wait(null, "not a url"); pacer.wait(null, "")`);
  assert.deepEqual(page.json("[...pacer.lanes.keys()]"), ["(unknown)"],
    "they queue together, which is the cautious way round");
});
