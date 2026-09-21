import fs from 'fs';
const src = fs.readFileSync(new URL('../fetlife-asl-search-activity-v7.user.js', import.meta.url),'utf8');

// Lift the pure functions out of the script verbatim and run them.
function lift(name) {
  const start = src.indexOf('    function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
const code = ['isDeadEnd','batchSummaries','batchLabel','timeOf','sortProfiles'].map(lift).join('\n');
const { isDeadEnd, batchSummaries, batchLabel, sortProfiles } = new Function(code +
  '\nreturn {isDeadEnd, batchSummaries, batchLabel, sortProfiles};')();

// Synthetic library resembling the real one: 3 searches + pre-batch records,
// with deleted / private / fine profiles mixed in.
const DAY = 86400000, now = Date.parse('2026-09-17T12:00:00Z');
const recs = [];
let n = 0;
const add = (batch, foundAt, extra = {}) =>
  recs.push({ nickname: 'u' + (n++), batch, batchPages: batch ? '1-500' : '', foundAt, ...extra });
for (let i = 0; i < 10; i++) add(140, now - 3 * DAY + i);
add(140, now - 3 * DAY + 99, { gone: true, activityError: 404 });
add(140, now - 3 * DAY + 98, { restricted: true, activityError: 403 });
for (let i = 0; i < 4; i++) add(139, now - 30 * DAY + i);
add(139, now - 30 * DAY + 9, { gone: true });
for (let i = 0; i < 3; i++) add(12, Date.parse('2025-11-02T09:00:00Z') + i);
for (let i = 0; i < 2; i++) add(undefined, 0);   // pre-batch records

const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) { console.log('   got:  ' + JSON.stringify(got)); console.log('   want: ' + JSON.stringify(want)); process.exitCode = 1; }
};

eq('dead ends counted', recs.filter(isDeadEnd).length, 3);

// This is the exact composition loadAndDisplayResults uses.
const pool = recs.filter(p => !isDeadEnd(p));
const byBatch = (list, sel) => sel === 'all' ? list : list.filter(p => String(p.batch || 0) === sel);
const byName  = (list, q) => q ? list.filter(p => (p.nickname||'').toLowerCase().includes(q)) : list;

eq('search 140 hides its deleted + private', byBatch(pool, '140').length, 10);
eq('search 139 hides its deleted',           byBatch(pool, '139').length, 4);
eq('pre-batch records land under "0"',       byBatch(pool, '0').length, 2);
eq('all searches = everything alive',        byBatch(pool, 'all').length, 19);
eq('show-hidden restores them',              byBatch(recs, '140').length, 12);
eq('find composes with the search filter',   byName(byBatch(pool,'140'),'u3').length, 1);

const sums = batchSummaries(pool);
eq('newest search first', sums.map(b => b.batch), [140, 139, 12, 0]);
eq('counts match what selecting shows', sums.map(b => b.count), [10, 4, 3, 2]);
console.log('\nDropdown as the user will see it:');
console.log('  All searches');
for (const b of sums) console.log('  ' + batchLabel(b));

// ---------------------------------------------------------------------------
// "Recently checked". checkedAt was written as a NUMBER by the activity check
// and as an ISO STRING by the background refresh, and the comparator
// subtracted them raw. String minus string is NaN, and a comparator that
// returns NaN leaves the order alone - so this sort did nothing.
// This fixture mixes both shapes on purpose; it fails on the old comparator.
// ---------------------------------------------------------------------------
const iso = ms => new Date(ms).toISOString();
const T = Date.parse('2026-09-20T12:00:00Z');
const mixed = [
  { nickname: 'oldest-num',  checkedAt: T - 5 * DAY },            // number
  { nickname: 'newest-iso',  checkedAt: iso(T - 1 * DAY) },       // string
  { nickname: 'middle-num',  checkedAt: T - 3 * DAY },            // number
  { nickname: 'second-iso',  checkedAt: iso(T - 2 * DAY) },       // string
  { nickname: 'never',       checkedAt: null },
];
eq('Recently checked orders newest first across BOTH stored shapes',
   sortProfiles(mixed, 'checked').map(p => p.nickname),
   ['newest-iso', 'second-iso', 'middle-num', 'oldest-num', 'never']);

const acts = [
  { nickname: 'a', lastActivity: iso(T - 30 * DAY) },
  { nickname: 'b', lastActivity: iso(T - 2 * DAY) },
  { nickname: 'c', lastActivity: null },
  { nickname: 'd', lastActivity: iso(T - 9 * DAY) },
];
eq('Last active orders newest first and puts the undated last',
   sortProfiles(acts, 'activity').map(p => p.nickname), ['b', 'd', 'a', 'c']);
