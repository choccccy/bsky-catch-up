/*
 * Test harness for the Bluesky Catch-up page.
 *
 * Loads the page's HTML into jsdom with a SIMULATED Bluesky API (no network
 * access), so tests can sign in, load feeds, click things and inspect the
 * DOM. Everything Bluesky-shaped here follows the app.bsky / com.atproto
 * lexicons; if Bluesky's real responses differ, fix the page AND the
 * builders below, and add a test.
 *
 * Which HTML file is tested:
 *   - $CATCHUP_HTML if set (path to the file), else
 *   - index.html in the parent folder, if present, else
 *   - the highest-versioned bluesky-catchup*.html in the parent folder.
 *
 * Basic use:
 *   const h = require("./harness");
 *   const page = await h.loadPage({ server: { timeline: [...] } });
 *   await page.startDate(h.BASE);           // like using the start screen
 *   assert.deepEqual(page.ids(), ["A", "B"]);
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { after } = require("node:test");

/* Every page opened by a test file is closed when that file's tests finish;
   otherwise the page's timers keep the test process alive. */
const openPages = new Set();
after(() => { for (const p of openPages) p.close(); });

/* ---------------------------------------------------------------- page file */
function findPage() {
  if (process.env.CATCHUP_HTML) return path.resolve(process.env.CATCHUP_HTML);
  const dir = path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(dir, "index.html"))) return path.join(dir, "index.html");
  const files = fs.readdirSync(dir).filter(f => /^bluesky-catchup.*\.html$/.test(f));
  if (!files.length) throw new Error(`No index.html or bluesky-catchup*.html found in ${dir}. Set CATCHUP_HTML to the page's path.`);
  const ver = f => (f.match(/v(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  files.sort((a, b) => { const x = ver(a), y = ver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return path.join(dir, files[files.length - 1]);
}
const PAGE_PATH = findPage();
// External scripts/fonts can't load in tests; the page must work without them.
const PAGE_HTML = fs.readFileSync(PAGE_PATH, "utf8")
  .replace(/<script src=[^>]*><\/script>/g, "")
  .replace(/<link [^>]*>/g, "");

/* ---------------------------------------------------------------- data builders */
const MIN = 60e3;
/** All test timestamps are relative to this: about 3 hours ago, rounded down
 *  to a whole minute (the start screen's date inputs have minute precision,
 *  so tests that type times into them stay exact). */
const BASE = Math.floor((Date.now() - 3 * 3600e3) / MIN) * MIN;
const iso = t => new Date(t).toISOString();

/** A profile view. n can be a number or a string id. */
function actor(n, extra = {}) {
  return { did: `did:plc:u${n}`, handle: `u${n}.test`, displayName: `User ${n}`, viewer: {}, ...extra };
}
/** The signed-in user. */
const ME = { did: "did:plc:me", handle: "me.test", displayName: "Me" };

/**
 * A post view. id becomes the rkey and the text ("post <id>"), so tests can
 * identify posts in the DOM. min = minutes after BASE.
 * opts: { replyTo: parentPostView, embed, likeCount, viewer, labels, text }
 */
function post(id, author, min, opts = {}) {
  const t = iso(BASE + min * MIN);
  const record = { $type: "app.bsky.feed.post", text: opts.text ?? `post ${id}`, createdAt: t };
  if (opts.replyTo) record.reply = { parent: { uri: opts.replyTo.uri, cid: opts.replyTo.cid }, root: { uri: opts.replyTo.uri, cid: opts.replyTo.cid } };
  if (opts.facets) record.facets = opts.facets;
  // The raw embed as stored in the post record (blob refs, not view URLs).
  // The API omits embed VIEWS for posts nested deeper than a quote, so pages
  // fall back to this; see raw.* below.
  if (opts.rawEmbed) record.embed = opts.rawEmbed;
  return {
    uri: `at://${author.did}/app.bsky.feed.post/${id}`, cid: `cid-${id}`, author, record, indexedAt: t,
    likeCount: opts.likeCount ?? 0, repostCount: opts.repostCount ?? 0, replyCount: 0, quoteCount: 0,
    viewer: opts.viewer ?? {}, labels: opts.labels ?? [], ...(opts.embed ? { embed: opts.embed } : {}),
  };
}
/** A feed entry (feedViewPost). opts.parent = parent post view (for replies);
 *  opts.root = the thread's first post (defaults to the parent, which is
 *  right for direct replies to a top-level post);
 *  opts.repostBy + opts.repostMin make it a repost. */
function item(p, opts = {}) {
  const fi = { post: p };
  // Reply context as the AppView sends it: pass the parent post view.
  if (opts.parent) fi.reply = { parent: { $type: "app.bsky.feed.defs#postView", ...opts.parent }, root: { $type: "app.bsky.feed.defs#postView", ...(opts.root || opts.parent) } };
  if (opts.repostBy) fi.reason = { $type: "app.bsky.feed.defs#reasonRepost", by: opts.repostBy, indexedAt: iso(BASE + opts.repostMin * MIN), uri: `at://${opts.repostBy.did}/app.bsky.feed.repost/r-${p.cid}` };
  return fi;
}
/** Embed views. */
const embeds = {
  /**
   * An images embed (1-4). Real app.bsky.embed.images#view entries carry an
   * aspectRatio, so these do too; pass one {width,height} for every image, or
   * an array to give each its own (used by the whole-image layout tests).
   */
  images: (n, ar = { width: 4, height: 3 }) => ({ $type: "app.bsky.embed.images#view", images: Array.from({ length: n }, (_, i) => ({
    thumb: `thumb${i + 1}.jpg`, fullsize: `full${i + 1}.jpg`, alt: i === 0 ? "first image" : "",
    aspectRatio: Array.isArray(ar) ? ar[i] : ar,
  })) }),
  gallery: n => ({ $type: "app.bsky.embed.gallery#view", items: Array.from({ length: n }, (_, i) => ({ $type: "app.bsky.embed.gallery#viewImage", thumbnail: `gthumb${i + 1}.jpg`, fullsize: `gfull${i + 1}.jpg`, alt: i === 1 ? "second" : "", aspectRatio: { width: 4, height: 3 } })) }),
  video: () => ({ $type: "app.bsky.embed.video#view", cid: "vid", playlist: "https://video.example/playlist.m3u8", thumbnail: "vthumb.jpg", aspectRatio: { width: 16, height: 9 } }),
  /** An uploaded GIF, which Bluesky stores as a video with presentation "gif". */
  gifVideo: () => ({ ...embeds.video(), presentation: "gif" }),
  link: (uri = "https://example.com/article") => ({ $type: "app.bsky.embed.external#view", external: { uri, title: "An article", description: "About things", thumb: "lthumb.jpg" } }),
  gif: () => embeds.link("https://media.tenor.com/abc/funny.gif"),
  quote: p => ({ $type: "app.bsky.embed.record#view", record: viewRecord(p) }),
  unknown: () => ({ $type: "app.bsky.embed.somethingNew#view" }),
};
/** Raw record embeds (what's stored in a post record). */
const blob = (cid, mimeType = "image/jpeg") => ({ $type: "blob", ref: { $link: cid }, mimeType, size: 1000 });
const raw = {
  images: n => ({ $type: "app.bsky.embed.images", images: Array.from({ length: n }, (_, i) => ({ image: blob(`bafyimg${i + 1}`), alt: i === 0 ? "first" : "" })) }),
  video: (gif = false) => ({ $type: "app.bsky.embed.video", video: blob("bafyvid", "video/mp4"), ...(gif ? { presentation: "gif" } : {}) }),
  link: () => ({ $type: "app.bsky.embed.external", external: { uri: "https://example.com/a", title: "An article", description: "" } }),
  quote: p => ({ $type: "app.bsky.embed.record", record: { uri: p.uri, cid: p.cid } }),
};
/** An embedded-record view of a post (what quotes contain: counts, no viewer). */
function viewRecord(p) {
  return { $type: "app.bsky.embed.record#viewRecord", uri: p.uri, cid: p.cid, author: p.author, value: p.record, indexedAt: p.indexedAt,
    likeCount: p.likeCount, repostCount: p.repostCount, replyCount: 0, quoteCount: 0, labels: [], embeds: p.embed ? [p.embed] : [] };
}

/* ---------------------------------------------------------------- simulated server */
/**
 * server options (all optional):
 *   follows:      profile views returned by getFollows (default: actors 1-5)
 *   timeline:     feedViewPosts, any order (sorted newest-first here)
 *   timelineLimit: stop serving the timeline after this many entries
 *   authorFeeds:  { did: [feedViewPost...] } for rebuild mode (default:
 *                 derived from `timeline` by author/reposter)
 *   posts:        { uri: postView } served by getPosts (default: from timeline)
 *   handles:      { handle: did } for resolveHandle
 *   offline:      true = every request fails like a blocked connection
 *   handlers:     { "nsid.method": (params, body) => response | {status, error} }
 *                 overrides for anything
 */
function makeServer(opts, calls) {
  const follows = opts.follows || [1, 2, 3, 4, 5].map(n => actor(n));
  const sortAt = fi => Date.parse(fi.reason?.indexedAt || fi.post.indexedAt);
  // Computed on every request, so tests can add posts to opts.timeline later
  // (e.g. to test "Load newer posts").
  const timeline = () => [...(opts.timeline || [])].sort((a, b) => sortAt(b) - sortAt(a));
  const served = opts.timelineLimit ?? Infinity;
  const authorFeeds = () => opts.authorFeeds || (() => {
    const m = {};
    for (const fi of timeline()) { const did = fi.reason ? fi.reason.by.did : fi.post.author.did; (m[did] ||= []).push(fi); }
    return m;
  })();
  const posts = () => ({ ...Object.fromEntries(timeline().map(fi => [fi.post.uri, fi.post])), ...(opts.posts || {}) });
  const page = (list, params) => {
    const start = Number(params.get("cursor") || 0), limit = Number(params.get("limit") || 50);
    const slice = list.slice(start, start + limit);
    return { feed: slice, cursor: start + limit < list.length ? String(start + limit) : undefined };
  };
  const records = [];
  const routes = {
    "com.atproto.identity.resolveHandle": p => {
      const h = p.get("handle");
      if (h === ME.handle) return { did: ME.did };
      const did = opts.handles?.[h] || follows.find(f => f.handle === h)?.did;
      return did ? { did } : { status: 400, error: "InvalidRequest", message: "Unable to resolve handle" };
    },
    "com.atproto.server.createSession": (p, body) => body?.password === "wrong" ? { status: 401, error: "AuthenticationRequired" } : { did: ME.did, handle: ME.handle, accessJwt: "access", refreshJwt: "refresh" },
    "com.atproto.server.refreshSession": () => ({ accessJwt: "access2", refreshJwt: "refresh2" }),
    "com.atproto.server.deleteSession": () => ({}),
    "app.bsky.actor.getProfile": () => ({ ...ME, followsCount: follows.length }),
    "app.bsky.graph.getFollows": p => { const s = Number(p.get("cursor") || 0); return { follows: follows.slice(s, s + 100), cursor: s + 100 < follows.length ? String(s + 100) : undefined }; },
    "app.bsky.feed.getTimeline": p => page(timeline().slice(0, served), p),
    "app.bsky.feed.getAuthorFeed": p => page(authorFeeds()[p.get("actor")] || [], p),
    "app.bsky.feed.getPosts": p => { const all = posts(); return { posts: p.getAll("uris").map(u => all[u]).filter(Boolean) }; },
    "com.atproto.repo.createRecord": (p, body) => { const uri = `at://${ME.did}/${body.collection}/rec${records.length}`; records.push({ uri, ...body }); return { uri, cid: "c" }; },
    "com.atproto.repo.deleteRecord": (p, body) => {
      const i = records.findIndex(r => r.uri === `at://${body.repo}/${body.collection}/${body.rkey}`);
      if (i >= 0) records.splice(i, 1);
      return {};
    },
    "com.atproto.repo.getRecord": p => {
      const uri = `at://${p.get("repo")}/${p.get("collection")}/${p.get("rkey")}`;
      const r = records.find(x => x.uri === uri);
      return r ? { uri, cid: "c", value: r.record } : { status: 400, error: "RecordNotFound", message: `Could not locate record: ${uri}` };
    },
    ...(opts.handlers || {}),
  };
  const fetchFn = async function fetch(url, init = {}) {
    const u = new URL(url);
    const nsid = u.pathname.replace(/^\/xrpc\//, "");
    calls.push(u.host === "plc.directory" ? "plc.directory" : nsid);
    if (opts.offline) throw new TypeError("Failed to fetch");
    const json = (status, obj) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u.host === "plc.directory") return json(200, { service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.example" }] });
    const route = routes[nsid];
    if (!route) return json(404, { error: "MethodNotImplemented" });
    let body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch {}
    const res = await route(u.searchParams, body);
    if (res && res.status >= 400) return json(res.status, { error: res.error, message: res.message });
    return json(200, res);
  };
  fetchFn.records = records;   // records created in the simulated repo (likes, reposts)
  return fetchFn;
}

/* ---------------------------------------------------------------- loading the page */
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 4000, step = 20, message = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn(); if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await wait(step);
  }
}

/**
 * Loads the page. Options:
 *   url:      page address, including any #fragment (default https://example.test/)
 *   session:  true = already signed in (default), false = signed out
 *   settings: saved settings object (merged over test defaults: fast pacing,
 *             timeline-only fetching). Pass null for no saved settings at all.
 *   storage:  extra localStorage entries { key: value } (keys without "bcu:")
 *   server:   simulated server options (see makeServer)
 * Returns a page object with helpers (see bottom of this function).
 */
async function loadPage({ url = "https://example.test/", session = true, settings = {}, storage = {}, server = {} } = {}) {
  const calls = [];
  const clip = [];
  const observers = [];
  const dom = new JSDOM(PAGE_HTML, {
    url, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = makeServer(server, calls);
      w.__records = w.fetch.records;
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.structuredClone = structuredClone;
      w.CSS = { escape: s => String(s).replace(/["\\]/g, "\\$&") };
      w.scrollBy = () => {}; w.scrollTo = () => {};
      w.IntersectionObserver = class { constructor(cb, o) { this.cb = cb; this.opts = o || {}; this.targets = []; observers.push(this); } observe(t) { this.targets.push(t); } unobserve() {} disconnect() { this.targets = []; } };
      Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async t => { clip.push(t); } } });
      w.HTMLMediaElement.prototype.play = function () { this.dispatchEvent(new w.Event("play")); return Promise.resolve(); };
      w.HTMLMediaElement.prototype.pause = function () {};
      w.HTMLMediaElement.prototype.load = function () {};
      // Minimal hls.js stand-in, recording what the page asks of it.
      w.__hls = [];
      w.Hls = class { static isSupported() { return true; } constructor(c) { this.config = c; this.destroyed = false; w.__hls.push(this); } on() {} loadSource(s) { this.src = s; } attachMedia(v) { this.media = v; } destroy() { this.destroyed = true; } };
      w.Hls.Events = { ERROR: "hlsError" };
      if (session) w.localStorage.setItem("bcu:session", JSON.stringify({ did: ME.did, handle: ME.handle, pds: "https://pds.example", accessJwt: "access", refreshJwt: "refresh" }));
      if (settings !== null) w.localStorage.setItem("bcu:settings", JSON.stringify({ _v: 2, rpm: 3000, fetchMethod: "timeline", ...settings }));
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem("bcu:" + k, JSON.stringify(v));
    },
  });
  const w = dom.window, d = w.document;
  const $ = s => d.querySelector(s), $$ = s => [...d.querySelectorAll(s)];
  const visible = id => !d.getElementById(id).classList.contains("hidden");
  // Let boot() finish (it may validate the session or start a linked catch-up).
  await waitFor(() => visible("viewLogin") || visible("viewStart") || visible("viewFeed") || visible("viewProgress"), { message: "boot" });
  await wait(30);

  const pageObj = {
    window: w, document: d, calls, clip, observers, $, $$, visible,
    eval: code => w.eval(code),
    /** Evaluates an expression in the page and returns a plain copy (use this
     *  for arrays/objects: values from the page's realm fail deepStrictEqual). */
    json: expr => JSON.parse(w.eval(`JSON.stringify(${expr})`)),
    /** Post ids ("post <id>" texts) of main posts in the feed, in order. */
    ids: () => $$("#feed .post").map(el => el.querySelector(":scope > .pv:last-child .pv-text").textContent.replace(/^post /, "")),
    /** The <article> for a post id. */
    article: id => $$("#feed .post").find(el => el.querySelector(":scope > .pv:last-child .pv-text").textContent === `post ${id}`),
    toast: () => $("#toast").textContent,
    /** Records created in the simulated repo (likes, reposts). */
    records: () => w.__records,
    banner: () => (visible("banner") ? $("#bannerText").textContent : ""),
    /** Waits until the feed (or an error on the start screen) is showing. */
    async settle() { await waitFor(() => visible("viewFeed") || $("#startErr").textContent || visible("viewLogin"), { message: "feed or error" }); await wait(30); },
    /** Uses the start screen: start from a date (ms), optional end {date: ms} or {post: url}. */
    async startDate(t, end) { return pageObj.start("date", t, end); },
    async startPost(link, end) { return pageObj.start("post", link, end); },
    async start(kind, value, end) {
      if (!visible("viewStart")) { $("#btnNew")?.click(); await wait(10); }
      const loc = t => { const x = new Date(t); return new Date(x - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
      $(`input[name="kind"][value="${kind}"]`).checked = true;
      if (kind === "date") $("#inDate").value = loc(value);
      if (kind === "post") $("#inPost").value = value;
      const useEnd = $("#inUseEnd"); useEnd.checked = !!end; useEnd.dispatchEvent(new w.Event("change"));
      if (end?.date != null) { $('input[name="endKind"][value="date"]').checked = true; $("#inEndDate").value = loc(end.date); }
      if (end?.post) { $('input[name="endKind"][value="post"]').checked = true; $("#inEndPost").value = end.post; }
      $("#btnLoad").click();
      await pageObj.settle();
    },
    /** Changes a setting through the settings drawer, like a user would. */
    async setSetting(key, value) {
      if (!visible("drawer")) $("#btnSettings").click();
      const els = $$(`#drawer [data-k="${key}"]`);
      if (!els.length) throw new Error(`No setting control for ${key}`);
      if (els[0].type === "checkbox" && els.length > 1) els.forEach(el => { el.checked = value.includes(el.value); });
      else if (els[0].type === "checkbox") els[0].checked = value;
      else els[0].value = value;
      els[0].dispatchEvent(new w.Event("input", { bubbles: true }));
      await wait(320); // render-type settings are debounced (250ms)
    },
    /** Saved settings as stored. */
    saved: () => JSON.parse(w.localStorage.getItem("bcu:settings") || "null"),
    close: () => { openPages.delete(pageObj); w.close(); },
  };
  openPages.add(pageObj);
  return pageObj;
}

module.exports = { loadPage, findPage, PAGE_PATH, BASE, MIN, iso, ME, actor, post, item, embeds, raw, viewRecord, wait, waitFor };
