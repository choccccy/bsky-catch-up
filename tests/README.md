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

## Layout

- `harness.js` loads the page, simulates Bluesky (`makeServer`), and has
  builders for actors, posts, feed entries, embed views (`embeds.*`) and raw
  record embeds (`raw.*`), plus helpers that use the page like a person
  would (`startDate`, `startPost`, `setSetting`, ...) and inspect it
  (`ids`, `article`, `banner`, `records`, `json`, ...).
- `*.test.js` are the tests, grouped by area, using Node's built-in
  `node:test` runner.

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
  loaded DOM. hls.js is replaced by a small stand-in that records what the
  page asks of it; `canPlayType` is left alone, so the page takes the
  hls.js path unless a test says otherwise.

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
