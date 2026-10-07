# Bluesky Catch-up

Read your Bluesky Following feed from any point in time, **oldest first**, so
you can scroll forward through what you missed instead of backwards through it.

**→ [bsky-catch-up.choccy.gay](https://bsky-catch-up.choccy.gay/)**

It's one self-contained HTML file. No server, no build step, no install, no
tracking, no account beyond your Bluesky one.

## Two ways to use it

- **Hosted:** just open [bsky-catch-up.choccy.gay](https://bsky-catch-up.choccy.gay/).
- **Local:** download `index.html` (or a pinned copy from
  [Releases](https://github.com/choccccy/bsky-catch-up/releases)) and open it
  from your own disk. It works exactly the same.

Sign in with a [Bluesky **app password**](https://bsky.app/settings/app-passwords),
never your real one. Everything runs in your browser and talks only to
Bluesky's own servers.

## What it does

- Pick a starting point — a date, or a specific post — and read forward to now
- Likes, reposts, inline video and image galleries, reply threads
- Remembers where you left off
- Share a catch-up as a link: `#from=2026-10-01`
- A pile of settings to tinker with

## Where things are

Everything is in **`index.html`** — including the documentation. The comment at
the top of that file explains how the page works, how it's built, and how to
work on it, and the changelog lives at the end of it. Start there.

`tests/` holds the test suite (jsdom, simulated Bluesky API, no network or
account needed); see [`tests/README.md`](tests/README.md).

```sh
cd tests && npm install && npm test
```

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by Bluesky.
