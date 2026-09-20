# FetLife ASL Search — session handoff

Written 2026-09-19, updated 2026-09-20. Everything below is the state at
script version **9.6.0**, working tree clean and pushed.

---

## 1. What this is

A Tampermonkey userscript that runs on `https://fetlife.com/*`. It:

1. Crawls FetLife's kinksters search pages for profiles matching age / sex /
   location / role.
2. Checks each profile's last activity date.
3. Shows the ones active within a threshold, with their profile photo, so the
   user can review them and message people.

The user is **not a coder**. They operate this entirely through the panel UI and
screenshots. Do not ask them to open a console, run a snippet, or type a
username to test something — build what you need into the UI instead.

---

## 2. Where the code lives

| | |
|---|---|
| Repo | `github.com/jaredminimal/claude` |
| Working branch | `claude/fix-fetlife-rate-limit-uD4Gn` |
| Repo default branch | `claude/debug-fetlife-search-TuBbr` (not `main` — unusual, but correct) |
| Open PR | #3 (draft) |
| **Active file** | `fetlife-asl-search-activity-v7.user.js` — **v9.2.0, the only file to edit** |

**Do not touch** `fetlife-asl-search-activity.user.js` (v6.3.0) or
`fetlife-asl-search.user.js` (v5.6.0). They are legacy. The user explicitly
asked that v6.3.0 stay untouched, which is why v7 exists as a separate file.

### Delivering a build

Tampermonkey's "Check for updates" **does not work** for this script — the
per-script update setting is off because it was installed by pasting. Every
attempt to use `@updateURL` failed. The working process is:

1. Bump `@version` on line 3 (Tampermonkey will not reload otherwise).
2. `node --check` the file.
3. Commit, push to the working branch.
4. Send the file with `SendUserFile`.
5. Tell them: paste over the whole script in the Tampermonkey editor, Ctrl+S,
   reload FetLife.

---

## 3. Hard-won facts — do not re-derive these

Each of these cost real debugging time or a lockout. Treat them as settled.

**Network**

1. FetLife is a Vue SPA with a service worker that intercepts `fetch()` and
   returns 404. **All requests must go through `GM_xmlhttpRequest`.**
2. The kinksters search pages only yield member cards after real page
   navigation. Phase 1 genuinely navigates the tab page to page and scrapes the
   rendered DOM. Do not try to replace this with background fetches.
3. `/{nickname}/activity` normally returns JSON:
   `story_groups[].stories[].created_at` and
   `story_groups[].stories[].author.{nickname, avatar_url, avatar_small_url, profile_url}`.
   **It sometimes returns rendered HTML instead** — both paths must work.
   `parseActivityFromHtml` reads dates out of `datetime="..."` attributes.
4. FetLife periodically changes how it negotiates JSON. A **406** means the
   `Accept` header was rejected. `ACTIVITY_METHODS` probes a list of known
   request shapes once, remembers the winner, and re-probes only on a 406.
5. Status codes: **404** = deleted or renamed account (permanent; also watch
   `finalUrl` for a rename redirect), **401/403** = private activity feed
   (permanent), **429** = rate limited, **406** = format rejected.
6. **Lockout**: FetLife redirects to `/locked` and the body contains
   "Temporarily Locked Out" / "tripped our security system". Durations escalate
   on repeat. `isLockedOut(resp)` detects it and the run aborts.
7. **Safe rate is 3–6 seconds per profile.** A lockout was triggered by a 1.5–3s
   delay combined with three requests per profile. The script now makes **one**
   request per profile and the delay is a UI setting defaulting to 3–6s.

**Images** — this consumed most of the session

8. CDN image URLs are signed and **expire in roughly 24–48 hours**. They must be
   converted to base64 `data:` URIs to persist.
9. **The CDN rejects image requests that arrive with no referrer.** Proven twice:
   setting `referrerpolicy="no-referrer"` on `<img>` broke every picture, and
   `GM_xmlhttpRequest` (which sends no `Referer`) got 403 on every download.
   **Always send `Referer: https://fetlife.com/`** when downloading an image.
10. `data:` URIs **do** render on FetLife — CSP allows them. Verified with a test
    square.
11. Picture URL shape:
    `https://picav2-c{SIZE}.cdn.fetlife.com/picture/attachments/{ATTACHMENT_ID}/a{SIZE}.jpg?{epoch}-{sig}`
    Sizes seen: `a50`, `a160`, `a400`. **The same attachment id at different
    sizes is the same picture.** Grouping by attachment id is how two people's
    photos are told apart on one page.
12. **The logged-in user's own avatar sits in the site header of every FetLife
    page**, so it appears in every profile page fetched in the background — and
    it is *first* in the markup. This caused the worst bug of the session: the
    user's own photo saved onto hundreds of other people's profiles.
13. **`og:image` on a profile page is FetLife's generic site logo**
    (`fetlife.com/assets/logo/og-image-*.png`), not the profile photo. Never
    trust it. Anything under `/assets/` or `/packs/` is site furniture.
14. Avatar host prefixes vary (`pic*`, `flpics*`, `picav2-c*`). Match on the
    `cdn.fetlife.com` **domain**, never on a guessed subdomain prefix.

**Storage**

15. `localStorage` blew its 5MB quota at ~11,000 results, which silently killed
    the crawl loop and left the search stuck "active". Everything moved to
    IndexedDB in v8.0.0 with a one-time migration.

---

## 4. Storage layout

**IndexedDB** — db `asl_search_db`, version 3

- store `results`, keyPath `nickname`
- store `seen` (nicknames imported from CSV for dedup)
- store `avatars`, keyPath `nickname`, value `{nickname, avatar}` — **added in
  v9.4.0**

**Pictures live apart from the records, and this matters.** Drawing any list
has to load every record in order to sort and filter it, and a record carrying
a base64 photo is a thousand times bigger than one that does not. At 29,013
profiles `dbGetAllResults()` was reading a couple of hundred megabytes — on
panel open, on every sort change, and on **every keystroke in the Find box**.
Measured on a 2,000-profile library in `tests/storage.test.mjs`: 17.7 MB before
the split, 0.44 MB after, a 40x cut that scales with the library.

`dbPutResults` is the single chokepoint. Anything that sets `.avatar` on a
record and saves it lands there, and the picture is routed to the `avatars`
store; an empty `.avatar` means remove it, which is how a dead CDN link gets
cleared. No call site needs to know where photos live. `dbDelete`,
`dbDeleteMany` and `dbClearResults` take the picture with the record, so there
are no orphans.

Existing libraries are moved across by `migrateAvatarsOutOfRecords`, in chunks
of 250, outside the version-change transaction so a big library does not freeze
the tab. **It is resumable by construction**: a record that still has an
`.avatar` is a record still to do. `buildProfileCard` reads both places, so a
half-moved library still draws every face it has.

**Record fields**

| field | meaning |
|---|---|
| `nickname`, `age`, `gender`, `role`, `location`, `url` | from the crawl |
| `batch` | integer search number (140 = the 140th search run) |
| `batchPages` | e.g. `"1-500"` |
| `foundAt` | epoch ms when crawled (also used to order within a page) |
| `activityChecked` | bool |
| `lastActivity` | ISO date of their most recent story |
| `checkedAt` | ISO date of the last activity check |
| `activityError` | status code or message from a failed check |
| `gone` | true on 404 — deleted or renamed, permanent |
| `restricted` | true on 401/403 — private activity feed, permanent |
| `photoTried` | ISO date; no picture could be found, don't retry for 7 days |
| `refreshTried` | ISO date; any refresh attempt, 1-day cooldown |

**localStorage keys**

`asl_search_state`, `asl_search_progress`, `asl_last_check_batch`,
`asl_chrome_pic_ids` (attachment ids known to be site chrome),
`asl_pic_id_owner` (attachment id → nickname),
`asl_purged_shared_avatars_v2` (one-time cleanup flag).

---

## 5. Architecture as it stands (v9.2.0)

Three tabs: **Search / Results / Active**. Both Results and Active carry a
**Search dropdown** (newest first, each option carrying the date and count;
records predating batches group under "Earlier results") and a **Show deleted
& private** checkbox, off by default. Selecting one search drops the batch
dividers, since they only earn their place when more than one search is in
view. Counts and buttons keep describing the whole set, so a narrowed view can
never make a bulk action hit the wrong profiles.

**Phase 1 — crawl.** Real page navigation. Scrapes member cards from the
rendered DOM and base64s each avatar immediately. This path has always been
correct, because the browser already rendered the right image. Photos captured
here are permanent.

**Phase 2 — activity check.** Explicit button on Results, with a progress bar
and a Stop button. One request per profile at the configured 3–6s delay.
Detects lockout and aborts. Errors no longer destroy existing data (an earlier
bug nulled `lastActivity` on any error and silently drained the Active list).

**Background refresh worker (v9.0–9.2).** A card drawn on screen queues itself
if it has no photo, or if its activity date is more than 14 days old. The worker
handles one at a time at the configured delay, pauses entirely while an activity
check runs, and stops on lockout. It reads the photo **and** the activity date
out of the same `/activity` response, then redraws the whole card in place.
Profiles that were **never** checked are deliberately left to the explicit
Check Activity button — silently churning 29,000 profiles in the background is
how you get locked out without knowing why.

**The correctness invariant that keeps wrong faces off profiles.** In
`saveAvatar()`: a picture belongs to one person. Every attachment id is recorded
against the nickname it was saved for. If that attachment is ever offered for a
second person, it is refused and permanently marked as site chrome. This is
enforced at the point of saving, so no picking heuristic can bypass it. The
header avatar is exactly this case — the second profile that sees it kills it
for good. **Keep this invariant. It is the only thing standing between the user
and the bug that wasted most of a day.**

---

## 6. What is verified working

Confirmed by the user's screenshots on 2026-09-17:

- Photos load and are **the correct people** (TwoStraws, littleone67,
  missybratgg, sweetsexyoneleft, A-Fine-Girl, GoddisMystic all distinct and
  matching their profiles).
- Activity checks succeed at roughly 94% (the rest are genuine 404s and private
  feeds).
- The Find box filters both lists by nickname.

Scale at handoff: **29,013 results, ~3,062 active, batches up to 140.**

Proven by `npm test` (2026-09-20), which runs the real functions lifted out of
the script against `fake-indexeddb`:

- The avatar migration moves every photo exactly once, loses none, survives
  being interrupted half way, and is a no-op on a second run.
- Deleting a record, a batch of records, or clearing everything takes the
  photos with it.
- A renamed profile keeps its face.
- A page of 50 cards loads at most 50 photos and nobody else's.
- The per-search grouping, ordering, counts, and the composition of the Search
  and Find filters.

**Not proven, and cannot be from here:** anything that talks to FetLife, and
anything about how the panel looks or feels on a real 29,013-record library.
The speed claim is a measurement of bytes read, not of the user's screen.

---

## 7. Outstanding work, in priority order

### 7.1 Per-search view — DONE in v9.3.0

The user's words: *"get all these profiles and recent searches cleaned up and
accurate for review... I can see the last search of people that I did clearly."*

Right now every search is mixed into one list, separated only by
`— SEARCH 140 (PAGES 1-500) —` dividers. There is no way to look at one search
on its own.

**Build**: a search/batch dropdown in both Results and Active tabs, listing
batches newest-first with counts, e.g. `Search 140 — Sep 17 (412)`, plus an
"All searches" option. Records already carry `batch` and `batchPages`. There is
**no stored batch timestamp** — derive the date from the minimum `foundAt`
across the batch.

Done as described. The date is derived from the minimum `foundAt` across the
batch, since no batch timestamp was ever stored.

The worker prioritisation came free: it only ever works on cards drawn on
screen, so narrowing the list already points it at that search. `prunePhotoQueue`
re-points leftover jobs at the redrawn card when the person is still listed, and
drops them when they are not.

### 7.2 Cleanup — DONE in v9.3.0

Done. Both are hidden from both lists, a checkbox with the count brings them
back, and one button removes **only** 404s behind a confirmation that says what
it will do. Private profiles are never removed — they are real people behind a
closed feed. Hiding them also stops the background worker retrying 404s daily
forever, which it had been doing.

### 7.3 Unverified

v9.2.0's stale-activity refresh shipped but the user has not confirmed it in
practice. The photo half of the same code path is confirmed working.

### 7.4 Coverage gap

The background worker only touches cards actually on screen. Most of the 29,013
records will never be refreshed unless the user scrolls to them. If a
whole-library refresh is wanted it needs to be an explicit, interruptible job
with a progress bar — not a background trickle.

### 7.5 Found and fixed 2026-09-20 by the browser suite

Three defects that reading the code had not surfaced in any prior session:

1. **Every "Check Activity Now" run was making 2-3 requests per profile, not
   one.** The button was wired `addEventListener('click', startActivityCheck)`,
   so the MouseEvent arrived as the `refreshAvatars` argument and was truthy by
   accident. §3 fact 7 states as settled that the script makes one request per
   profile; it did not. This is the most plausible cause of the lockouts.
   Fixed two ways: the call is explicit now, and **every request to fetlife.com
   goes through `gmRequest`**, which paces them. The delay is now per REQUEST,
   which is what it always claimed to be - a profile that costs three requests
   takes three slots. CDN image downloads are deliberately not paced (different
   host, the browser is loading those same images anyway, and pacing them would
   make a 500-page crawl take days). Proven: 47 consecutive gaps, none under
   900ms at a 1s setting.

2. **`FL_IMG_HOST` matched any fetlife.com URL, not just picture URLs.** An
   `<img>` with an empty or relative `src` resolves to the PAGE's own address,
   which passed - so the HTML of the kinksters page was downloaded, base64'd
   and saved as that person's photo. `isMemberPicture` (which already existed
   and was already used by the photo pipeline) is now the test on both the
   crawl path and the download path.

3. **The panel closed on every crawl navigation**, so a 500-page crawl ran
   unwatched. It now remembers it was open.

### 7.6 The strategic question, answered 2026-09-20

The user asked whether Tampermonkey is the right host at all, or whether the
whole thing should be rebuilt. The answer given, and the reasoning, so it does
not get re-litigated:

**Stay on Tampermonkey.** The binding constraint on this project is FetLife's
rate limit — one profile every 3-6 seconds or you get locked out — and their
login. No rewrite changes either. 29,000 profiles is 30+ hours of requests
whatever runs them. What the felt degradation actually was: the storage
problem in §4, which is fixed, not anything about being a userscript.

What the alternatives would genuinely buy, if the question comes back:

- **A real MV3 extension.** A background service worker means a crawl or a
  check survives navigation and does not need a FetLife tab parked open. Same
  storage, same rate limit. Costs an unpacked install and a different update
  ritual. This is the next step if one is ever needed, not a full rewrite.
- **A local Node app with SQLite and photos on disk.** Removes the scale
  ceiling entirely and can run overnight. Costs the user a toolchain they
  would have to maintain, and it is still not faster.
- **Server-side with exported cookies.** Ruled out. Moves their session off
  their machine, and a datacenter IP gets locked out faster than their home
  one.

The more useful observation, which was put to the user: 29,013 profiles is a
haystack, not a review list. The tool was built for breadth when what is wanted
is a short, current, reviewable list. Tighter searches — narrow age band, one
city, 50 pages not 500 — checked one search at a time, is the workflow the
§7.1 dropdown now makes possible.

---

## 8. Constraints on the session

- **There is no Chrome MCP** (`claude-in-chrome`, `Claude_Browser`,
  `computer-use`). Re-checked 2026-09-20 with `ToolSearch`; still absent. It
  would drive the *user's* Chrome anyway, which a cloud container cannot reach.
- **You cannot test against the real FetLife.** It needs their login.
- **But you CAN test almost everything else, and you must.** Playwright and
  Chromium are both present (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).
  `npm test` runs the whole panel in real Chromium against a mock FetLife —
  crawl, activity check, request pacing, the per-search view, the database
  upgrade. See `tests/README.md`. **Do not hand the user a build that has not
  been through it.** An earlier session concluded "no browser automation" and
  shipped on reasoning alone; the browser suite found three real bugs in its
  first two runs.
- Therefore: **be honest about what is proven versus what is expected.** A large
  amount of trust was burned by shipping speculative fixes described as
  solutions. What the suite proves is that the script does what it intends;
  what it cannot prove is that FetLife agrees.

---

## 9. How the user wants to be worked with

Learned the hard way:

- **Decide things.** They said, near the end: *"I have no idea, I'm relying on
  you to build an intuitive system that works."* Don't hand them architectural
  choices. Make the call, explain it in a sentence, move on.
- **Don't make them operate a debugger.** Buttons like "Test Photos" and
  "Refresh Missing Photos" were correctly criticised as turning them into the
  operator of a diagnostic tool. Things should just work in the background.
  Those buttons were removed in v9.0.0 — don't reintroduce that pattern.
- **Don't claim a fix works when it hasn't been verified.** Say plainly which
  part is proven and which is expected.
- **One file, one paste, bump the version.** Anything else and the update
  silently doesn't apply, which has confused things more than once.
- They will say when something is wrong, usually with a screenshot. The
  screenshots have been the single most useful debugging input in the project —
  two separate root causes (the site logo, and the shared attachment id) were
  found by reading URLs out of them.

---

## 10. Quick orientation for the next session

```bash
cd /home/user/claude
git log --oneline -15
sed -n '1,15p' fetlife-asl-search-activity-v7.user.js     # metadata block
grep -n "saveAvatar\|pickOwnerAvatar\|startPhotoWorker\|photoPipeline" \
  fetlife-asl-search-activity-v7.user.js                   # the photo system
grep -n "renderProfileList\|loadAndDisplayResults" \
  fetlife-asl-search-activity-v7.user.js                   # the list rendering
node --check fetlife-asl-search-activity-v7.user.js
npm install && npm test        # storage + filter suites, see tests/README.md
```

Start with §7.1. That is what the user asked for last.
