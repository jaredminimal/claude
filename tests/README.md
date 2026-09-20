# Tests

```bash
npm install
npm test          # syntax + storage + filters + the full browser suite
```

Three layers, all of which run the **real** functions out of
`fetlife-asl-search-activity-v7.user.js` rather than a copy. If a function is
renamed the tests fail loudly instead of quietly testing nothing.

- **`storage.test.mjs`** (`fake-indexeddb`) - the photo store and its
  migration, in isolation: interrupt the move half way, finish it, and check
  every photo moved exactly once. Also prints what a list query reads before
  and after the split, which is the point of the change.
- **`filters.test.mjs`** - the per-search grouping, ordering, counts and the
  composition of the Search and Find filters.
- **`browser.test.mjs`** (Playwright + real Chromium) - the whole panel, driven
  for real against `mock-fetlife.mjs`.

## What the browser suite actually exercises

`mock-fetlife.mjs` stands in for FetLife: kinksters pages in the real
member-card DOM shape, `/activity` endpoints in the documented JSON shape, a
CDN that serves genuine JPEGs and **refuses any request that arrives without a
referer** (hard-won fact #9), a profile whose `/activity` answers with markup
instead of JSON, a 404, a 403, and a card with no image on it. Each person's
JPEG carries their own name in a COM segment, so "is this the right person's
face?" is answerable from the bytes.

Requests are routed at the network layer, so the page really is at
`https://fetlife.com` and Phase 1 really navigates page to page. It covers the
crawl, the activity check, the request pacing, the per-search view, hiding and
removing dead ends, re-checking one search, and an upgrade from a v2 database
whose photos are still inside the records.

Two shims are unavoidable and worth knowing about:

1. `GM_xmlhttpRequest` is backed by `fetch`. Browsers forbid setting `Referer`
   from `fetch`, so the shim forwards it as `x-asl-referer` and the mock CDN
   accepts either. This still proves the script *asks* for a referer.
2. The script is injected with `addInitScript` rather than by Tampermonkey.

## What is still NOT proven

Everything about the real FetLife: whether their markup and JSON still match
these parsers, and whether the pacing is slow enough for their real limiter.
The suite proves the script does what it intends to do, not that FetLife
agrees. Those remain the user's screenshots to confirm.

## Gotchas found the hard way while writing these

- `page.waitForFunction` with an **async** predicate resolves immediately: the
  returned Promise is truthy. Poll from Node instead (`waitUntil`).
- The activity check jumps to the Active tab when it finishes, *after* the
  database says it is done. Let it settle before driving the panel.
- A fixture photo must be a **decodable** JPEG. An invalid `data:` URI fires an
  error event and the script correctly clears it as a dead link.
- Fixture photos must be genuinely unique. Identical-looking ones are binned by
  the shared-image purge, correctly.
