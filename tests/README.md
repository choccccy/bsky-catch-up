# Tests

Automated tests for the Bluesky Catch-up page. They load the page into
[jsdom](https://github.com/jsdom/jsdom) with a **simulated Bluesky API**, so
they need no network access and no Bluesky account.

## Running

Requires Node.js 20 or newer.

```sh
cd tests
npm install
npm test
```

By default the tests use `index.html` in the folder above this one, or if
there isn't one, the highest-versioned `bluesky-catchup*.html` there. To test
a specific file:

```sh
CATCHUP_HTML=../path/to/page.html npm test
```

## Checking the tests can fail

A test that cannot fail is worse than none: it reads like coverage and isn't.
`sabotage.py` breaks each guard in the page on purpose, one at a time, in a
copy of `index.html`, and checks that a test goes red.

```sh
cd tests
python3 sabotage.py --check   # anchors only, about a second
python3 sabotage.py           # the real thing, 15 minutes or so
```

Each entry is `(name, old, new)`, where `old` is text that must appear in
`index.html` exactly once. That couples the list to the source, so a refactor
can quietly stop an anchor matching -- the entry then reports `SKIP`, which
proves nothing while looking like one more line of output. **Run `--check`
after any refactor**, and don't trust an older full run until it passes. The
workflow runs `--check` on every push for that reason.

Two outcomes need attention:

- `SKIP` -- the anchor no longer matches. Re-point it at the current source.
- `GREEN` -- the guard was broken and every test still passed. Usually a
  missing test. Occasionally a line is genuinely unobservable, because
  something else already covers the case; give that entry a fourth element
  saying why, and it reports as a lower-case `green` without failing the run.
  A run that always ends in failure teaches people to ignore the failures
  that matter. Don't reach for that fourth element to silence a green you
  haven't explained.

Add an entry whenever you add a guard: a validation, a fallback, an ordering
that matters, a check that something is never sent somewhere.

## Layout

- `harness.js` loads the page, simulates Bluesky (`makeServer`), and has
  builders for actors, posts, feed entries, embed views (`embeds.*`) and raw
  record embeds (`raw.*`), plus helpers that use the page like a person
  would (`startDate`, `startPost`, `setSetting`, ...) and inspect it
  (`ids`, `article`, `banner`, `records`, `json`, ...).
- `*.test.js` are the tests, grouped by area, using Node's built-in
  `node:test` runner.
- `sabotage.py` checks the tests can fail (above). Needs Python 3 and no
  packages.

## Limits

- The simulated API follows the published app.bsky / com.atproto lexicons.
  It can't catch cases where Bluesky's real responses differ; when one turns
  up, fix the page, update the builders in `harness.js`, and add a test.
- jsdom does no layout, so nothing here checks how things look (sizes,
  scrolling, sticky elements). Check those in a real browser.
- The page fetches nothing when it loads (the typeface is embedded, and
  hls.js is fetched on demand), but `<script src>` and `<link>` are stripped
  anyway so a test can never reach the network. A test that wants to assert
  something about those tags must read the file at `h.PAGE_PATH`, not the
  loaded DOM. jsdom has no ResizeObserver, so the harness supplies a
  stand-in that records what the page observes (`page.resizeObservers`); the
  tiled layout uses one to keep its row spans in step. hls.js is likewise
  replaced by a small stand-in that records what the page asks of it;
  `canPlayType` is left alone, so the page takes the hls.js path unless a
  test says otherwise.

## Adding tests

Every bug fix and feature should come with a test. Load a page with the data
you need:

```js
const h = require("./harness");
const page = await h.loadPage({
  settings: { replyContext: "full" },            // saved settings
  server: { timeline: [h.item(h.post("A", h.actor(1), 10))] },
});
await page.startDate(h.BASE);
assert.deepEqual(page.ids(), ["A"]);
```
