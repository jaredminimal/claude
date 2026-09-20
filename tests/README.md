# Tests

There is no way to test this script against FetLife from a development
machine: it needs a logged-in session, and there is no browser automation
here. Everything that touches the network stays unproven until the user
confirms it from a screenshot.

What *can* be proven is the part that does not need FetLife: the storage
layer and the list filtering. Both tests lift the real functions straight
out of `fetlife-asl-search-activity-v7.user.js` by name and run them, so
they exercise the shipped code rather than a copy of it. If a function is
renamed, the test fails loudly instead of silently testing nothing.

```bash
npm install            # fake-indexeddb, the only dependency
npm test               # both suites
```

- **`storage.test.mjs`** builds a v2-shaped database with pictures inside
  the profile records, interrupts the migration half way, finishes it, and
  checks that every photo moved exactly once and none was lost. Then it
  checks the read and write paths, including that deleting a record or a
  batch of them takes the photos with it. It also prints what a list query
  reads before and after the split, which is the whole point of the change.

- **`filters.test.mjs`** checks the per-search dropdown and the hiding of
  deleted and private profiles: grouping, newest-first ordering, the counts
  beside each search matching what selecting it shows, and the Search and
  Find filters composing.

Always also run `node --check fetlife-asl-search-activity-v7.user.js`
before shipping a build.
