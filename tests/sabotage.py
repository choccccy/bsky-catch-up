#!/usr/bin/env python3
"""Break each guard in index.html on purpose, and check a test goes red.

A test that cannot fail is worse than none: it reads like coverage and isn't.
So for every guard that matters, this makes one small, surgical change to a
COPY of the page -- removing the check, reverting the fix, loosening the
validation -- and runs the suite against that copy. A guard whose sabotage
leaves every test passing is a guard nothing is actually holding.

    python3 sabotage.py --check      anchors only, about a second
    python3 sabotage.py              the real thing, a few minutes
    python3 sabotage.py --only dns   just the guards whose name matches
    python3 sabotage.py --workers 2  fewer at once, if the machine is busy

Guards run several at a time, each against its own copy of the page. Before
any of them, the UNMODIFIED page is run under the same conditions as a
control: if the suite can't pass while the machine is loaded, then every
guard would "fail" for that reason instead of its own, and the whole run
would report RED and prove nothing. A failing control stops the run.

index.html is never modified; the sabotaged copy goes to a temp file.

WHY --check EXISTS. Each entry is (name, old, new), and `old` must appear in
index.html EXACTLY ONCE. That couples this list to the source text, so an
ordinary refactor can stop an anchor matching -- and then the entry reports
SKIP, which proves nothing while looking like one more line in a wall of
output. That has happened twice. Run --check after any refactor, and don't
trust an older full run until it passes.

Exit status is non-zero if anything was skipped or survived, so this can gate
a push; the workflow runs --check on every one.
"""
import concurrent.futures
import os
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = pathlib.Path(os.environ.get("CATCHUP_REPO", HERE.parent))

GUARDS = [
    ('header never sent',
     '      if (proxy) headers["atproto-proxy"] = proxy;',
     ''),
    ('header sent on com.atproto too',
     'const proxy = method.startsWith("app.bsky.") ? appViewTarget() : null;',
     'const proxy = appViewTarget();'),
    ('marks ignore which side runs it',
     'const href = MARK_DOCS[term]?.[op];',
     'const href = MARK_DOCS[term]?.atproto;'),
    ('marks all point at one front door',
     'const href = MARK_DOCS[term]?.[op];',
     'const href = ATPROTO_DOCS;'),
    ('classifier calls everything Bluesky',
     'const isBlueskyHost = host => !!host && BLUESKY_HOSTS.some(re => re.test(String(host)));',
     'const isBlueskyHost = host => !!host;'),
    ('classifier never finds Bluesky',
     'function operatorOf(host) { return host == null ? null : isBlueskyHost(host) ? "bluesky" : "atproto"; }',
     'function operatorOf(host) { return host == null ? null : "atproto"; }'),
    ('marks claim an operator for unknown rows',
     'const m = OPERATOR_MARK[op]; if (!m) return "";',
     'const m = OPERATOR_MARK[op] || OPERATOR_MARK.bluesky;',
     'the line below it already suppresses the mark: MARK_DOCS[term]?.[op] is '
     'undefined for an operator nothing knows, so no test can tell the two '
     'versions apart. Kept as a guard against a future MARK_DOCS key with no '
     'matching OPERATOR_MARK entry, which would otherwise throw on m[1].'),
    ('appView validation removed',
     '    if (!/^did:[a-z]+:[A-Za-z0-9._%:-]+(#[A-Za-z0-9._-]+)?$/.test(v)) return null;',
     '    if (false) return null;'),
    ('appView host fallback removed',
     '  const host = hostFromSetting(v);\n  // A did:web can\'t contain a bare colon: a port is percent-encoded.\n  return host ? `did:web:${host.replace(":", "%3A")}#bsky_appview` : null;',
     '  return `did:web:${v}#bsky_appview`;'),
    ('post links hardcode bsky.app',
     'const postLinkFor = (actor, rkey) => `https://${webLinkHost()}/profile/${actor}/post/${rkey}`;',
     'const postLinkFor = (actor, rkey) => `https://bsky.app/profile/${actor}/post/${rkey}`;'),
    ('profile links hardcode bsky.app',
     'const profileLinkFor = actor => `https://${webLinkHost()}/profile/',
     'const profileLinkFor = actor => `https://bsky.app/profile/'),
    ('share swap hardcodes bsky.app',
     'return { url: url.replace(`https://${web}/`, `https://${host}/`), proxied: host };',
     'return { url: url.replace("https://bsky.app/", `https://${host}/`), proxied: host !== "bsky.app" ? host : false };'),
    ('Bluesky asked first',
     '  if (appView) tries.push({ url: xrpcUrl(appView), where: appView, timeoutMs: 15000, read: fromJson });\n  tries.push({ url: xrpcUrl("public.api.bsky.app"), where: "Bluesky\'s servers", timeoutMs: 15000, read: fromJson });',
     '  tries.unshift({ url: xrpcUrl("public.api.bsky.app"), where: "Bluesky\'s servers", timeoutMs: 15000, read: fromJson });\n  if (appView) tries.push({ url: xrpcUrl(appView), where: appView, timeoutMs: 15000, read: fromJson });'),
    ('network errors swallowed',
     '  if (netErr) throw netErr;',
     '  if (false) throw netErr;'),
    ('media hosts ignore the AppView',
     '  return /^api\\./i.test(host) ? prefix + host.slice(3) : null;',
     '  return `${prefix}.bsky.app`;'),
    ('sign-in links never rewritten',
     '  for (const a of $$("[data-weblink]")) a.href = `https://${host}${a.dataset.weblink}`;',
     '  for (const a of []) a.href = `https://${host}${a.dataset.weblink}`;'),
    ('webHost made shareable',
     '  { key: "webHost", label: "Web front-end for links"',
     '  { key: "webHost", link: true, label: "Web front-end for links"'),
    ('AppView 5xx retried into the ground',
     '    if (res.status >= 500 && proxy && ++appViewFails > 1) {',
     '    if (false) {'),
    ('readout assumes Bluesky when unset',
     '  rows.push(["AppView", target || null, target',
     '  rows.push(["AppView", target || "did:web:api.bsky.app#bsky_appview", target'),
    ('readout never refreshes',
     'if (READOUT_SETTINGS.has(s.key)) refreshProtocolReadout();',
     ''),
    ('readout refresh redraws the whole drawer',
     '  if (row) dl.innerHTML = infraRows(row);',
     '  if (row) renderDrawer();'),
    ('docs links can point anywhere',
     'const docsHtml = docs => !docs?.length ? "" :\n  `<span class="docs">${docs.map(([label, path]) => `<a href="${esc(ATPROTO_DOCS + path)}"',
     'const docsHtml = docs => !docs?.length ? "" :\n  `<span class="docs">${docs.map(([label, path]) => `<a href="${esc("https://bsky.app/" + path)}"'),
    ('unknown rows stop explaining themselves',
     '    : "Recorded when you sign in: your own domain if it publishes a DID, otherwise the AppView, otherwise Bluesky\'s public API.",',
     '    : "",'),
    ('resolution order reverted (file beats DNS)',
     'if (looksLikeDomain) tries.push({ url: `https://${handle}/.well-known/atproto-did`',
     'if (looksLikeDomain) tries.unshift({ url: `https://${handle}/.well-known/atproto-did`'),
    ('server-address error loses its hint',
     'or leave it empty, or try https://bsky.social, and the page will work the rest out.',
     'Check it and try again.'),
    ('DNS step removed',
     'if (looksLikeDomain && doh) tries.push({',
     'if (false) tries.push({'),
    ('DNS answer quotes not stripped',
     'const joined = (data.match(/"[^"]*"/g) || [data]).map(x => x.replace(/^"|"$/g, "")).join("");',
     'const joined = data;'),
    ('DNS answer believed without checking it is a DID',
     'const m = /^did=(did:[a-z]+:\\S+)$/.exec(joined.trim());',
     'const m = /^did=(.+)$/.exec(joined.trim());'),
    ('named server still does a lookup',
     'if (named) pds = named;\n  else try { pds = (await resolvePds(handle)).pds; }',
     'if (named) pds = named;\n  try { pds = (await resolvePds(handle)).pds; }'),
    ('bad server address silently replaced',
     'if (String(server ?? "").trim() && !named) throw new Error',
     'if (false) throw new Error'),
    ('directory setting ignored',
     'const dir = plcDirectory();',
     'const dir = "https://plc.directory";'),
    ('directory has no fallback',
     'return endpointFromSetting(settings.plcDirectory) || DEFAULTS.plcDirectory;',
     'return endpointFromSetting(settings.plcDirectory);'),
    ('insecure endpoints allowed',
     'if (u.protocol !== "https:"',
     'if (false'),
    ('resolver mislabelled as the open protocol',
     ': s.resolvedVia === dohHost() ? "other"',
     ': false ? "other"'),
    ('About block stops naming the resolver',
     'dohHost() && `asks ${dohHost()} to resolve handles`',
     'false'),
    ('did:web path form broken',
     'const path = parts.length > 1 ? parts.slice(1).map(encodeURIComponent).join("/") + "/did.json" : ".well-known/did.json";',
     'const path = ".well-known/did.json";'),
    ('post parser accepts only bsky.app',
     '  m = s.replace(/^https?:\\/\\//i, "").match(/^[\\w.-]+\\/profile\\/([^/]+)\\/post\\/([^/?#\\s]+)/);',
     '  m = s.match(/bsky\\.app\\/profile\\/([^/]+)\\/post\\/([^/?#\\s]+)/);'),
    ('protocol mode still asks an AppView for follows',
     'const needFollows = !protocolRun(src) && (settings.replies === "followed"',
     'const needFollows = (settings.replies === "followed"'),
    ('protocol mode reads everyone from one server',
     'await pageCollection(person.pds, did, "app.bsky.feed.post", until, signal, async rec => {',
     'await pageCollection(state.session.pds, did, "app.bsky.feed.post", until, signal, async rec => {'),
    ('reposts resolved against the wrong repository',
     'const person = await personFor(ref.did).catch(() => null);',
     'const person = await personFor(me()).catch(() => null);'),
    ('identity cache never used',
     '  const hit = cachedIdentity(did);\n  if (hit) return hit;',
     '  const hit = null;\n  if (hit) return hit;'),
    ('identity cache never expires',
     'return e && Date.now() - e.at < IDENTITY_TTL ? e : null;',
     'return e || null;'),
    ('future-dated records trusted',
     '    indexedAt: new Date(fetchedAt).toISOString(),',
     '    indexedAt: rec.value?.createdAt,'),
    ('pictures fall back to the CDN in protocol mode',
     'const cdnImg = (kind, did, cid, pds) => {\n  if (pds) return blobUrl(pds, did, cid);',
     'const cdnImg = (kind, did, cid, pds) => {\n  if (false) return blobUrl(pds, did, cid);'),
    ('listRecords order never checked',
     '    if (page === 0 && reverse === undefined && recs.length > 1 && recs[0].t < recs[recs.length - 1].t) {',
     '    if (false) {'),
    ('unreachable accounts fail the whole catch-up',
     '      catch (e) { if (isAbort(e) || signal?.aborted) throw e; failures.push(did); }\n      done++; onProgress?.({ done, total: dids.length, count: out.length });',
     '      catch (e) { throw e; }\n      done++; onProgress?.({ done, total: dids.length, count: out.length });'),
    ('pacer shares one queue across servers',
     '    const l = this.lane(hostOf(host));\n    const interval = 60000',
     '    const l = this.lane("all");\n    const interval = 60000'),
    ('a rate limit pauses every server',
     '  pauseFor(ms, host) {\n    const l = this.lane(hostOf(host));',
     '  pauseFor(ms, host) {\n    const l = this.lane("all");'),
    ('pacing removed altogether',
     '    l.next = t + interval;',
     '    l.next = now;'),
    ('an unreadable host gets a queue of its own',
     "  return /^[a-z0-9.:-]+$/i.test(v) ? v : \"(unknown)\";",
     "  return v;"),
    ('follow list takes in everyone it read',
     'const followed = new Set(dids);',
     'const followed = new Set([...dids, ...people.keys()]);'),
    ('post lookups cache a null placeholder again',
     '    posts.set(uri, p);\n    return p;\n  }',
     '    posts.set(uri, null);\n    return p;\n  }'),
    ('quote filter blind to raw records',
     '  const raw = p?.record?.embed, t = raw?.$type;',
     '  const raw = null, t = undefined;'),
    ('a gallery is counted as loose images',
     'kinds.add(String(media?.$type).startsWith("app.bsky.embed.gallery") ? "gallery" : "images");',
     'kinds.add(m.images.length > 4 ? "gallery" : "images");'),
    ('a Tenor link is not recognised as a GIF',
     '      kinds.add(host === "media.tenor.com" ? "gif" : "link");\n    }',
     '      kinds.add("link");\n    }'),
    ('readout refresh re-inserts the intro',
     '  if (row) dl.innerHTML = infraRows(row);',
     '  if (row) dl.outerHTML = infoHtml(row);'),
    ('readout only follows two of its settings',
     'if (READOUT_SETTINGS.has(s.key)) refreshProtocolReadout();',
     'if (s.key === "webHost" || s.key === "appView") refreshProtocolReadout();'),
    ('an unknowable AppView host falls back to Bluesky',
     '  if (!appViewTarget()) return `${prefix}.bsky.app`;\n  const host = appViewHost();\n  if (!host) return null;',
     '  const host = appViewHost();\n  if (!host) return `${prefix}.bsky.app`;'),
    ('resolution source survives a failed sign-in',
     '  lastResolvedVia = null;\n  handle = handle.trim().replace(/^@/, "");',
     '  handle = handle.trim().replace(/^@/, "");'),
    ('identity writes are not coalesced',
     '  if (!identitySaveTimer) identitySaveTimer = setTimeout(saveIdentities, 2000);',
     '  LS.set("identities", identityCache);'),
    ('listRecords order detection removed',
     '    if (page === 0 && reverse === undefined && recs.length > 1 && recs[0].t < recs[recs.length - 1].t) {',
     '    if (false) {'),
    ('short row spans are never put right',
     'function fixIfShort(el) { if (spanFor(el) > spanOf(el)) setSpan(el); }',
     'function fixIfShort(el) {}'),
    ('a band that runs out of grid lines is never re-rowed',
     '    if (past <= 1 || row >= MAX_TILE_ROW) return;',
     '    if (true) return;'),
    ('spans ignore their own band\'s row height',
     'function spanFor(el) { return Math.max(1, Math.ceil(itemHeight(el) / rowOf(el))); }',
     'function spanFor(el) { return Math.max(1, Math.ceil(itemHeight(el) / TILE_ROW)); }'),
    ('a fresh batch never checks whether its band overflowed',
     '  for (const band of new Set(placed.map(el => el.parentElement))) fitBand(band);',
     '  for (const band of new Set(placed.map(el => el.parentElement))) {}'),
    ('the feed is never checked as a whole once scrolling stops',
     'schedulePreload(); sweepSpans(); sweepSpansSoon(); }',
     'schedulePreload(); sweepSpans(); }'),
    ('scrolling stops sweeping the spans on screen',
     'schedulePreload(); sweepSpans(); sweepSpansSoon(); }',
     'schedulePreload(); sweepSpansSoon(); }'),
    ('a late picture no longer re-measures its tile',
     '  if (el && tileOn() && feedEl().contains(el)) fixIfShort(el);',
     '  if (false) fixIfShort(el);'),
    ('drawer shifts the page even when it costs a column',
     'return left >= MIN_SHIFT_ROOM && effectiveCols(left) === effectiveCols(full);',
     'return left >= MIN_SHIFT_ROOM;'),
    ('drawer shift ignores whether tiling is on',
     'return settings.tile === true && n >= 2 ? n : 1;',
     'return n;'),
    ('drawer shift squeezes a narrow window',
     'return left >= MIN_SHIFT_ROOM && effectiveCols(left)',
     'return true && effectiveCols(left)'),
    ('a layout setting changed with settings open is not re-decided',
     '  if (!isHidden("#drawer")) setDrawerShift(true);\n  syncDependents();',
     '  syncDependents();'),
    ('setting text stops being escaped',
     'return esc(text).replace(/\\[([^\\]]+)\\]\\(([a-zA-Z]+)\\)/g,',
     'return String(text).replace(/\\[([^\\]]+)\\]\\(([a-zA-Z]+)\\)/g,'),
    ('a setting can link anywhere',
     'DOC[name] ? `<a href="${esc(DOC[name])}"',
     'true ? `<a href="${esc(DOC[name] || name)}"'),
    ('settings lose their documentation links',
     '${s.sub ? `<span class="sub">${subHtml(s.sub)}${docLinksHtml(s.docs)}</span>` : ""}',
     '${s.sub ? `<span class="sub">${subHtml(s.sub)}</span>` : ""}'),
    ('protocol mode hydrates posts through the AppView',
     'if (!full && !settings.protocolOnly) queueHydrate(p.uri);',
     'if (!full) queueHydrate(p.uri);'),
    ('protocol mode leaves like and repost stuck waiting',
     'hydrated: full || !!settings.protocolOnly };',
     'hydrated: full };'),
    ("a quoted post's pictures fall back to the CDN",
     'record: v, embed: r.embeds?.[0], __pds: r.__pds,',
     'record: v, embed: r.embeds?.[0],'),
    ('protocol mode leaves an AppView profile call at boot',
     'if (settings.protocolOnly) { await xrpc("com.atproto.server.getSession", {}, { retries: 1 }); await loadProfile(); }\n    else ',
     ''),
]


def run_suite(page, inner):
    """The suite against one page. Returns the lines of its failures."""
    r = subprocess.run(
        ["node", "--test"] + ([f"--test-concurrency={inner}"] if inner else []), cwd=HERE,
        capture_output=True, text=True,
        env={**os.environ, "CATCHUP_HTML": str(page)},
    )
    return [l for l in r.stdout.splitlines() if l.startswith("not ok")]


def main():
    src = (REPO / "index.html").read_text()
    args = sys.argv[1:]
    check_only = "--check" in args
    only = args[args.index("--only") + 1].lower() if "--only" in args else None
    # Measured on a 10-core machine: 1 worker ~18s a guard, 4 ~13s, 6 ~12s.
    # The suite costs about 50 CPU-seconds a run, so the whole thing is
    # bound by total work rather than by any one run's length -- which is
    # also why splitting the slowest test file would not help here, though
    # it would shorten a plain `npm test`.
    workers = int(args[args.index("--workers") + 1]) if "--workers" in args else max(1, (os.cpu_count() or 4) * 3 // 5)
    # Left at the runner's own default on purpose. Most of the suite's
    # wall-clock is waiting -- retry backoffs, debounces -- not computing,
    # so runs overlap their idle time rather than fighting for cores.
    # Dividing cores between runs made each one near-serial across the
    # test files and cancelled out the gain.
    inner = 0

    guards = [g for g in GUARDS if not only or only in g[0].lower()]
    if only:
        print(f"{len(guards)} of {len(GUARDS)} guards match {only!r}\n")

    bad = []
    # Anchors first: cheap, and a stale one means the guard proves nothing.
    for guard in guards:
        name, old = guard[0], guard[1]
        n = src.count(old)
        if n != 1:
            print(f"SKIP  {name}: anchor matched {n}x, expected 1")
            bad.append(name)
    guards = [g for g in guards if g[0] not in bad]
    if check_only:
        print(f"\n{len(guards) + len(bad)} anchors, {len(guards)} ok, {len(bad)} needing attention")
        for name in bad:
            print(f"  - {name}")
        return 1 if bad else 0

    work = HERE / ".sabotage-run"
    work.mkdir(exist_ok=True)
    try:
        # The control. Same load, unmodified page: anything failing here is
        # the machine, not a guard.
        control = work / "control.html"
        control.write_text(src)
        print(f"control ({workers} guards at a time)...", flush=True)
        fails = run_suite(control, inner)
        if fails:
            print(f"\nCONTROL FAILED: {len(fails)} test(s) fail on the UNCHANGED page, "
                  f"the first being {fails[0][6:].strip()[:60]}.\nEvery guard would look "
                  f"caught for that reason. Re-run with fewer --workers.")
            return 2
        print("control passes; sabotaging\n", flush=True)

        def one(item):
            i, guard = item
            name, old, new = guard[:3]
            unobservable = guard[3] if len(guard) > 3 else None
            page = work / f"s{i}.html"
            page.write_text(src.replace(old, new, 1))
            try:
                return name, run_suite(page, inner), unobservable
            finally:
                page.unlink(missing_ok=True)

        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            for name, fails, unobservable in pool.map(one, enumerate(guards)):
                if fails:
                    print(f"RED   {name}  ->  {len(fails)} test(s): {fails[0][6:].strip()[:60]}", flush=True)
                elif unobservable:
                    # Known to be invisible to any test, and why. Reported, not
                    # counted: a run that always ends in failure teaches people
                    # to ignore the failures that matter.
                    print(f"green {name}  ->  expected: {unobservable}", flush=True)
                else:
                    print(f"GREEN {name}  ->  NOTHING CAUGHT IT", flush=True)
                    bad.append(name)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n{len(guards) + len(bad) - len([b for b in bad if b in [g[0] for g in guards]])} guards run, "
          f"{len(guards) - len([b for b in bad if b in [g[0] for g in guards]])} ok, {len(bad)} needing attention")
    for name in bad:
        print(f"  - {name}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
