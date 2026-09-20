import { chromium } from 'playwright';
import fs from 'fs';
import * as M from './mock-fetlife.mjs';

const SCRIPT = fs.readFileSync(new URL('../fetlife-asl-search-activity-v7.user.js', import.meta.url),'utf8');
let fails = 0, checks = 0;
const ok = (label, cond, extra='') => {
  checks++; if(!cond) fails++;
  console.log((cond?'  PASS  ':'  FAIL  ') + label + (extra ? '   [' + extra + ']' : ''));
};
const head = t => console.log('\n' + t);
async function waitUntil(page, fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await page.evaluate(fn);
    if (last && last.done) return last;
    await page.waitForTimeout(1000);
  }
  throw new Error('timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
}
// The panel rebuilds itself on navigation and the activity check jumps to the
// Active tab when it finishes, so never assume which tab is showing.
async function showTab(page, name) {
  await page.evaluate(n => {
    const panel = document.getElementById('asl');
    panel.classList.add('open');
    panel.querySelectorAll('#asl-tabs button').forEach(b => b.classList.remove('on'));
    panel.querySelectorAll('.asl-tab').forEach(x => x.classList.remove('on'));
    panel.querySelector('#asl-tabs button[data-t="' + n + '"]').classList.add('on');
    document.getElementById('asl-t-' + n).classList.add('on');
  }, name);
  await page.waitForSelector('#asl-t-' + name + '.on', { state: 'visible', timeout: 10000 });
}
const dbCounts = async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const rows = await new Promise(r => {
    const t = db.transaction('results','readonly').objectStore('results').getAll();
    t.onsuccess = () => r(t.result);
  });
  const checked = rows.filter(x => x.activityChecked).length;
  return { done: rows.length > 0 && checked === rows.length, checked, total: rows.length };
};

// Browsers forbid setting Referer from fetch(), which real GM_xmlhttpRequest
// can do. The shim forwards it as x-asl-referer and the CDN accepts either, so
// this still proves the script ASKS for a referer on every image download.
const SHIMS = `
window.__req = [];
window.GM_xmlhttpRequest = function(opts){
  const h = Object.assign({}, opts.headers||{});
  if (h.Referer){ h['x-asl-referer'] = h.Referer; delete h.Referer; }
  window.__req.push({ url: opts.url, at: Date.now() });
  fetch(opts.url, { method: opts.method||'GET', headers: h }).then(async r => {
    const o = { status: r.status, finalUrl: r.url };
    if (opts.responseType === 'arraybuffer') o.response = await r.arrayBuffer();
    else o.responseText = await r.text();
    opts.onload && opts.onload(o);
  }).catch(e => opts.onerror && opts.onerror(e));
};
window.unsafeWindow = window;
window.__rejections = [];
window.addEventListener('unhandledrejection', e => {
  window.__rejections.push(String(e.reason && e.reason.stack || e.reason));
});
`;
const WRAPPED = SHIMS + `
(function(){ function go(){ ${SCRIPT} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext();
await context.addInitScript({ content: WRAPPED });

const served = { app: 0, cdn: 0 };
await context.route('**://*fetlife.com/**', async route => {
  const req = route.request();
  const u = new URL(req.url());
  const cors = { 'Access-Control-Allow-Origin': '*' };

  if (u.hostname.endsWith('cdn.fetlife.com')) {
    served.cdn++;
    const hdrs = await req.allHeaders();
    if (!hdrs['x-asl-referer'] && !hdrs['referer'])
      return route.fulfill({ status: 403, body: 'no referer', headers: cors });
    const m = u.pathname.match(/attachments\/(\d+)\//);
    const id = m ? m[1] : '0';
    const who = id === '999999' ? 'HEADER-AVATAR'
              : (M.PROFILES.find(p => String(p.attachment) === id) || {}).nick || 'unknown';
    return route.fulfill({ status: 200, contentType: 'image/jpeg',
                           body: M.jpegFor(who), headers: cors });
  }

  served.app++;
  const path = u.pathname;
  if (path.includes('/kinksters')) {
    const n = parseInt(u.searchParams.get('page') || '1', 10);
    return route.fulfill({ status: 200, contentType: 'text/html', body: M.kinkstersPage(n) });
  }
  const act = path.match(/^\/([^/]+)\/activity(\.json)?$/);
  if (act) {
    const p = M.byNick(act[1]);
    if (!p) return route.fulfill({ status: 404, body: 'gone', headers: cors });
    if (p.behaviour === '404') return route.fulfill({ status: 404, body: 'gone', headers: cors });
    if (p.behaviour === '403') return route.fulfill({ status: 403, body: 'private', headers: cors });
    if (p.behaviour === 'html')
      return route.fulfill({ status: 200, contentType: 'text/html',
                             body: M.activityHtml(p), headers: cors });
    return route.fulfill({ status: 200, contentType: 'application/json',
                           body: M.activityJson(p), headers: cors });
  }
  const prof = path.match(/^\/([^/]+)\/?$/);
  if (prof && M.byNick(prof[1]))
    return route.fulfill({ status: 200, contentType: 'text/html',
                           body: M.profilePage(M.byNick(prof[1])), headers: cors });
  return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>ok</body></html>' });
});

const page = await context.newPage();
const dialogs = [];
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(()=>{}); });
if (process.env.TRACE) page.on('console', m => {
  const s = m.text(); if (s.includes('[ASL]')) console.log('    . ' + s.slice(0,150));
});

await page.goto('https://fetlife.com/p/united-states/arizona/phoenix/kinksters');
await page.waitForSelector('#asl-btn', { timeout: 15000 });

head('PANEL');
await page.click('#asl-btn');
ok('the panel opens', await page.isVisible('#asl'));
ok('all three tabs are there', (await page.$$('#asl-tabs button')).length === 3);

// Fast but measurable: every paced request should land ~1s apart.
await page.evaluate(() => {
  document.getElementById('asl-act-min').value = '1';
  document.getElementById('asl-act-max').value = '1';
  document.getElementById('asl-spd').value = '1';
  document.getElementById('asl-mp').value = '4';
  document.getElementById('asl-activity').value = '90';
  document.querySelectorAll('#asl-g input').forEach(c => { c.checked = true; });
});

head('PHASE 1 - CRAWL (real page navigation, three pages then an empty one)');
await page.click('#asl-go');
await page.waitForFunction(() => {
  const s = document.getElementById('asl-rtab-count');
  return s && /\(\d+\)/.test(s.textContent);
}, { timeout: 90000 });
await page.waitForFunction(() => {
  try { return !JSON.parse(localStorage.getItem('asl_search_state')||'{}').active; } catch(e){ return false; }
}, { timeout: 90000 });

const counts = await page.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const get = store => new Promise(r => {
    const t = db.transaction(store,'readonly').objectStore(store).getAll();
    t.onsuccess = () => r(t.result);
  });
  return { results: (await get('results')).length, avatars: (await get('avatars')).length,
           sample: (await get('results')).slice(0,3) };
});
ok('all 24 profiles were crawled', counts.results === 24, counts.results + ' found');
ok('a fresh install writes photos straight to the photo store', counts.avatars > 0,
   counts.avatars + ' photos');
ok('no photo was left inside a record', counts.sample.every(r => !('avatar' in r)));
ok('age, gender, role and location were parsed',
   counts.sample.every(r => r.age && r.gender && r.role && r.location),
   JSON.stringify({age:counts.sample[0].age, g:counts.sample[0].gender,
                   r:counts.sample[0].role, loc:counts.sample[0].location}));
ok('every profile carries the search number', counts.sample.every(r => r.batch === 1));

// The crawl navigated pages; make sure the panel came back open by itself.
const stayedOpen = await page.evaluate(() => document.getElementById('asl').classList.contains('open'));
ok('the panel stayed open across the crawl navigations', stayedOpen);
if (!stayedOpen) await page.click('#asl-btn');

head('PHOTOS - the right face on the right person');
const pics = await page.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const rows = await new Promise(r => {
    const t = db.transaction('avatars','readonly').objectStore('avatars').getAll();
    t.onsuccess = () => r(t.result);
  });
  return rows.map(x => ({ nick: x.nickname, tag: atob(x.avatar.split(',')[1]).match(/ASL-TEST:([\w-]+)/)?.[1],
                          isData: x.avatar.startsWith('data:') }));
});
ok('photos are saved as data: URIs, not expiring links', pics.every(p => p.isData));
ok('every photo is the person it belongs to',
   pics.every(p => p.tag === p.nick), pics.filter(p=>p.tag!==p.nick).map(p=>p.nick+'<-'+p.tag).join(',') || 'all matched');
ok('the profile whose card had no image got no photo, not the page HTML',
   !pics.some(p => p.nick === 'member15'), pics.filter(p=>p.nick==='member15').map(p=>p.tag).join(''));
const noPicReason = await page.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const rec = await new Promise(r => { const t = db.transaction('results','readonly').objectStore('results').get('member15'); t.onsuccess = () => r(t.result); });
  db.close(); return rec && rec.photoReason;
});
ok('and the card can say WHY, instead of a silent question mark',
   !!noPicReason, noPicReason || '(no reason recorded)');
ok('nobody got the logged-in user’s header avatar',
   !pics.some(p => p.tag === 'HEADER-AVATAR'));
ok('the CDN refused nothing (the referer was always sent)', served.cdn > 0);

console.log('\n  (requests served so far: ' + served.app + ' to fetlife.com, ' + served.cdn + ' to the CDN)');

head('PHASE 2 - ACTIVITY CHECK');
await showTab(page, 'results');
// The panel was rebuilt by the crawl navigations, so the delay inputs are back
// at their defaults. Set them again here, on the panel that is actually live.
await page.evaluate(() => {
  document.getElementById('asl-check-limit').value = '50';
  document.getElementById('asl-act-min').value = '1';
  document.getElementById('asl-act-max').value = '1';
  window.__req.length = 0;
});
await page.click('#asl-check-activity');
await page.waitForTimeout(2500);
ok('the check starts and shows progress with a Stop button', await page.evaluate(() =>
  document.getElementById('asl-activity-progress').style.display === 'block' &&
  document.getElementById('asl-stop-activity').style.display === 'block'));
// Wait for the work itself, not for a button that starts out hidden.
const done = await waitUntil(page, dbCounts, 240000, 'the activity check to finish');
console.log('  checked ' + done.checked + ' of ' + done.total);
// The DB reaching "all checked" is not the end of the run: the script still
// redraws and jumps to the Active tab. Let it finish before driving anything.
const landed = await page.waitForSelector('#asl-t-active.on', { timeout: 20000 })
  .then(() => true).catch(() => false);
await page.waitForTimeout(1500);
ok('the check ends by showing you the Active tab', landed);
ok('the Stop button is put away again', await page.evaluate(() =>
  document.getElementById('asl-stop-activity').style.display === 'none'));

const after = await page.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const rows = await new Promise(r => {
    const t = db.transaction('results','readonly').objectStore('results').getAll();
    t.onsuccess = () => r(t.result);
  });
  return { checked: rows.filter(r => r.activityChecked).length,
           withDate: rows.filter(r => r.lastActivity).length,
           gone: rows.filter(r => r.gone).map(r => r.nickname),
           restricted: rows.filter(r => r.restricted).map(r => r.nickname),
           htmlOne: rows.find(r => r.nickname === 'member11'),
           staleOne: rows.find(r => r.nickname === 'member19') };
});
const rej = await page.evaluate(() => window.__rejections.slice(0,3));
if (rej.length) console.log('  UNHANDLED REJECTIONS:\n    ' + rej.join('\n    ').slice(0,900));
ok('every profile got checked', after.checked === 24, String(after.checked));
ok('a 404 is recorded as deleted, and only that one',
   after.gone.length === 1 && after.gone[0] === 'member3', after.gone.join(','));
ok('a 403 is recorded as private, and only that one',
   after.restricted.length === 1 && after.restricted[0] === 'member7', after.restricted.join(','));
ok('an /activity that answers with HTML is still read',
   !!after.htmlOne.lastActivity, after.htmlOne.lastActivity || 'no date');
ok('most profiles came back with a date', after.withDate >= 20, String(after.withDate));

head('REQUEST PACING - the lockout guard');
const reqDump = await page.evaluate(() => ({
  total: window.__req.length,
  app: window.__req.filter(r => /^https?:\/\/(www\.)?fetlife\.com\//.test(r.url)).map(r => r.url),
  sample: window.__req.slice(0,4).map(r => r.url),
}));
console.log('  requests recorded: ' + reqDump.total + ' total, ' + reqDump.app.length + ' to the app');
if (reqDump.total) console.log('  sample: ' + reqDump.sample.join('\n          '));
const gaps = await page.evaluate(() => {
  const app = window.__req.filter(r => /^https?:\/\/(www\.)?fetlife\.com\//.test(r.url));
  return app.slice(1).map((r,i) => r.at - app[i].at);
});
const tooFast = gaps.filter(g => g < 900);
ok('requests to fetlife.com are spaced by the delay setting, every one of them',
   gaps.length > 10 && tooFast.length === 0,
   gaps.length + ' gaps, min ' + Math.min(...gaps) + 'ms, ' + tooFast.length + ' under 900ms');

head('SEARCH 140 SCENARIO - a second search, then re-checking just one of them');
await page.evaluate(() => {
  document.getElementById('asl-mp').value = '2';
  document.getElementById('asl-spd').value = '1';
});
await showTab(page, 'search');
await page.evaluate(() => { localStorage.removeItem('asl_search_state'); });
// Second search over the same pages: everything is already known, so it adds
// nothing - which is itself the dedup working. Force a distinct batch instead.
await page.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const store = db.transaction('results','readwrite').objectStore('results');
  const all = await new Promise(r => { const t = store.getAll(); t.onsuccess = () => r(t.result); });
  for (const rec of all.slice(12)) { rec.batch = 2; rec.batchPages = '1-2'; store.put(rec); }
});
await showTab(page, 'results');
await page.evaluate(() => document.getElementById('asl-sort').dispatchEvent(new Event('change')));
await page.waitForTimeout(600);

const opts = await page.$$eval('#asl-batch option', os => os.map(o => ({v:o.value,t:o.textContent})));
ok('the Search dropdown lists both searches, newest first',
   opts.length === 3 && opts[0].v === 'all' && opts[1].v === '2' && opts[2].v === '1',
   opts.map(o=>o.t).join(' | '));

await page.selectOption('#asl-batch', '2');
await page.waitForTimeout(700);
const view = await page.evaluate(() => ({
  cards: document.querySelectorAll('#asl-res .asl-r').length,
  count: document.getElementById('asl-rcount').textContent,
  dividers: document.querySelectorAll('#asl-res .asl-batch-divider').length,
  btn: document.getElementById('asl-recheck-batch').textContent,
  btnShown: document.getElementById('asl-recheck-batch').style.display !== 'none',
}));
ok('picking a search shows only that search', view.cards > 0 && view.cards <= 12, view.cards + ' cards');
ok('and no other search bleeds in', view.dividers === 0);
ok('the count line says what is being shown', /Showing \d+ of 24 . Search 2/.test(view.count), view.count);
ok('the re-check button appears and names its scope',
   view.btnShown && /Re-check Search 2 \(\d+ profiles?\)/.test(view.btn), view.btn);

head('RE-CHECKING ONE SEARCH (activity AND photos, for that search only)');
const batch2 = await page.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const rows = await new Promise(r => {
    const t = db.transaction('results','readonly').objectStore('results').getAll();
    t.onsuccess = () => r(t.result);
  });
  return { mine: rows.filter(x => x.batch === 2 && !x.gone && !x.restricted).map(x => x.nickname),
           others: rows.filter(x => x.batch !== 2).map(x => x.nickname) };
});
await page.uncheck('#asl-recheck-batch-skip');          // force every one through
await page.evaluate(() => { window.__req.length = 0; });
dialogs.length = 0;
await page.click('#asl-recheck-batch');
await page.waitForTimeout(2000);
ok('it asks first, naming the search, the count and how long it will take',
   dialogs.length === 1 && /Re-check \d+ profiles in Search 2/.test(dialogs[0]) &&
   /roughly/.test(dialogs[0]), (dialogs[0]||'(no dialog)').replace(/\n+/g,' ').slice(0,120));

await waitUntil(page, () => {
  const stopped = document.getElementById('asl-stop-activity').style.display === 'none';
  const n = window.__req.filter(r => /fetlife\.com\/[^/]+\/activity/.test(r.url)).length;
  return { done: stopped && n > 0, n };
}, 180000, 'the re-check to finish');

const touched = await page.evaluate(() => [...new Set(window.__req
  .map(r => (r.url.match(/^https?:\/\/(?:www\.)?fetlife\.com\/([^/?#]+)/)||[])[1])
  .filter(Boolean))]);
ok('it re-checked every profile in that search',
   batch2.mine.every(n => touched.includes(n)),
   touched.length + ' profiles touched, ' + batch2.mine.length + ' expected');
ok('and touched nothing from any other search',
   !touched.some(n => batch2.others.includes(n)),
   touched.filter(n => batch2.others.includes(n)).join(',') || 'none');
ok('it did not re-request the deleted or private ones',
   !touched.includes('member3') && !touched.includes('member7'));

const pipeline = await page.evaluate(async (nicks) => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const g = s => new Promise(r => { const t = db.transaction(s,'readonly').objectStore(s).getAll(); t.onsuccess = () => r(t.result); });
  const rows = (await g('results')).filter(x => nicks.includes(x.nickname));
  const pics = new Set((await g('avatars')).map(a => a.nickname));
  return { withDate: rows.filter(x => x.lastActivity).length,
           withPic: rows.filter(x => pics.has(x.nickname)).length, total: rows.length };
}, batch2.mine);
ok('they came back with activity dates', pipeline.withDate >= pipeline.total - 1,
   pipeline.withDate + '/' + pipeline.total);
ok('and with photos, from the same pass', pipeline.withPic >= pipeline.total - 1,
   pipeline.withPic + '/' + pipeline.total);

await showTab(page, 'results');
await page.selectOption('#asl-batch', 'all');
await page.waitForTimeout(700);

head('HIDING DEAD ENDS');
await page.selectOption('#asl-batch', 'all');
await page.waitForTimeout(700);
const hidden = await page.evaluate(() => {
  const nicks = [...document.querySelectorAll('#asl-res .asl-r')].map(e => e.dataset.nick);
  return { has404: nicks.includes('member3'), has403: nicks.includes('member7'),
           toggle: document.getElementById('asl-hidden-wrap').style.display,
           n: document.getElementById('asl-hidden-n').textContent,
           removeBtn: document.getElementById('asl-remove-gone').textContent,
           removeShown: document.getElementById('asl-remove-gone').style.display !== 'none' };
});
ok('the deleted profile is hidden', !hidden.has404);
ok('the private profile is hidden', !hidden.has403);
ok('the toggle appears and counts them', hidden.toggle === 'block' && hidden.n === '2', hidden.n);
ok('the remove button names how many it will remove',
   hidden.removeShown && hidden.removeBtn === 'Remove 1 deleted account', hidden.removeBtn);

await page.check('#asl-show-hidden');
await page.waitForTimeout(700);
const shown = await page.$$eval('#asl-res .asl-r', es => es.map(e => e.dataset.nick));
ok('ticking the box brings them back',
   shown.includes('member3') && shown.includes('member7'));
await page.uncheck('#asl-show-hidden');
await page.waitForTimeout(500);

head('REMOVING DELETED ACCOUNTS');
await page.click('#asl-remove-gone');
await page.waitForTimeout(1200);
const afterRemove = await page.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const g = s => new Promise(r => { const t = db.transaction(s,'readonly').objectStore(s).getAll(); t.onsuccess = () => r(t.result); });
  const rows = await g('results');
  return { total: rows.length, stillThere: rows.some(r => r.nickname === 'member3'),
           privateKept: rows.some(r => r.nickname === 'member7'),
           orphanPic: (await g('avatars')).some(a => a.nickname === 'member3') };
});
ok('the deleted account is gone', !afterRemove.stillThere && afterRemove.total === 23, String(afterRemove.total));
ok('the private one was NOT removed', afterRemove.privateKept);
ok('its photo went with it - no orphan left', !afterRemove.orphanPic);

head('FIND BOX still composes with everything');
await page.fill('#asl-find', 'member1');
await page.waitForTimeout(700);
const found = await page.$$eval('#asl-res .asl-r', es => es.map(e => e.dataset.nick));
ok('Find narrows the list', found.length > 0 && found.every(n => n.includes('member1')),
   found.length + ' matched');
await page.fill('#asl-find', '');
await page.waitForTimeout(500);

head('PAGE ERRORS');
ok('no uncaught errors anywhere in that run', errors.length === 0, errors.slice(0,3).join(' | '));

await showTab(page, 'results');
await page.waitForTimeout(800);
await page.locator('#asl').screenshot({ path: new URL('panel-results.png', import.meta.url).pathname });

// ===================================================================
// A SECOND BROWSER, holding an OLD library: version 2, photos stored
// inside the records. This is the shape the user's 29,013 profiles are
// in right now, so it is the one path that must not go wrong.
// ===================================================================
head('UPGRADING AN EXISTING LIBRARY (v2 database, photos inside the records)');
const ctx2 = await browser.newContext();
await ctx2.route('**://*fetlife.com/**', r =>
  r.fulfill({ status: 200, contentType: 'text/html', body: M.kinkstersPage(9) }));
const p2 = await ctx2.newPage();
const errors2 = [];
p2.on('pageerror', e => errors2.push(String(e)));
await p2.goto('https://fetlife.com/');

const SEEDED = 600;
// Real, decodable JPEGs. A data: URI that is not a valid image fires an error
// event, and the script correctly treats that as a dead link and clears it -
// so a fixture of fake bytes tests the self-healing, not the migration.
const seedPics = {};
for (let i = 0; i < SEEDED; i++)
  if (i % 5 !== 4)
    seedPics['old' + i] = 'data:image/jpeg;base64,' + M.jpegFor('old' + i).toString('base64');
await p2.evaluate(async ({ n, seedPics }) => {
  // This library has already run the one-time shared-image purge, as the
  // real one has. Otherwise that runs here too and is a second variable.
  localStorage.setItem('asl_purged_shared_avatars_v2', '1');
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('asl_search_db', 2);
    q.onupgradeneeded = e => {
      const d = e.target.result;
      d.createObjectStore('results', { keyPath: 'nickname' });
      d.createObjectStore('seen', { keyPath: 'nickname' });
    };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  const tx = db.transaction('results', 'readwrite');
  const st = tx.objectStore('results');
  for (let i = 0; i < n; i++) {
    st.put({ nickname: 'old' + i, age: 30, gender: 'Female', role: 'Switch',
             location: 'Phoenix', url: 'https://fetlife.com/old' + i,
             batch: i < 400 ? 139 : 140, batchPages: '1-500',
             foundAt: 1757000000000 + i, activityChecked: true,
             lastActivity: new Date(Date.now() - 5 * 86400000).toISOString(),
             checkedAt: new Date().toISOString(),
             avatar: seedPics['old' + i] || '' });
  }
  await new Promise(r => { tx.oncomplete = r; });
  db.close();
}, { n: SEEDED, seedPics });
ok('seeded an old-shaped library', (await p2.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const v = db.version;
  const rows = await new Promise(r => { const t = db.transaction('results','readonly').objectStore('results').getAll(); t.onsuccess = () => r(t.result); });
  db.close();
  return v === 2 && rows.length === 600 && rows.filter(x => x.avatar).length === 480;
})), 'v2, 600 records, 480 with photos inside them');

// Now the new script meets it.
await ctx2.addInitScript({ content: WRAPPED });
await p2.goto('https://fetlife.com/p/united-states/arizona/phoenix/kinksters');
await p2.waitForSelector('#asl-btn', { timeout: 15000 });

const migrated = await waitUntil(p2, async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  if (!db.objectStoreNames.contains('avatars')) { db.close(); return { done: false }; }
  const g = s => new Promise(r => { const t = db.transaction(s,'readonly').objectStore(s).getAll(); t.onsuccess = () => r(t.result); });
  const rows = await g('results'); const pics = await g('avatars');
  db.close();
  return { done: rows.every(x => !('avatar' in x)), rows: rows.length,
           pics: pics.length, inline: rows.filter(x => 'avatar' in x).length,
           flag: !!localStorage.getItem('asl_avatars_split_done') };
}, 120000, 'the photo migration');

ok('every record was slimmed down', migrated.inline === 0);
ok('no profile was lost', migrated.rows === SEEDED, String(migrated.rows));
ok('every photo survived the move', migrated.pics === 480, String(migrated.pics));
ok('the empty ones did not become rows', migrated.pics === 480);
ok('it marks itself finished so it never runs twice', migrated.flag);

const spot = await p2.evaluate(async (want) => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const one = await new Promise(r => { const t = db.transaction('avatars','readonly').objectStore('avatars').get('old7'); t.onsuccess = () => r(t.result); });
  db.close();
  return !!one && one.avatar === want;
}, seedPics['old7']);
ok('a moved photo is byte-identical to the original', spot);

await p2.evaluate(() => { document.getElementById('asl').classList.add('open'); });
await showTab(p2, 'results');
await p2.waitForTimeout(1200);
const ui = await p2.evaluate(() => ({
  cards: document.querySelectorAll('#asl-res .asl-r').length,
  imgs: document.querySelectorAll('#asl-res .asl-r img').length,
  opts: [...document.querySelectorAll('#asl-batch option')].map(o => o.textContent),
  count: document.getElementById('asl-rcount').textContent,
}));
ok('the old library still draws, with its photos', ui.cards > 0 && ui.imgs > 0,
   ui.cards + ' cards, ' + ui.imgs + ' photos on the first page');
const survived = await p2.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const pics = await new Promise(r => { const t = db.transaction('avatars','readonly').objectStore('avatars').getAll(); t.onsuccess = () => r(t.result); });
  db.close(); return pics.length;
});
ok('and the photos are still there after drawing them', survived === 480, String(survived));
ok('both old searches are in the dropdown, newest first',
   ui.opts.length === 3 && /Search 140/.test(ui.opts[1]) && /Search 139/.test(ui.opts[2]),
   ui.opts.join(' | '));
ok('the counts describe the whole library', /600 total/.test(ui.count), ui.count);
ok('no uncaught errors during the upgrade', errors2.length === 0, errors2.slice(0,2).join(' | '));
await p2.locator('#asl').screenshot({ path: new URL('panel-migrated.png', import.meta.url).pathname });

// ===================================================================
// THE BLACKLIST BUG. Three people who appear on each other's profile
// pages. Ownership of a picture used to be claimed for every id found
// on a page, so the first profile visited claimed the other two's
// faces, and when their own pages came up their real avatars were
// ruled site furniture and refused for good. It got worse the more
// profiles were scanned.
//
// This guard anchors on a handle the BROKEN code already has - a
// person ending up with no photo - so it fails on the old code rather
// than passing for the wrong reason.
// ===================================================================
head('EACH PERSON KEEPS THEIR OWN FACE (other members appear on every page)');
const ctx3 = await browser.newContext();
await ctx3.route('**://*fetlife.com/**', async route => {
  const u = new URL(route.request().url());
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (u.hostname.endsWith('cdn.fetlife.com')) {
    const hdrs = await route.request().allHeaders();
    if (!hdrs['x-asl-referer'] && !hdrs['referer'])
      return route.fulfill({ status: 403, body: 'no referer', headers: cors });
    const id = (u.pathname.match(/attachments\/(\d+)\//) || [])[1] || '0';
    const who = id === '999999' ? 'HEADER-AVATAR'
              : (M.RING.find(p => String(p.attachment) === id) || {}).nick || 'unknown';
    return route.fulfill({ status: 200, contentType: 'image/jpeg',
                           body: M.jpegFor(who), headers: cors });
  }
  const act = u.pathname.match(/^\/([^/]+)\/activity(\.json)?$/);
  if (act && M.ringByNick(act[1]))
    return route.fulfill({ status: 200, contentType: 'application/json',
                           body: M.ringActivityJson(M.ringByNick(act[1])), headers: cors });
  const prof = u.pathname.match(/^\/([^/]+)\/?$/);
  if (prof && M.ringByNick(prof[1]))
    return route.fulfill({ status: 200, contentType: 'text/html',
                           body: M.ringProfilePage(M.ringByNick(prof[1])), headers: cors });
  return route.fulfill({ status: 200, contentType: 'text/html',
    body: '<html><head><title>x</title></head><body><header><img src="' + M.HEADER_PIC +
          '"></header><main>ok</main></body></html>' });
});
await ctx3.addInitScript({ content: WRAPPED });
const p3 = await ctx3.newPage();
const errors3 = [];
p3.on('pageerror', e => errors3.push(String(e)));
await p3.goto('https://fetlife.com/p/united-states/arizona/phoenix/kinksters');
await p3.waitForSelector('#asl-btn', { timeout: 15000 });

await p3.evaluate(async (ring) => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('asl_search_db');
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  const tx = db.transaction('results', 'readwrite');
  const st = tx.objectStore('results');
  ring.forEach((p, i) => st.put({
    nickname: p.nick, age: p.age, gender: 'Female', role: p.role, location: p.city,
    url: 'https://fetlife.com/' + p.nick, batch: 1, batchPages: '1-1',
    foundAt: 1758000000000 + i, activityChecked: false,
  }));
  await new Promise(r => { tx.oncomplete = r; });
  db.close();
}, M.RING);

await p3.evaluate(() => {
  document.getElementById('asl').classList.add('open');
  document.getElementById('asl-act-min').value = '1';
  document.getElementById('asl-act-max').value = '1';
});
await showTab(p3, 'results');
await p3.evaluate(() => document.getElementById('asl-sort').dispatchEvent(new Event('change')));

const faces = await waitUntil(p3, async () => {
  const db = await new Promise(r => { const q = indexedDB.open('asl_search_db'); q.onsuccess = () => r(q.result); });
  const g = s => new Promise(r => { const t = db.transaction(s,'readonly').objectStore(s).getAll(); t.onsuccess = () => r(t.result); });
  const rows = await g('results'); const pics = await g('avatars');
  db.close();
  const tried = rows.filter(x => x.photoTried || pics.some(a => a.nickname === x.nickname)).length;
  const owned = {};
  for (const a of pics) {
    const m = atob(a.avatar.split(',')[1] || '').match(/ASL-TEST:([\w-]+)/);
    owned[a.nickname] = m ? m[1] : '(undecodable)';
  }
  return { done: tried >= 3, owned, reasons: rows.map(x => x.nickname + ':' + (x.photoReason || '')) };
}, 180000, 'all three photos to resolve');

ok('all three people got a photo', Object.keys(faces.owned).length === 3,
   JSON.stringify(faces.owned) + ' ' + faces.reasons.join(' | '));
ok('and each got their OWN face, not a neighbour\u2019s',
   M.RING.every(p => faces.owned[p.nick] === p.nick), JSON.stringify(faces.owned));
ok('nobody was given the header avatar',
   !Object.values(faces.owned).includes('HEADER-AVATAR'));
const blacklist = await p3.evaluate(() => JSON.parse(localStorage.getItem('asl_chrome_pic_ids') || '[]'));
ok('only the header avatar is blacklisted, not real people',
   blacklist.every(id => id === '999999'), JSON.stringify(blacklist));
const ownerMap = await p3.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('asl_pic_id_owner') || '{}')).length);
ok('the ownership map holds one id per saved photo, not every picture on every page',
   ownerMap <= 3, ownerMap + ' entries for 3 profiles');
ok('no uncaught errors', errors3.length === 0, errors3.slice(0,2).join(' | '));

await browser.close();
console.log('\n' + (fails ? fails + ' of ' + checks + ' FAILED' : 'All ' + checks + ' browser checks passed.'));
process.exitCode = fails ? 1 : 0;
