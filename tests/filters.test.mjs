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
const code = ['isDeadEnd','batchSummaries','batchLabel'].map(lift).join('\n');
const { isDeadEnd, batchSummaries, batchLabel } = new Function(code +
  '\nreturn {isDeadEnd, batchSummaries, batchLabel};')();

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
