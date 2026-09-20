import 'fake-indexeddb/auto';
import fs from 'fs';

const src = fs.readFileSync(new URL('../fetlife-asl-search-activity-v7.user.js', import.meta.url),'utf8');

// Lift the storage layer out of the script verbatim - no reimplementation,
// so the test is exercising the shipped code.
function lift(name){
  const pat = new RegExp('\\n    (?:async )?function ' + name + '\\s*\\(');
  const m = pat.exec(src);
  if(!m) throw new Error('not found: ' + name);
  const start = m.index + 1;
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for(; i < src.length; i++){
    if(src[i]==='{') depth++;
    else if(src[i]==='}'){ depth--; if(!depth){ end = i+1; break; } }
  }
  return src.slice(start, end);
}
const NAMES = ['openDB','dbGetAllResults','dbGetResult','dbGetNicknames','dbPutResults',
  'dbGetAvatars','dbGetAvatar','dbGetAvatarKeys','dbDeleteAvatars','dbRenameAvatar',
  'dbDelete','dbDeleteMany','dbClearResults','dbGetCount','moveAvatarChunk',
  'migrateAvatarsOutOfRecords'];
const consts = /const DB_NAME[\s\S]*?const AVATAR_STORE = 'avatars';/.exec(src)[0];
const flags  = /const AVATAR_SPLIT_FLAG[\s\S]*?const SPLIT_CHUNK = \d+;/.exec(src)[0];

const store = new Map();
const localStorage = { getItem:k=>store.has(k)?store.get(k):null, setItem:(k,v)=>store.set(k,String(v)),
                       removeItem:k=>store.delete(k) };
const document = { getElementById: () => null };
const api = new Function('indexedDB','localStorage','document','console',
  'let dbPromise = null;\n' + consts + '\n' + flags + '\n' + NAMES.map(lift).join('\n') +
  '\nreturn {' + NAMES.join(',') + '};')(indexedDB, localStorage, document, console);

let fails = 0;
const ok = (label, cond, extra) => {
  console.log((cond?'PASS  ':'FAIL  ') + label + (extra && !cond ? '  ->  ' + extra : ''));
  if(!cond) fails++;
};
const bytes = o => Buffer.byteLength(JSON.stringify(o));
const pic = seed => 'data:image/jpeg;base64,' + Buffer.from('x'.repeat(9000) + seed).toString('base64');

// ---- build a v2-shaped database: pictures INSIDE the records -------------
const N = 2000;
await new Promise((res, rej) => {
  const r = indexedDB.open('asl_search_db', 2);
  r.onupgradeneeded = e => {
    const db = e.target.result;
    db.createObjectStore('results', { keyPath:'nickname' });
    db.createObjectStore('seen', { keyPath:'nickname' });
  };
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction('results','readwrite');
    const st = tx.objectStore('results');
    for(let i=0;i<N;i++){
      st.put({ nickname:'u'+i, age:30, gender:'F', role:'sub', location:'Phoenix',
               url:'https://fetlife.com/u'+i, batch: i<1200?140:139, batchPages:'1-500',
               foundAt: 1758000000000+i, activityChecked:true,
               lastActivity:'2026-09-10T00:00:00.000Z',
               avatar: i % 4 === 3 ? '' : pic(i) });     // three in four have a photo
    }
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => rej(tx.error);
  };
  r.onerror = () => rej(r.error);
});

const beforeBytes = bytes(await api.dbGetAllResults());
console.log('\nLibrary of ' + N + ' profiles, three in four with a photo.');
console.log('List query BEFORE the split: ' + (beforeBytes/1048576).toFixed(1) + ' MB\n');

// ---- interrupt the migration half way, then finish it --------------------
const keys = [...await api.dbGetNicknames()];
const db = await api.openDB();
let movedInPartial = 0;
for (let i = 0; i < 1000; i += 250) movedInPartial += await api.moveAvatarChunk(db, keys.slice(i, i+250));
const halfway = await api.dbGetAllResults();
ok('a half-moved library still holds every photo somewhere',
   halfway.filter(r => r.avatar).length + (await api.dbGetAvatarKeys()).size === 1500,
   halfway.filter(r=>r.avatar).length + ' inline + ' + (await api.dbGetAvatarKeys()).size + ' moved');

const moved = await api.migrateAvatarsOutOfRecords(()=>{});
const after = await api.dbGetAllResults();
const afterBytes = bytes(after);

ok('every record is slim afterwards', after.every(r => !('avatar' in r)));
ok('no photo was lost in the move', (await api.dbGetAvatarKeys()).size === 1500,
   String((await api.dbGetAvatarKeys()).size));
ok('an empty photo did not become a row', !(await api.dbGetAvatarKeys()).has('u3'));
ok('a moved photo is byte-identical', await api.dbGetAvatar('u0') === pic(0));
// Keys come back in lexicographic order, so the interrupted run does not stop
// at a round number. What has to hold is that every photo moved exactly once.
ok('every photo moved exactly once across the interruption',
   movedInPartial + moved === 1500,
   movedInPartial + ' + ' + moved + ' = ' + (movedInPartial + moved));
ok('re-running after the flag is a no-op', await api.migrateAvatarsOutOfRecords(()=>{}) === 0);

console.log('\nList query AFTER the split:  ' + (afterBytes/1048576).toFixed(2) + ' MB' +
            '   (' + (beforeBytes/afterBytes).toFixed(0) + 'x less, every redraw)\n');

// ---- the page of 50 cards only loads 50 photos ---------------------------
const page = after.slice(0, 50).map(r => r.nickname);
const pagePics = await api.dbGetAvatars(page);
ok('a page of 50 cards loads at most 50 photos', pagePics.size <= 50 && pagePics.size > 0,
   String(pagePics.size));
ok('and nobody else’s', [...pagePics.keys()].every(k => page.includes(k)));

// ---- writes go through the one chokepoint -------------------------------
const rec = await api.dbGetResult('u3');
rec.avatar = pic('new');
await api.dbPutResults([rec]);
ok('setting .avatar on a record routes it to the photo store',
   await api.dbGetAvatar('u3') === pic('new'));
ok('and does not put it back in the record', !('avatar' in (await api.dbGetResult('u3'))));

const dead = await api.dbGetResult('u0');
dead.avatar = '';
await api.dbPutResults([dead]);
ok('an emptied photo (a dead CDN link) is removed', await api.dbGetAvatar('u0') === '');

const untouched = await api.dbGetResult('u1');
untouched.checkedAt = 'now';
await api.dbPutResults([untouched]);
ok('an unrelated save leaves the photo alone', await api.dbGetAvatar('u1') === pic(1));

// ---- deletes and renames take the photo with them -----------------------
await api.dbRenameAvatar('u2', 'u2renamed');
ok('a renamed profile keeps its face', await api.dbGetAvatar('u2renamed') === pic(2));
ok('and leaves nothing behind', await api.dbGetAvatar('u2') === '');

await api.dbDelete('u4');
ok('deleting a record deletes its photo', await api.dbGetAvatar('u4') === '');

await api.dbDeleteMany(['u5','u6','u7']);
ok('removing deleted accounts takes their photos',
   (await api.dbGetAvatar('u5')) === '' && (await api.dbGetCount()) === N - 4);

await api.dbClearResults();
ok('Clear All leaves no orphaned photos',
   (await api.dbGetAvatarKeys()).size === 0 && (await api.dbGetCount()) === 0);

console.log(fails ? '\n' + fails + ' FAILED' : '\nAll storage checks passed.');
process.exitCode = fails ? 1 : 0;
