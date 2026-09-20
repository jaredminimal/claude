// ==UserScript==
// @name           FetLife ASL Search + Activity Filter
// @version        9.6.0
// @namespace      https://github.com/jaredminimal/fetlife-asl-search
// @description    Search FetLife profiles by age, sex, location, role — then filter by recent activity. Two-phase crawl with CSV export.
// @match          https://fetlife.com/*
// @run-at         document-idle
// @noframes
// @updateURL      https://raw.githubusercontent.com/jaredminimal/claude/claude/fix-fetlife-rate-limit-uD4Gn/fetlife-asl-search-activity-v7.user.js
// @downloadURL    https://raw.githubusercontent.com/jaredminimal/claude/claude/fix-fetlife-rate-limit-uD4Gn/fetlife-asl-search-activity-v7.user.js
// @grant          GM_xmlhttpRequest
// @grant          unsafeWindow
// @connect        fetlife.com
// @connect        *.fetlife.com
// ==/UserScript==

(function () {
    'use strict';

    // =============================================
    // ARCHITECTURE: Two-phase search
    // =============================================
    // Phase 1: Page-navigation crawl of member lists (same as v5.6)
    //   - FetLife is a Vue.js SPA; fetch()/iframes return empty shells
    //   - Real page navigation is required to get rendered member cards
    //   - Scrape → save → navigate → repeat
    //
    // Phase 2: Activity check (new)
    //   - For each Phase 1 match, fetch /{nickname}/activity with Accept: application/json
    //   - FetLife returns JSON with story_groups[].stories[].created_at timestamps
    //   - The most recent created_at across all stories = last activity date
    //   - Filter out profiles whose last activity is older than threshold
    //   - Uses random delays (3-8s) between fetches to look natural
    //   - Sequential requests only — never parallel
    //

    const STORAGE_KEY = 'asl_search_state';
    const PROGRESS_KEY = 'asl_search_progress';
    const PANEL_OPEN_KEY = 'asl_panel_open';
    const DB_NAME = 'asl_search_db';
    const DB_VERSION = 3;
    const STORE_NAME = 'results';
    const SEEN_STORE = 'seen';
    // Pictures live apart from the profile records. Drawing any list has to
    // load every record to sort and filter it, and a record carrying a base64
    // photo is a thousand times bigger than one that does not - at 29,000
    // profiles that was hundreds of megabytes read back on every keystroke in
    // the Find box. Split out, the list reads a few megabytes and the photos
    // are fetched only for the fifty cards actually on screen.
    const AVATAR_STORE = 'avatars';

    // =====================
    // IndexedDB STORAGE (replaces localStorage for results)
    // =====================
    // Every database call used to open its own connection and never close it,
    // so a long session accumulated thousands of them. One connection, reused,
    // and dropped if it ever closes or another tab needs to upgrade.
    let dbPromise = null;
    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'nickname' });
                }
                if (!db.objectStoreNames.contains(SEEN_STORE)) {
                    db.createObjectStore(SEEN_STORE, { keyPath: 'nickname' });
                }
                if (!db.objectStoreNames.contains(AVATAR_STORE)) {
                    db.createObjectStore(AVATAR_STORE, { keyPath: 'nickname' });
                }
            };
            // A version change cannot happen while another tab holds the old
            // database open, and the wait is silent. Say so instead.
            req.onblocked = () => {
                console.warn('[ASL] Database upgrade blocked by another FetLife tab.');
                const el = document.getElementById('asl-migrate');
                if (el) {
                    el.style.display = 'block';
                    el.textContent = 'Close your other FetLife tabs - the database cannot upgrade while they are open.';
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => { db.close(); dbPromise = null; };
                db.onclose = () => { dbPromise = null; };
                resolve(db);
            };
            req.onerror = () => reject(req.error);
        });
        // A failed open must not be remembered, or every later call inherits it.
        dbPromise.catch(() => { dbPromise = null; });
        return dbPromise;
    }

    async function dbGetAllResults() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function dbGetResult(nickname) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(nickname);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function dbGetNicknames() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(new Set(req.result || []));
            req.onerror = () => reject(req.error);
        });
    }

    // The one place that decides where a picture goes. Anything that sets
    // .avatar on a record and saves it lands here, so no call site has to know
    // that photos live in their own store. An empty avatar means "remove it" -
    // that is how a dead CDN link gets cleared.
    async function dbPutResults(results) {
        const pics = [];
        const rows = results.map(r => {
            if (!Object.prototype.hasOwnProperty.call(r, 'avatar')) return r;
            pics.push({ nickname: r.nickname, avatar: r.avatar || '' });
            const copy = Object.assign({}, r);
            delete copy.avatar;
            return copy;
        });
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, AVATAR_STORE], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const picStore = tx.objectStore(AVATAR_STORE);
            for (const r of rows) store.put(r);
            for (const p of pics) {
                if (p.avatar) picStore.put(p);
                else picStore.delete(p.nickname);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // Only the pictures asked for, which is only ever the cards being drawn.
    async function dbGetAvatars(nicknames) {
        const map = new Map();
        if (!nicknames || !nicknames.length) return map;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(AVATAR_STORE, 'readonly');
            const store = tx.objectStore(AVATAR_STORE);
            for (const n of nicknames) {
                const req = store.get(n);
                req.onsuccess = () => {
                    if (req.result && req.result.avatar) map.set(n, req.result.avatar);
                };
            }
            tx.oncomplete = () => resolve(map);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbGetAvatar(nickname) {
        const map = await dbGetAvatars([nickname]);
        return map.get(nickname) || '';
    }

    // Who has a picture at all, without reading a single one of them.
    async function dbGetAvatarKeys() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(AVATAR_STORE, 'readonly');
            const req = tx.objectStore(AVATAR_STORE).getAllKeys();
            req.onsuccess = () => resolve(new Set(req.result || []));
            req.onerror = () => reject(req.error);
        });
    }

    async function dbDeleteAvatars(nicknames) {
        if (!nicknames || !nicknames.length) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(AVATAR_STORE, 'readwrite');
            const store = tx.objectStore(AVATAR_STORE);
            for (const n of nicknames) store.delete(n);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // A profile that renamed itself keeps its face.
    async function dbRenameAvatar(from, to) {
        const pic = await dbGetAvatar(from);
        if (!pic) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(AVATAR_STORE, 'readwrite');
            const store = tx.objectStore(AVATAR_STORE);
            store.put({ nickname: to, avatar: pic });
            store.delete(from);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbDelete(nickname) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, AVATAR_STORE], 'readwrite');
            tx.objectStore(STORE_NAME).delete(nickname);
            tx.objectStore(AVATAR_STORE).delete(nickname);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbDeleteMany(nicknames) {
        if (!nicknames.length) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, AVATAR_STORE], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const picStore = tx.objectStore(AVATAR_STORE);
            for (const n of nicknames) { store.delete(n); picStore.delete(n); }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbClearResults() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, AVATAR_STORE], 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.objectStore(AVATAR_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbGetCount() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // Seen nicknames — for dedup across sessions
    async function dbGetSeenNicknames() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SEEN_STORE, 'readonly');
            const store = tx.objectStore(SEEN_STORE);
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(new Set(req.result || []));
            req.onerror = () => reject(req.error);
        });
    }

    async function dbAddSeenNicknames(nicknames) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SEEN_STORE, 'readwrite');
            const store = tx.objectStore(SEEN_STORE);
            for (const n of nicknames) {
                store.put({ nickname: n });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function dbGetSeenCount() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SEEN_STORE, 'readonly');
            const store = tx.objectStore(SEEN_STORE);
            const req = store.count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function dbClearSeen() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SEEN_STORE, 'readwrite');
            const store = tx.objectStore(SEEN_STORE);
            const req = store.clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    // Migrate old localStorage results to IndexedDB (one-time)
    async function migrateFromLocalStorage() {
        try {
            const old = localStorage.getItem('asl_search_results');
            if (!old) return;
            const results = JSON.parse(old);
            if (results && results.length > 0) {
                console.log('[ASL] Migrating', results.length, 'results from localStorage to IndexedDB...');
                await dbPutResults(results);
                localStorage.removeItem('asl_search_results');
                console.log('[ASL] Migration complete.');
            }
        } catch(e) {
            console.error('[ASL] Migration error:', e);
        }
    }

    // Gender codes used by FetLife
    const GENDERS = [
        'F','W','FEM','M','AG','Andro','B','BG','CD/TV','Cis','Db','Dg','DemiG','DW',
        'FtM','GF','GN','GNC','GQ','IS','Masc','MtF','NB','PG','QG','TG','TM','TW',
        'TwoS','UoG','TS','TV'
    ];
    const DEFAULT_GENDERS = new Set(['F','W','FEM']);
    const GENDER_LABELS = {
        'F':'Female','W':'Woman','FEM':'Femme','M':'Male',
        'AG':'Agender','Andro':'Androgyne','B':'Butch','BG':'Bigender',
        'CD/TV':'Crossdresser/TransVestite','Cis':'Cisgender',
        'Db':'Demiboy','Dg':'Demigirl','DemiG':'Demigender','DW':'Demiwoman',
        'FtM':'Transgender - FtM','GF':'Gender Fluid','GN':'Gender Neutral',
        'GNC':'Gender Non-Conforming','GQ':'Gender Queer','IS':'Intersex',
        'Masc':'Masculine','MtF':'Transgender - MtF','NB':'Non-Binary',
        'PG':'Pangender','QG':'Questioning','TG':'Transgender',
        'TM':'Trans Man','TW':'Trans Woman','TwoS':'Two-Spirit',
        'UoG':'Unsure of Gender','TS':'TransSexual','TV':'TransVestite'
    };
    const ROLES = [
        'Dominant','Domme','Dominatrix','Dom','Master','Mistress','Switch',
        'Dom-leaning Switch','Sub-leaning Switch','Submissive','Sub','Slave',
        'Top','Bottom','Power Bottom','Service Top',
        'Sadist','Masochist','Sadomasochist',
        'Kinkster','Fetishist','Hedonist','Exhibitionist','Voyeur',
        'Rigger','Rope Bunny',
        'Daddy','Mommy','Boy','Girl','Little','Middle','babygirl','babyboy',
        'Brat','Brat Tamer','Primal','Primal Hunter','Primal Prey',
        'Princess','Prince','Queen','King','Lady','Lord','Goddess','God',
        'Owner','Pet','Puppy','Kitten','Pony','Handler','Trainer',
        'Degrader','Degradee','Protector','Mentor',
        'Boss','Captain','Sir','Ma\'am',
        'Doll','Toy','Servant','Slave Trainer',
        'Bull','Cuckold','Cuckoldress','Cuck','Stag','Vixen','Hotwife',
        'Ageplayer','Swinger','Vanilla',
        'Unsure','Uncertain','Not Applicable','Exploring','Evolving',
    ];

    // Phase 2 state
    let activityCheckAbort = false;
    let lastCheckBatchTime = parseInt(localStorage.getItem('asl_last_check_batch') || '0');

    // =====================
    // STYLES
    // =====================
    const style = document.createElement('style');
    style.textContent = `
        #asl-btn{position:fixed;bottom:20px;right:20px;z-index:100000;background:#c22;color:#fff;border:none;border-radius:50%;width:56px;height:56px;font-size:18px;font-weight:700;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center}
        #asl-btn:hover{background:#e33}
        #asl{position:fixed;top:10px;right:10px;z-index:100000;width:480px;max-height:calc(100vh - 20px);background:#1a1a2e;color:#e0e0e0;border:1px solid #444;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:none;flex-direction:column;overflow:hidden}
        #asl.open{display:flex}
        #asl .hdr{background:#c22;color:#fff;padding:10px 16px;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
        #asl .hdr button{background:none;border:none;color:#fff;font-size:20px;cursor:pointer}
        #asl .body{padding:14px;overflow-y:auto;flex:1}
        #asl label.fl{display:block;margin-bottom:4px;font-weight:500;color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
        #asl input[type=number],#asl input[type=text],#asl select,#asl textarea{width:100%;padding:7px 10px;margin-bottom:10px;background:#16213e;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:13px;box-sizing:border-box;font-family:inherit}
        #asl input:focus,#asl select:focus,#asl textarea:focus{outline:none;border-color:#c22}
        #asl .cg{display:flex;flex-wrap:wrap;gap:4px 8px;margin-bottom:10px;max-height:80px;overflow-y:auto;padding:4px;background:#16213e;border-radius:6px}
        #asl .cg label{display:inline-flex;align-items:center;gap:3px;font-size:12px;color:#ccc;cursor:pointer;white-space:nowrap}
        #asl .cg input[type=checkbox]{accent-color:#c22}
        #asl .row{display:flex;gap:10px}
        #asl .row>div{flex:1}
        #asl .sec{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:1px;margin:10px 0 6px;border-bottom:1px solid #333;padding-bottom:4px}
        #asl .sh{display:flex;gap:8px;margin-bottom:4px}
        #asl .sh a{color:#c22;font-size:11px;cursor:pointer;text-decoration:none}
        #asl .sh a:hover{text-decoration:underline}
        .asl-b{width:100%;padding:9px;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;margin-top:4px}
        #asl-go{background:#c22;color:#fff}#asl-go:hover{background:#e33}#asl-go:disabled{background:#666;cursor:not-allowed}
        #asl-stop{background:#d93;color:#fff;margin-top:6px;display:none}
        #asl-clear{background:#555;color:#fff;margin-top:6px;display:none}
        #asl-csv{background:#2a6;color:#fff;margin-top:6px;display:none}#asl-csv:hover{background:#3b7}
        #asl-load-more{background:#47a;color:#fff;margin-top:6px;cursor:pointer}#asl-load-more:hover{background:#58b}
        #asl-status{margin-top:8px;padding:8px 10px;background:#16213e;border-radius:6px;font-size:13px;color:#ccc;display:none;word-break:break-word}
        #asl-rcount{margin:8px 0 4px;font-size:12px;color:#888}
        #asl-res{margin-top:4px}
        .asl-r{display:flex;gap:8px;padding:8px;background:#16213e;border-radius:8px;margin-bottom:6px;align-items:center;border:1px solid #222}
        .asl-r:hover{border-color:#c22}
        .asl-r img{width:110px;height:110px;border-radius:8px;object-fit:cover;flex-shrink:0}.asl-r a.av{flex-shrink:0}
        .asl-r .i{flex:1;min-width:0}
        .asl-r .i a{color:#fff;text-decoration:none;font-weight:600;font-size:13px}
        .asl-r .i a:hover{text-decoration:underline}
        .asl-r .i .m{color:#999;font-size:11px;margin-top:1px}
        .asl-r .i .m.active{color:#6c6}
        .asl-r .i .m.inactive{color:#c66}
        .asl-r .act{flex-shrink:0;text-align:right}
        .asl-r .act a{color:#c22;text-decoration:none;font-size:11px;display:block;margin:2px 0}
        #asl-tabs{display:flex;margin-bottom:10px}
        #asl-tabs button{flex:1;padding:8px 4px;background:#16213e;border:1px solid #333;color:#888;font-size:12px;font-weight:600;cursor:pointer}
        #asl-tabs button:first-child{border-radius:6px 0 0 6px}
        #asl-tabs button:last-child{border-radius:0 6px 6px 0}
        #asl-tabs button.on{background:#c22;color:#fff;border-color:#c22}
        .asl-tab{display:none}.asl-tab.on{display:block}
        #asl input[type=range]{width:100%;accent-color:#c22;margin-bottom:8px}
        .asl-crawl-banner{position:fixed;top:0;left:0;right:0;z-index:100001;background:#c22;color:#fff;padding:10px 20px;font:14px -apple-system,sans-serif;display:flex;justify-content:space-between;align-items:center}
        .asl-crawl-banner button{background:#fff;color:#c22;border:none;padding:6px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px}
        .asl-batch-divider{padding:6px 12px;margin:10px 0 6px;font-size:11px;font-weight:600;color:#c22;text-transform:uppercase;letter-spacing:.5px;border-top:1px solid #333;border-bottom:1px solid #333;background:#16213e;text-align:center}
        #asl-activity-progress{margin-top:8px;padding:8px 10px;background:#16213e;border-radius:6px;font-size:13px;color:#ccc;display:none;word-break:break-word}
        #asl-activity-progress .bar{height:4px;background:#333;border-radius:2px;margin-top:6px;overflow:hidden}
        #asl-activity-progress .bar .fill{height:100%;background:#c22;border-radius:2px;transition:width .3s}
        #asl-import{background:#47a;color:#fff;margin-top:6px}#asl-import:hover{background:#58b}
        #asl-seen-count{font-size:11px;color:#888;margin-top:4px}
        #asl-check-activity{background:#d80;color:#fff;margin-top:6px;display:none}#asl-check-activity:hover{background:#e91}
        #asl-stop-activity{background:#d93;color:#fff;margin-top:6px;display:none}
    `;
    document.head.appendChild(style);

    // =====================
    // BUILD UI
    // =====================
    function buildUI() {
        const btn = document.createElement('button');
        btn.id = 'asl-btn';
        btn.textContent = 'ASL';
        document.body.appendChild(btn);

        const panel = document.createElement('div');
        panel.id = 'asl';
        panel.innerHTML = `
            <div class="hdr"><span>ASL Search + Activity v7</span><button id="asl-x">&times;</button></div>
            <div class="body">
                <div id="asl-tabs">
                    <button class="on" data-t="search">Search</button>
                    <button data-t="results">Results <span id="asl-rtab-count"></span></button>
                    <button data-t="active">Active <span id="asl-atab-count"></span></button>
                </div>
                <div id="asl-migrate" style="display:none;margin-bottom:8px;padding:8px 10px;background:#16213e;border-radius:6px;font-size:12px;color:#ccc"></div>
                <div id="asl-activity-progress"></div>
                <button class="asl-b" id="asl-stop-activity" style="display:none">Stop Activity Check</button>
                <div class="asl-tab on" id="asl-t-search">
                    <div class="sec">Step 1: Go to a Kinksters Page</div>
                    <p style="font-size:12px;color:#999;margin:0 0 10px">
                        Navigate to a city, state, or country kinksters page first.<br>
                        Example: fetlife.com/p/united-states/arizona/phoenix/kinksters<br>
                        Then set your filters below and click Search.
                    </p>
                    <div class="sec">Step 2: Set Filters</div>
                    <div class="row">
                        <div><label class="fl">Min Age</label><input type="number" id="asl-amin" min="18" max="200" value="18"></div>
                        <div><label class="fl">Max Age</label><input type="number" id="asl-amax" min="18" max="200" value="200"></div>
                    </div>
                    <label class="fl">Gender</label>
                    <div class="sh" id="asl-gh"></div>
                    <div class="cg" id="asl-g">${GENDERS.map(g=>`<label><input type="checkbox" value="${g}"${DEFAULT_GENDERS.has(g)?' checked':''}> ${GENDER_LABELS[g]||g}</label>`).join('')}</div>
                    <label class="fl"><input type="checkbox" id="asl-role-toggle"> Filter by Role</label>
                    <div class="sh" id="asl-rh"></div>
                    <div class="cg" id="asl-r" style="display:none">${ROLES.map(r=>`<label><input type="checkbox" value="${r}" checked> ${r}</label>`).join('')}</div>
                    <label class="fl">Location contains (optional)</label>
                    <input type="text" id="asl-loc" placeholder="e.g. Phoenix, Scottsdale">
                    <div class="sec">Step 3: Activity Filter</div>
                    <label class="fl">Show only members active within</label>
                    <select id="asl-activity">
                        <option value="0">Any (skip activity check)</option>
                        <option value="30">Last 30 days</option>
                        <option value="60">Last 60 days</option>
                        <option value="90" selected>Last 90 days</option>
                        <option value="180">Last 6 months</option>
                        <option value="365">Last year</option>
                    </select>
                    <div class="sec">Step 4: Speed &amp; Limits</div>
                    <label class="fl">Delay between pages: <span id="asl-dl">1.5</span>s</label>
                    <input type="range" id="asl-spd" min="1" max="20" value="1.5" step="0.5">
                    <label class="fl">Pages to search</label>
                    <input type="number" id="asl-mp" min="1" max="5000" value="500">
                    <button class="asl-b" id="asl-go">Start Search</button>
                    <div id="asl-status"></div>
                </div>
                <div class="asl-tab" id="asl-t-results">
                    <p style="font-size:12px;color:#999;margin:0 0 8px">Every profile found across your searches. Run an activity check to move active ones into the Active tab.</p>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Search</label>
                        <select id="asl-batch" style="margin:0;flex:1;min-width:0"><option value="all">All searches</option></select>
                    </div>
                    <button class="asl-b" id="asl-recheck-batch" style="background:#d80;color:#fff;display:none">Re-check this search</button>
                    <label class="fl" id="asl-recheck-batch-skip-wrap" style="display:none;margin:4px 0 0;text-transform:none;letter-spacing:0;font-size:12px;color:#999;font-weight:400"><input type="checkbox" id="asl-recheck-batch-skip" checked> Skip ones that already have a photo and a recent check</label>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Sort by</label>
                        <select id="asl-sort" style="width:auto;margin:0">
                            <option value="newest" selected>Newest first</option>
                            <option value="activity">Last active</option>
                            <option value="age-asc">Age (youngest)</option>
                            <option value="age-desc">Age (oldest)</option>
                            <option value="checked">Recently checked</option>
                        </select>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Find</label>
                        <input type="search" id="asl-find" placeholder="type a name…" style="margin:0;flex:1">
                    </div>
                    <label class="fl" id="asl-hidden-wrap" style="display:none;margin:6px 0 0;text-transform:none;letter-spacing:0;font-size:12px;color:#999;font-weight:400"><input type="checkbox" id="asl-show-hidden"> Show deleted &amp; private (<span id="asl-hidden-n">0</span>)</label>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Check last</label>
                        <input type="number" id="asl-check-limit" min="1" max="99999" value="5000" style="width:80px;margin:0">
                        <label class="fl" style="margin:0;white-space:nowrap">unchecked</label>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Delay</label>
                        <input type="number" id="asl-act-min" min="1" max="60" step="0.5" value="3" style="width:60px;margin:0">
                        <label class="fl" style="margin:0;white-space:nowrap">to</label>
                        <input type="number" id="asl-act-max" min="1" max="120" step="0.5" value="6" style="width:60px;margin:0">
                        <label class="fl" style="margin:0;white-space:nowrap">sec / request</label>
                    </div>
                    <p style="font-size:11px;color:#c66;margin:2px 0 6px">Going below ~3s risks a FetLife lockout. A profile costs one request, or two when its photo has to be fetched from the profile page.</p>
                    <button class="asl-b" id="asl-check-activity">Check Activity Now</button>
                    <button class="asl-b" id="asl-retry-failed" style="background:#d80;color:#fff;display:none">Retry Failed Checks</button>
                    <button class="asl-b" id="asl-csv">Export All to CSV</button>
                    <button class="asl-b" id="asl-import">Import CSV for Dedup</button>
                    <input type="file" id="asl-import-file" accept=".csv" style="display:none">
                    <div id="asl-seen-count"></div>
                    <button class="asl-b" id="asl-remove-gone" style="background:#853;color:#fff;display:none">Remove deleted accounts</button>
                    <button class="asl-b" id="asl-clear">Clear All Results</button>
                    <div id="asl-rcount"></div>
                    <div id="asl-res"></div>
                </div>
                <div class="asl-tab" id="asl-t-active">
                    <p style="font-size:12px;color:#999;margin:0 0 8px">Profiles confirmed active within your threshold. Re-check to refresh their activity &amp; photos.</p>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Search</label>
                        <select id="asl-active-batch" style="margin:0;flex:1;min-width:0"><option value="all">All searches</option></select>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Sort by</label>
                        <select id="asl-active-sort" style="width:auto;margin:0">
                            <option value="newest" selected>Newest first</option>
                            <option value="activity">Last active</option>
                            <option value="age-asc">Age (youngest)</option>
                            <option value="age-desc">Age (oldest)</option>
                            <option value="checked">Recently checked</option>
                        </select>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Find</label>
                        <input type="search" id="asl-active-find" placeholder="type a name…" style="margin:0;flex:1">
                    </div>
                    <label class="fl" id="asl-active-hidden-wrap" style="display:none;margin:6px 0 0;text-transform:none;letter-spacing:0;font-size:12px;color:#999;font-weight:400"><input type="checkbox" id="asl-active-show-hidden"> Show deleted &amp; private (<span id="asl-active-hidden-n">0</span>)</label>
                    <div class="sec">Re-check by Age</div>
                    <div class="row">
                        <div><label class="fl">Min Age</label><input type="number" id="asl-recheck-amin" min="18" max="200" value="18" style="margin-bottom:4px"></div>
                        <div><label class="fl">Max Age</label><input type="number" id="asl-recheck-amax" min="18" max="200" value="99" style="margin-bottom:4px"></div>
                    </div>
                    <button class="asl-b" id="asl-recheck" style="background:#d80;color:#fff;margin-top:0">Re-check by Age</button>
                    <div class="sec">Re-check by Range</div>
                    <div style="display:flex;gap:8px;align-items:center">
                        <label class="fl" style="margin:0;white-space:nowrap">Active #</label>
                        <input type="number" id="asl-recheck-from" min="1" max="99999" value="1" style="width:70px;margin:0">
                        <label class="fl" style="margin:0;white-space:nowrap">to</label>
                        <input type="number" id="asl-recheck-to" min="1" max="99999" value="500" style="width:70px;margin:0">
                    </div>
                    <label class="fl" style="margin:4px 0"><input type="checkbox" id="asl-recheck-skip-pics" checked> Skip profiles that already have a saved pic</label>
                    <button class="asl-b" id="asl-recheck-last" style="background:#d80;color:#fff;margin-top:0">Re-check Range (refresh pics)</button>
                    <button class="asl-b" id="asl-active-csv" style="background:#2a6;color:#fff">Export Active to CSV</button>
                    <div id="asl-photo-status" style="font-size:11px;color:#89a;margin:4px 0"></div>
                    <div id="asl-active-count"></div>
                    <div id="asl-active-res"></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        // Tabs
        panel.querySelectorAll('#asl-tabs button').forEach(b => {
            b.addEventListener('click', () => {
                panel.querySelectorAll('#asl-tabs button').forEach(x => x.classList.remove('on'));
                panel.querySelectorAll('.asl-tab').forEach(x => x.classList.remove('on'));
                b.classList.add('on');
                document.getElementById('asl-t-' + b.dataset.t).classList.add('on');
            });
        });

        // The crawl navigates the page, which rebuilds this panel closed. Keep
        // it open across those navigations so a long crawl can be watched.
        const rememberOpen = () =>
            localStorage.setItem(PANEL_OPEN_KEY, panel.classList.contains('open') ? '1' : '');
        btn.addEventListener('click', () => { panel.classList.toggle('open'); rememberOpen(); });
        document.getElementById('asl-x').addEventListener('click', () => {
            panel.classList.remove('open'); rememberOpen();
        });
        if (localStorage.getItem(PANEL_OPEN_KEY)) panel.classList.add('open');
        document.getElementById('asl-spd').addEventListener('input', function() {
            document.getElementById('asl-dl').textContent = this.value;
        });

        helpers('asl-g', 'asl-gh');
        helpers('asl-r', 'asl-rh');
        document.getElementById('asl-role-toggle').addEventListener('change', function() {
            document.getElementById('asl-r').style.display = this.checked ? '' : 'none';
            document.getElementById('asl-rh').style.display = this.checked ? '' : 'none';
        });

        document.getElementById('asl-go').addEventListener('click', startNewSearch);
        document.getElementById('asl-csv').addEventListener('click', exportCSV);
        document.getElementById('asl-import').addEventListener('click', () => document.getElementById('asl-import-file').click());
        document.getElementById('asl-import-file').addEventListener('change', importCSVForDedup);
        document.getElementById('asl-clear').addEventListener('click', clearResults);
        // Explicitly true. This used to be wired straight to the function, so
        // the click event arrived as `refreshAvatars` and was truthy by
        // accident - which is why every run was quietly fetching photos too,
        // at two or three requests per profile, while the notes said one.
        // Refreshing photos IS wanted; being surprised by the request count is
        // not, and the pacer above now charges for it honestly.
        document.getElementById('asl-check-activity').addEventListener('click', () => startActivityCheck(true));
        document.getElementById('asl-retry-failed').addEventListener('click', retryFailedChecks);
        document.getElementById('asl-recheck').addEventListener('click', recheckByAge);
        document.getElementById('asl-recheck-last').addEventListener('click', recheckLastN);
        document.getElementById('asl-stop-activity').addEventListener('click', () => { activityCheckAbort = true; });
        document.getElementById('asl-sort').addEventListener('change', loadAndDisplayResults);
        document.getElementById('asl-active-sort').addEventListener('change', loadAndDisplayResults);
        document.getElementById('asl-active-csv').addEventListener('click', exportActiveCSV);
        document.getElementById('asl-batch').addEventListener('change', loadAndDisplayResults);
        document.getElementById('asl-active-batch').addEventListener('change', loadAndDisplayResults);
        document.getElementById('asl-show-hidden').addEventListener('change', loadAndDisplayResults);
        document.getElementById('asl-active-show-hidden').addEventListener('change', loadAndDisplayResults);
        document.getElementById('asl-remove-gone').addEventListener('click', removeGoneProfiles);
        document.getElementById('asl-recheck-batch').addEventListener('click', recheckSelectedSearch);
        let findTimer = null;
        for (const id of ['asl-find', 'asl-active-find']) {
            document.getElementById(id).addEventListener('input', () => {
                clearTimeout(findTimer);
                findTimer = setTimeout(loadAndDisplayResults, 200);
            });
        }

        // Load any existing results
        loadAndDisplayResults();
        updateSeenCount();
    }

    function helpers(cgId, shId) {
        const cg = document.getElementById(cgId);
        const sh = document.getElementById(shId);
        ['All','None','Invert'].forEach(l => {
            const a = document.createElement('a');
            a.textContent = l;
            a.addEventListener('click', e => {
                e.preventDefault();
                cg.querySelectorAll('input').forEach(cb => {
                    if (l === 'All') cb.checked = true;
                    else if (l === 'None') cb.checked = false;
                    else cb.checked = !cb.checked;
                });
            });
            sh.appendChild(a);
        });
    }

    // Existing libraries have their pictures inside the profile records. Move
    // them across in chunks, outside the version-change transaction, so a big
    // library does not freeze the tab. It is resumable by construction: a
    // record that still has an .avatar is a record still to do, so an
    // interrupted run simply carries on next time. The flag only skips the
    // scan once everything is known to be across.
    const AVATAR_SPLIT_FLAG = 'asl_avatars_split_done';
    const SPLIT_CHUNK = 250;

    function moveAvatarChunk(db, nicknames) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, AVATAR_STORE], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const picStore = tx.objectStore(AVATAR_STORE);
            let moved = 0;
            for (const n of nicknames) {
                const req = store.get(n);
                req.onsuccess = () => {
                    const rec = req.result;
                    if (!rec || !Object.prototype.hasOwnProperty.call(rec, 'avatar')) return;
                    if (rec.avatar) {
                        picStore.put({ nickname: rec.nickname, avatar: rec.avatar });
                        moved++;
                    }
                    delete rec.avatar;
                    store.put(rec);
                };
            }
            tx.oncomplete = () => resolve(moved);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    async function migrateAvatarsOutOfRecords(onProgress) {
        if (localStorage.getItem(AVATAR_SPLIT_FLAG)) return 0;
        const db = await openDB();
        const keys = [...await dbGetNicknames()];
        let moved = 0;
        for (let i = 0; i < keys.length; i += SPLIT_CHUNK) {
            const slice = keys.slice(i, i + SPLIT_CHUNK);
            moved += await moveAvatarChunk(db, slice);
            if (onProgress) onProgress(Math.min(i + SPLIT_CHUNK, keys.length), keys.length);
            // Hand the tab back between chunks so the panel stays usable.
            await new Promise(r => setTimeout(r, 0));
        }
        localStorage.setItem(AVATAR_SPLIT_FLAG, '1');
        return moved;
    }

    async function splitAvatarsIfNeeded() {
        const el = document.getElementById('asl-migrate');
        try {
            const moved = await migrateAvatarsOutOfRecords((done, total) => {
                if (!el || !total) return;
                el.style.display = 'block';
                el.textContent = 'Tidying up stored photos so the lists stay quick - ' +
                    done.toLocaleString() + ' of ' + total.toLocaleString() +
                    '. This happens once, and you can keep using the panel.';
            });
            if (el) el.style.display = 'none';
            if (moved) {
                console.log('[ASL] Moved', moved, 'pictures into their own store');
                await loadAndDisplayResults();
            }
        } catch(e) {
            console.error('[ASL] Avatar split failed, will retry next load:', e);
            if (el) el.style.display = 'none';
        }
    }

    // =====================
    // STATUS
    // =====================
    function setStatus(msg) {
        const el = document.getElementById('asl-status');
        if (el) { el.style.display = 'block'; el.textContent = msg; }
        console.log('[ASL]', msg);
    }

    // =====================
    // SEARCH STATE (persisted in localStorage)
    // =====================
    function getSavedState() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch(e) { return null; }
    }

    function saveState(s) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    }

    function clearState() {
        localStorage.removeItem(STORAGE_KEY);
    }

    function getProgress() {
        try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || { lastPageCrawled: 0, batchCount: 0 }; }
        catch(e) { return { lastPageCrawled: 0, batchCount: 0 }; }
    }

    function saveProgress(prog) {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(prog));
    }

    async function clearResults() {
        if (!confirm('Clear ALL results? This cannot be undone. (Your "seen" dedup list is kept.)')) return;
        await dbClearResults();
        localStorage.removeItem(PROGRESS_KEY);
        setStatus('Results cleared.');
        await loadAndDisplayResults();
    }

    // A 404 means the account was deleted or renamed. It can never resolve,
    // so it is the one thing worth offering to throw away. Private profiles
    // (401/403) are real people behind a closed feed, so they are hidden but
    // never removed. Nothing goes without being asked for: there is no backup
    // beyond the CSV export.
    async function removeGoneProfiles() {
        const results = await dbGetAllResults();
        const gone = results.filter(p => p.gone);
        if (!gone.length) { alert('No deleted accounts to remove.'); return; }
        const s = gone.length === 1 ? '' : 's';
        const ok = confirm(
            'Remove ' + gone.length + ' deleted account' + s + ' from your results?\n\n' +
            'These answered 404 - the account was deleted or renamed, so an activity ' +
            'check can never succeed for them.\n\n' +
            'Private profiles are NOT touched. Everything else is left alone.\n\n' +
            'This cannot be undone - export to CSV first if you want a copy.'
        );
        if (!ok) return;
        await dbDeleteMany(gone.map(p => p.nickname));
        await loadAndDisplayResults();
        const left = await dbGetCount();
        alert('Removed ' + gone.length + ' deleted account' + s + '. ' + left + ' profiles left.');
    }

    // =====================
    // START A NEW SEARCH
    // =====================
    function startNewSearch() {
        // Force-clear any stuck search state
        const old = getSavedState();
        if (old && old.active) {
            old.active = false;
            saveState(old);
            if (window._aslNavTimer) { clearTimeout(window._aslNavTimer); window._aslNavTimer = null; }
            removeCrawlBanner();
        }

        const loc = window.location.href.split('?')[0].split('#')[0];
        let baseURL = null;

        if (/\/kinksters$/.test(loc)) {
            baseURL = loc;
        } else if (/\/p\//.test(loc)) {
            baseURL = loc.replace(/\/$/, '') + '/kinksters';
        } else if (/\/(cities|administrative_areas|countries)\/\d+/.test(loc)) {
            baseURL = loc.replace(/\/$/, '') + '/kinksters';
        }

        if (!baseURL) {
            alert('Please navigate to a kinksters page first.\n\nExample:\nfetlife.com/p/united-states/arizona/phoenix/kinksters');
            return;
        }

        const pagesToSearch = parseInt(document.getElementById('asl-mp').value) || 500;
        const params = {
            ageMin: parseInt(document.getElementById('asl-amin').value) || 18,
            ageMax: parseInt(document.getElementById('asl-amax').value) || 200,
            genders: [...document.querySelectorAll('#asl-g input:checked')].map(c => c.value),
            roleFilterEnabled: document.getElementById('asl-role-toggle').checked,
            roles: [...document.querySelectorAll('#asl-r input:checked')].map(c => c.value),
            locFilter: document.getElementById('asl-loc').value.trim().toLowerCase(),
            delay: (parseFloat(document.getElementById('asl-spd').value) || 1.5) * 1000,
            activityDays: parseInt(document.getElementById('asl-activity').value) || 0,
        };

        const prog = getProgress();
        const currentPage = getCurrentPageNumber();
        const startPage = currentPage;
        const batch = prog.batchCount + 1;
        const endPage = startPage + pagesToSearch - 1;

        const searchState = {
            baseURL: baseURL,
            params: params,
            currentPage: startPage,
            startPage: startPage,
            endPage: endPage,
            batch: batch,
            scanned: 0,
            active: true,
        };
        saveState(searchState);

        prog.batchCount = batch;
        saveProgress(prog);

        console.log('[ASL] Starting search batch', batch, '— pages', startPage, 'to', endPage);

        if (currentPage === startPage) {
            scrapCurrentPageAndContinue();
        } else {
            window.location.href = baseURL + '?page=' + startPage;
        }
    }

    // =====================
    // CRAWL LOOP (runs on each page load)
    // =====================
    function checkForOngoingSearch() {
        const s = getSavedState();
        if (!s || !s.active) return false;

        const loc = window.location.href;
        if (!loc.includes('/kinksters')) {
            console.log('[ASL] Not on a kinksters page, pausing search.');
            return false;
        }

        console.log('[ASL] Resuming search — page', getCurrentPageNumber(), 'scanned so far:', s.scanned);
        showCrawlBanner(s);
        scrapCurrentPageAndContinue();
        return true;
    }

    function scrapCurrentPageAndContinue() {
        const s = getSavedState();
        if (!s || !s.active) return;

        const pageNum = getCurrentPageNumber();
        console.log('[ASL] Scraping page', pageNum);

        waitForCards(async function(cards) {
            const profiles = [];
            for (const card of cards) {
                const p = parseCard(card);
                if (p) profiles.push(p);
            }

            console.log('[ASL] Found', profiles.length, 'profiles on page', pageNum);

            if (profiles.length === 0) {
                s.active = false;
                saveState(s);
                const prog = getProgress();
                prog.lastPageCrawled = pageNum;
                saveProgress(prog);
                removeCrawlBanner();
                onPhase1Complete(s);
                return;
            }

            const existing = await dbGetNicknames();
            const seen = await dbGetSeenNicknames();
            const params = s.params;
            const newResults = [];
            const now = Date.now();
            let idx = 0;
            for (const p of profiles) {
                s.scanned++;
                if (matchesFilter(p, params) && !existing.has(p.nickname) && !seen.has(p.nickname)) {
                    p.batch = s.batch;
                    p.batchPages = s.startPage + '-' + s.endPage;
                    p.foundAt = now + idx++; // Preserve page order within same timestamp
                    newResults.push(p);
                    existing.add(p.nickname);
                }
            }
            if (newResults.length > 0) {
                // Convert avatar URLs to base64 so they never expire
                await Promise.all(newResults.map(async (p) => {
                    if (p.avatar && !p.avatar.startsWith('data:')) {
                        const b64 = await fetchImageAsBase64(p.avatar);
                        if (b64) p.avatar = b64;
                    }
                }));
                await dbPutResults(newResults);
                await dbAddSeenNicknames(newResults.map(r => r.nickname));
            }
            const totalCount = await dbGetCount();

            s.currentPage = pageNum + 1;
            saveState(s);
            const prog = getProgress();
            prog.lastPageCrawled = pageNum;
            saveProgress(prog);

            updateCrawlBanner(s, totalCount, pageNum);
            console.log('[ASL] Page', pageNum, ':', newResults.length, 'new matches.', totalCount, 'total matches.', s.scanned, 'scanned.');

            if (pageNum >= s.endPage) {
                s.active = false;
                saveState(s);
                removeCrawlBanner();
                onPhase1Complete(s);
                return;
            }

            const nextURL = s.baseURL + '?page=' + (pageNum + 1);
            console.log('[ASL] Next page in', s.params.delay/1000, 'seconds:', nextURL);
            window._aslNavTimer = setTimeout(() => {
                window.location.href = nextURL;
            }, s.params.delay);
        });
    }

    // Called when Phase 1 (page crawling) finishes
    async function onPhase1Complete(s) {
        const totalCount = await dbGetCount();
        const activityDays = s.params ? s.params.activityDays : 0;

        // Land on the Results tab now that the search is done
        document.querySelector('#asl-tabs button[data-t="results"]')?.click();

        if (activityDays > 0 && totalCount > 0) {
            setStatus('Phase 1 done — ' + totalCount + ' matches from ' + s.scanned + ' scanned. Starting activity check...');
            await loadAndDisplayResults();
            setTimeout(() => startActivityCheck(), 1500);
        } else {
            setStatus('Done! ' + totalCount + ' matches from ' + s.scanned + ' profiles scanned.');
            await loadAndDisplayResults();
        }
    }

    function getCurrentPageNumber() {
        const m = window.location.href.match(/[?&]page=(\d+)/);
        return m ? parseInt(m[1]) : 1;
    }

    // =====================
    // WAIT FOR VUE TO RENDER
    // =====================
    function waitForCards(callback) {
        let attempts = 0;
        function check() {
            const cards = document.querySelectorAll('[data-member-card]');
            if (cards.length > 0) {
                callback(cards);
                return;
            }
            attempts++;
            if (attempts > 30) {
                console.log('[ASL] No cards found after 15s');
                callback([]);
                return;
            }
            setTimeout(check, 500);
        }
        check();
    }

    // =====================
    // CRAWL BANNER
    // =====================
    async function showCrawlBanner(s) {
        removeCrawlBanner();
        const count = await dbGetCount();
        const banner = document.createElement('div');
        banner.className = 'asl-crawl-banner';
        banner.id = 'asl-crawl-banner';
        banner.innerHTML = `
            <span id="asl-banner-text">ASL Search ${s.batch || ''} — Page ${getCurrentPageNumber()} of ${s.startPage || '?'}-${s.endPage || '?'} — ${count} matches so far...</span>
            <button id="asl-banner-stop">Stop Search</button>
        `;
        document.body.prepend(banner);
        document.getElementById('asl-banner-stop').addEventListener('click', stopCrawl);
    }

    function updateCrawlBanner(s, totalMatches, pageNum) {
        const el = document.getElementById('asl-banner-text');
        if (el) {
            el.textContent = `ASL Search ${s.batch || ''} — Page ${pageNum} of ${s.startPage || '?'}-${s.endPage || '?'} — ${totalMatches} matches / ${s.scanned} scanned — Next page in ${s.params.delay/1000}s...`;
        }
    }

    function removeCrawlBanner() {
        const el = document.getElementById('asl-crawl-banner');
        if (el) el.remove();
    }

    async function stopCrawl() {
        if (window._aslNavTimer) { clearTimeout(window._aslNavTimer); window._aslNavTimer = null; }
        const s = getSavedState();
        if (s) {
            s.active = false;
            saveState(s);
            const prog = getProgress();
            prog.lastPageCrawled = getCurrentPageNumber();
            saveProgress(prog);
        }
        removeCrawlBanner();
        console.log('[ASL] Search stopped by user.');
        await loadAndDisplayResults();
    }

    // =====================
    // PHASE 2: ACTIVITY CHECK
    // =====================
    function randomDelay(minMs, maxMs) {
        return minMs + Math.floor(Math.random() * (maxMs - minMs));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Any FetLife-hosted image, whatever CDN subdomain it sits on. Older pics
    // are on pic*.cdn.fetlife.com, newer ones on flpics*.cdn.fetlife.com, and
    // og:image tags sometimes point at another host again — so match on the
    // domain, not on a guessed subdomain prefix.
    const FL_IMG_HOST = /https?:\/\/[a-z0-9.-]*fetlife\.com\//i;

    // Convert image URL to base64 data URL via GM_xmlhttpRequest (bypasses CORS).
    // The CDN checks the referrer — a plain GM_xmlhttpRequest sends none and gets
    // a 403, which is why in-page <img> tags load fine but our copies came back
    // empty. Send the same Referer the browser would.
    function fetchImageAsBase64(url, trace) {
        const note = m => { if (trace) trace.push(m); };
        if (!url || url.startsWith('data:')) return Promise.resolve(url);
        // This used to accept any fetlife.com URL, which is not the same
        // question. An <img> with an empty or relative src resolves to the
        // PAGE's own address, and that address passed - so the HTML of the
        // kinksters page was downloaded and saved as somebody's photo. Ask the
        // question that was always meant: is this a member's picture on the
        // picture CDN, and not site furniture?
        if (!isMemberPicture(url)) {
            console.log('[ASL] Not a member picture, skipping:', url.substring(0, 60));
            note('Skipped: not a member picture');
            return Promise.resolve('');
        }
        return new Promise((resolve) => {
            try {
                gmRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'arraybuffer',
                    headers: {
                        'Referer': 'https://fetlife.com/',
                        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                    },
                    onload: function(resp) {
                        const size = resp.response ? resp.response.byteLength : 0;
                        console.log('[ASL] Image fetch status:', resp.status, 'size:', size);
                        note('Download: HTTP ' + resp.status + ', ' + size + ' bytes');
                        if (resp.status !== 200 || !resp.response || size < 100) {
                            resolve('');
                            return;
                        }
                        try {
                            const bytes = new Uint8Array(resp.response);
                            const chunks = [];
                            for (let i = 0; i < bytes.length; i += 8192) {
                                chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length))));
                            }
                            const b64 = 'data:' + sniffImageType(bytes) + ';base64,' + btoa(chunks.join(''));
                            console.log('[ASL] Base64 converted, length:', b64.length);
                            note('Converted to a saved image (' + Math.round(b64.length / 1024) + ' KB)');
                            resolve(b64);
                        } catch(e) {
                            console.error('[ASL] Base64 conversion error:', e);
                            note('Conversion failed: ' + e.message);
                            resolve('');
                        }
                    },
                    onerror: function(e) {
                        console.error('[ASL] GM_xmlhttpRequest image error:', e);
                        note('Download failed (network/blocked)');
                        resolve('');
                    }
                });
            } catch(e) {
                console.error('[ASL] GM_xmlhttpRequest call failed:', e);
                note('Download call failed: ' + e.message);
                resolve('');
            }
        });
    }

    // Label the data: URI correctly — FetLife serves webp and png as well as
    // jpeg, and a wrong label makes the browser refuse to render it.
    function sniffImageType(bytes) {
        if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
        if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
        if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) return 'image/webp';
        return 'image/jpeg';
    }

    // GM_xmlhttpRequest wrapper — bypasses FetLife's service worker
    // EVERY request to fetlife.com goes through here. The delay setting was
    // always meant to be the gap between requests, but it was applied per
    // PROFILE - and a profile that also refreshes its photo costs two or three
    // requests, fired back to back, then waits. That burst is the shape that
    // caused the lockout in the first place (a 1.5-3s gap with three requests
    // per profile). Pacing here makes the rate a property of the script rather
    // than of whichever loop is running, so a profile that costs three
    // requests takes three slots.
    //
    // CDN image downloads are deliberately NOT paced: they are a different
    // host, the browser is already loading those same images to draw the page,
    // and pacing them would make a 500-page crawl take days.
    const PACED_HOST = /^https?:\/\/(www\.)?fetlife\.com\//i;
    let nextSlot = 0;
    function requestGap() {
        const el = id => (document.getElementById(id) || {}).value;
        const min = (parseFloat(el('asl-act-min')) || 3) * 1000;
        const max = (parseFloat(el('asl-act-max')) || 6) * 1000;
        return randomDelay(min, Math.max(max, min + 1));
    }
    function gmRequest(opts) {
        if (!opts || !PACED_HOST.test(opts.url || '')) { GM_xmlhttpRequest(opts); return; }
        const now = Date.now();
        const wait = Math.max(0, nextSlot - now);
        nextSlot = Math.max(now, nextSlot) + requestGap();
        if (wait) setTimeout(() => GM_xmlhttpRequest(opts), wait);
        else GM_xmlhttpRequest(opts);
    }

    function gmFetch(url, headers) {
        return new Promise((resolve, reject) => {
            gmRequest({
                method: 'GET',
                url: url,
                headers: headers || {},
                onload: function(resp) {
                    resolve({
                        ok: resp.status >= 200 && resp.status < 300,
                        status: resp.status,
                        responseText: resp.responseText,
                        finalUrl: resp.finalUrl || url,
                    });
                },
                onerror: function(err) {
                    reject(err);
                }
            });
        });
    }

    // FetLife changes how it negotiates JSON on /activity from time to time
    // (a 406 means it rejected our Accept header). Try known request shapes,
    // remember whichever works, and only re-probe if that one starts failing.
    const ACTIVITY_METHODS = [
        { suffix: '/activity', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } },
        { suffix: '/activity', headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' } },
        { suffix: '/activity.json', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } },
        { suffix: '/activity.json', headers: { 'Accept': 'application/json' } },
        { suffix: '/activity', headers: { 'Accept': 'application/json' } },
    ];
    let activityMethodIdx = null;

    async function fetchActivityRaw(profileUrl) {
        const base = profileUrl.replace(/\/+$/, '');
        // Use the already-resolved method when we have one
        if (activityMethodIdx !== null) {
            const m = ACTIVITY_METHODS[activityMethodIdx];
            const resp = await gmFetch(base + m.suffix, m.headers);
            if (resp.ok || resp.status !== 406) return resp;
            console.log('[ASL] Activity method started returning 406 — re-probing...');
            activityMethodIdx = null;
        }
        // Probe each shape until one works, then remember it
        let last = null;
        for (let i = 0; i < ACTIVITY_METHODS.length; i++) {
            const m = ACTIVITY_METHODS[i];
            const resp = await gmFetch(base + m.suffix, m.headers);
            last = resp;
            if (resp.ok && resp.responseText) {
                activityMethodIdx = i;
                console.log('[ASL] Activity method resolved:', m.suffix, JSON.stringify(m.headers));
                return resp;
            }
        }
        return last;
    }

    // Detect FetLife's "Temporarily Locked Out" page. Continuing to hammer
    // during a lockout can escalate the next one, so we stop everything.
    let lockoutDetected = false;
    function isLockedOut(resp) {
        if (!resp) return false;
        if (resp.finalUrl && /\/locked\b/.test(resp.finalUrl)) return true;
        const t = resp.responseText || '';
        return t.includes('Temporarily Locked Out') || t.includes("tripped our security system");
    }

    // Debug helper: run aslDebugActivity('nickname') in the console to inspect
    // BOTH the profile page and the activity feed, so we can see where the
    // avatar and any "last active" field actually live.
    const dbgTarget = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    dbgTarget.aslDebugActivity = async function(nickname) {
        const out = {};
        // 1) Profile page HTML
        const prof = await gmFetch('https://fetlife.com/' + nickname, { 'Accept': 'text/html' });
        out.profileStatus = prof.status;
        const html = prof.responseText || '';
        const cdnInHtml = (html.match(/https:\\?\/\\?\/pic[a-z0-9-]*\.cdn\.fetlife\.com[^"'\\ )]+/gi) || []).slice(0, 5);
        console.log('[ASL DEBUG] profile page status:', prof.status, 'len:', html.length);
        console.log('[ASL DEBUG] CDN urls in profile HTML:', cdnInHtml);
        // look for last-active-ish text
        const lastActiveHtml = html.match(/last[ _-]?(active|seen|logged)[^<>{}]{0,40}/gi);
        console.log('[ASL DEBUG] "last active" mentions in profile HTML:', lastActiveHtml ? lastActiveHtml.slice(0,5) : 'none');

        // 2) Probe every activity request shape and report which one works
        const base = 'https://fetlife.com/' + nickname;
        for (let i = 0; i < ACTIVITY_METHODS.length; i++) {
            const m = ACTIVITY_METHODS[i];
            const r = await gmFetch(base + m.suffix, m.headers);
            const isJson = (r.responseText || '').trim().startsWith('{');
            console.log('[ASL DEBUG] method', i, m.suffix, JSON.stringify(m.headers),
                        '→ status', r.status, '| json:', isJson, '| len:', (r.responseText || '').length);
            if (r.ok && isJson) {
                console.log('[ASL DEBUG] ✅ WORKING METHOD', i, '— first 1500 chars:\n', r.responseText.substring(0, 1500));
                out.workingMethod = i;
                break;
            }
            if (r.status === 406 && r.responseText) {
                console.log('[ASL DEBUG]    406 body:', r.responseText.substring(0, 200));
            }
        }
        if (out.workingMethod === undefined) console.log('[ASL DEBUG] ❌ No method returned JSON');
        return out;
    };

    // Derive the current nickname from a (possibly redirected) URL
    function nicknameFromUrl(url) {
        if (!url) return null;
        const m = url.replace(/[?#].*$/, '').replace(/\/activity\/?$/, '').match(/fetlife\.com\/([^\/]+)/i);
        return m ? m[1] : null;
    }

    // Pull the avatar straight from the profile page HTML. The activity feed
    // only carries an avatar when the person authored a recent story, so many
    // profiles come back empty there — the profile page always shows their pic.
    // Unescape a URL as it appears inside HTML or an embedded JSON blob.
    function cleanImgUrl(u) {
        return u.replace(/\\u0026/gi, '&').replace(/\\\//g, '/')
                .replace(/&amp;/g, '&').replace(/&#(?:38|x26);/gi, '&');
    }

    // Member pictures are served from the CDN hosts. Anything under
    // fetlife.com/assets/ is site furniture — the header logo, the default
    // "no picture" silhouette, the og:image share card. Taking those gives
    // every profile the same meaningless thumbnail, so they are never avatars.
    const FL_CDN_HOST = /^https?:\/\/[a-z0-9.-]*cdn\.fetlife\.com\//i;
    const FL_SITE_ASSET = /\/assets\/|\/packs\/|og-image|sprite|favicon|logo|default[-_]?(avatar|pic)|missing/i;

    function isMemberPicture(url) {
        return FL_CDN_HOST.test(url) && !FL_SITE_ASSET.test(url);
    }

    // One picture is stored once and served at several sizes, all sharing an
    // attachment id: .../attachments/177312342/a50.jpg, a160.jpg, a400.jpg.
    // Grouping by that id is what tells two people's photos apart on a page.
    function attachmentId(url) {
        const m = url.match(/\/attachments\/(\d+)\//);
        return m ? m[1] : null;
    }

    // Every FetLife page carries YOUR avatar in the site header, so it shows up
    // in every profile page fetched in the background — and it is the first
    // picture in the markup, which is how it ended up being saved onto other
    // people's profiles. A picture belongs to one person, so any attachment id
    // seen on a second person's page is site chrome, and is remembered as such.
    const CHROME_IDS_KEY = 'asl_chrome_pic_ids';
    const ID_OWNER_KEY = 'asl_pic_id_owner';

    function readJson(key, dflt) {
        try { return JSON.parse(localStorage.getItem(key)) || dflt; } catch(e) { return dflt; }
    }
    function writeJson(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
    }

    function learnChromeIds(nickname, ids) {
        const owner = readJson(ID_OWNER_KEY, {});
        const chrome = new Set(readJson(CHROME_IDS_KEY, []));
        let changed = false;
        for (const id of ids) {
            if (chrome.has(id)) continue;
            if (!owner[id]) { owner[id] = nickname; changed = true; }
            else if (owner[id] !== nickname) { chrome.add(id); delete owner[id]; changed = true; }
        }
        if (changed) { writeJson(ID_OWNER_KEY, owner); writeJson(CHROME_IDS_KEY, [...chrome]); }
        return chrome;
    }

    // Seed the chrome list straight from the page we are running on, so the
    // very first lookup is already right instead of learning after two fetches.
    function seedChromeFromHeader() {
        const scope = document.querySelector('header, nav, [role="banner"]');
        if (!scope) return;
        const chrome = new Set(readJson(CHROME_IDS_KEY, []));
        let changed = false;
        scope.querySelectorAll('img[src*="cdn.fetlife.com"]').forEach(img => {
            const id = attachmentId(img.src);
            if (id && !chrome.has(id)) { chrome.add(id); changed = true; }
        });
        if (changed) writeJson(CHROME_IDS_KEY, [...chrome]);
    }

    // Collect every plausible member picture in a page or feed, in the order
    // they appear. Nothing here trusts a single tag — FetLife's og:image is
    // their own logo, not the person's photo.
    function collectAvatarCandidates(html) {
        if (!html || typeof html !== 'string') return [];
        const raw = html.match(/https?:(?:\\\/\\\/|\/\/)[a-z0-9.-]*fetlife\.com\/[^"'\s\\)<>]+/gi) || [];
        const seen = new Set();
        const out = [];
        for (const r of raw) {
            const u = cleanImgUrl(r).replace(/[,;]+$/, '');
            if (seen.has(u) || !isMemberPicture(u)) continue;
            seen.add(u);
            out.push(u);
        }
        return out;
    }

    // Pick the picture that belongs to the person whose profile this is.
    function pickOwnerAvatar(html, nickname, trace) {
        const note = m => { if (trace) trace.push(m); };
        const cands = collectAvatarCandidates(html);
        if (!cands.length) return null;

        const order = [];
        const byId = new Map();
        for (const u of cands) {
            const id = attachmentId(u) || u;
            if (!byId.has(id)) { byId.set(id, []); order.push(id); }
            byId.get(id).push(u);
        }

        const chrome = learnChromeIds(nickname, order);
        let usable = order.filter(id => !chrome.has(id));

        // Until the header avatar has been identified, the safe reading is that
        // the first picture on the page is it — it sits in the header, above
        // the profile. Showing nothing beats showing the wrong person.
        if (usable.length === order.length && order.length > 1) {
            usable = usable.slice(1);
            note('Skipping the first picture (site header)');
        } else if (usable.length === order.length) {
            note('Only one picture on the page and it has not been ruled out as the header — skipping');
            return null;
        }
        if (!usable.length) {
            note('Every picture on the page was your own header avatar');
            return null;
        }

        // Within the person's own picture, prefer the size closest to how big
        // the results list draws it. a50 is a 2 KB thumbnail; a400 is oversized.
        const sizeOf = u => {
            const m = u.match(/\/a(\d{2,4})\.(?:jpe?g|png|webp|gif)/i)
                   || u.match(/[_-](\d{2,4})\.(?:jpe?g|png|webp|gif)/i);
            return m ? parseInt(m[1]) : 160;
        };
        const group = byId.get(usable[0]).slice()
            .sort((a, b) => Math.abs(sizeOf(a) - 160) - Math.abs(sizeOf(b) - 160));
        return group[0];
    }

    function avatarUrlFromProfileHtml(html, nickname, trace) {
        const note = m => { if (trace) trace.push(m); };
        const picked = pickOwnerAvatar(html, nickname, trace);
        if (picked) return picked;
        note('No member picture in the profile page HTML (only site graphics)');
        return null;
    }

    async function fetchAvatarFromProfile(profileUrl, trace, nickname) {
        const note = m => { if (trace) trace.push(m); };
        try {
            const resp = await gmFetch(profileUrl, { 'Accept': 'text/html' });
            note('Profile page: HTTP ' + resp.status + ', ' +
                 ((resp.responseText || '').length) + ' characters');
            if (!resp.ok || !resp.responseText) {
                console.log('[ASL] Profile page fetch failed:', resp.status, profileUrl);
                return null;
            }
            const url = avatarUrlFromProfileHtml(
                resp.responseText,
                nickname || profileUrl.replace(/\/+$/, '').split('/').pop(),
                trace);
            if (!url) {
                console.log('[ASL] No CDN image in profile page for', profileUrl);
                return null;
            }
            console.log('[ASL] Avatar from profile page:', url.substring(0, 70));
            note('Picture URL: ' + url.substring(0, 80));
            const b64 = await fetchImageAsBase64(url, trace);
            return b64 || url;
        } catch(e) {
            console.error('[ASL] fetchAvatarFromProfile error:', e);
            note('Profile page fetch threw: ' + e.message);
            return null;
        }
    }

    async function fetchActivityDate(profileUrl, wantAvatar) {
        try {
            const resp = await fetchActivityRaw(profileUrl);
            const canonical = nicknameFromUrl(resp.finalUrl);
            const origNick = profileUrl.replace(/\/+$/, '').split('/').pop();

            if (isLockedOut(resp)) {
                lockoutDetected = true;
                return { date: null, error: 'LOCKED', lockedOut: true, canonical: null };
            }

            if (!resp.ok) {
                console.log('[ASL] Activity fetch failed:', resp.status, profileUrl);
                return { date: null, error: resp.status, canonical };
            }

            let data = null;
            let latest = null;
            try { data = JSON.parse(resp.responseText); } catch(e) {
                // FetLife sometimes answers /activity with the rendered page
                // instead of JSON. Read the dates out of the markup, but keep
                // going so the avatar lookup below still runs.
                console.log('[ASL] Activity response not JSON, trying HTML parse for:', profileUrl);
                latest = parseActivityFromHtml(resp.responseText).date;
            }

            // Find the most recent created_at from any story in any story_group
            if (data && data.story_groups) {
                for (const group of data.story_groups) {
                    for (const story of (group.stories || [])) {
                        if (story.created_at) {
                            const d = new Date(story.created_at);
                            if (!isNaN(d.getTime()) && (!latest || d > latest)) {
                                latest = d;
                            }
                        }
                    }
                }
            }

            // If requested, extract the avatar from THIS SAME response (no extra request)
            let avatar;
            if (wantAvatar) {
                const matchNick = canonical || origNick;
                const url = data ? findAvatarForNickname(data, matchNick, 0) : null;
                if (url && isMemberPicture(url.replace(/\\\//g, '/'))) {
                    const cleanUrl = url.replace(/\\\//g, '/');
                    console.log('[ASL] Matched avatar for', matchNick, ':', cleanUrl.substring(0, 60));
                    const b64 = await fetchImageAsBase64(cleanUrl);
                    avatar = b64 || cleanUrl;
                } else {
                    // Not in the feed — fall back to the profile page, which
                    // always shows their avatar.
                    avatar = await fetchAvatarFromProfile(profileUrl, null, matchNick);
                }
            }
            return { date: latest, error: null, canonical, avatar };
        } catch (e) {
            console.error('[ASL] Activity fetch error:', e, profileUrl);
            return { date: null, error: e.message };
        }
    }

    function parseActivityFromHtml(html) {
        if (!html || typeof html !== 'string') return { date: null, error: null };
        // Fallback: try to find activity timestamps in HTML
        const timeMatches = html.match(/datetime="([^"]+)"/g);
        if (timeMatches && timeMatches.length > 0) {
            let latest = null;
            for (const m of timeMatches) {
                const dateStr = m.match(/datetime="([^"]+)"/)[1];
                const d = new Date(dateStr);
                if (!isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
            }
            return { date: latest, error: null };
        }
        return { date: null, error: null };
    }

    // Extract a CDN image URL, but ONLY from a value under an "avatar" key.
    // (Never grabs post images or other nested pictures.)
    function extractAvatarUrl(val, depth) {
        if (val == null || depth > 4) return null;
        if (typeof val === 'string') {
            return /pic[a-z0-9-]*\.cdn\.fetlife\.com/i.test(val) ? val : null;
        }
        if (typeof val === 'object') {
            // avatar objects often hold size variants — take any cdn url within
            for (const k in val) {
                const r = extractAvatarUrl(val[k], depth + 1);
                if (r) return r;
            }
        }
        return null;
    }

    // Walk the JSON to find the AVATAR field of the object whose nickname
    // matches the profile owner. Requires an actual avatar-named key.
    function findAvatarForNickname(obj, nickname, depth) {
        if (obj == null || depth > 8) return null;
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const r = findAvatarForNickname(item, nickname, depth + 1);
                if (r) return r;
            }
            return null;
        }
        if (typeof obj === 'object') {
            const nn = (obj.nickname || obj.username || obj.slug || '').toString().toLowerCase();
            if (nn && nn === nickname.toLowerCase()) {
                // Look for an avatar-named key on this owner object
                for (const k in obj) {
                    if (/avatar/i.test(k)) {
                        const url = extractAvatarUrl(obj[k], 0);
                        if (url) return url;
                    }
                }
            }
            for (const k in obj) {
                const r = findAvatarForNickname(obj[k], nickname, depth + 1);
                if (r) return r;
            }
        }
        return null;
    }

    async function fetchFreshAvatar(profileUrl) {
        try {
            // The /activity endpoint returns real JSON. It can contain OTHER
            // users' images (comments, friends' activity), so we must match the
            // avatar to the profile owner's nickname — never grab the first image.
            const nickname = profileUrl.replace(/\/+$/, '').split('/').pop();
            const activityUrl = profileUrl.replace(/\/?$/, '/activity');
            const resp = await gmFetch(activityUrl, { 'Accept': 'application/json' });
            // Detect username changes via the redirected URL
            const canonical = nicknameFromUrl(resp.finalUrl) || nickname;
            if (!resp.ok || !resp.responseText) return { avatar: null, canonical };

            let data;
            try { data = JSON.parse(resp.responseText); } catch(e) {
                console.log('[ASL] Activity JSON parse failed for', nickname);
                return { avatar: null, canonical };
            }

            // Match by canonical nickname (handles renames)
            const url = findAvatarForNickname(data, canonical, 0);
            if (!url) {
                console.log('[ASL] No avatar matched to', canonical, '— leaving existing pic');
                return { avatar: null, canonical };
            }
            const cleanUrl = url.replace(/\\\//g, '/');
            console.log('[ASL] Matched avatar for', canonical, ':', cleanUrl.substring(0, 60));
            const b64 = await fetchImageAsBase64(cleanUrl);
            return { avatar: b64 || cleanUrl, canonical };
        } catch(e) {
            console.error('[ASL] fetchFreshAvatar error:', e);
            return { avatar: null, canonical: null };
        }
    }

    // Get the current Active set (checked + active within threshold), optionally skipping pics
    async function getActiveSet(skipWithPics) {
        const activityDays = parseInt(document.getElementById('asl-activity').value) || 90;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - activityDays);
        const results = await dbGetAllResults();
        let active = results.filter(p => p.activityChecked && p.lastActivity && new Date(p.lastActivity) >= cutoff);
        if (skipWithPics) {
            const have = await dbGetAvatarKeys();
            active = active.filter(p => !have.has(p.nickname));
        }
        return active;
    }

    // Retry profiles whose activity check errored (e.g. 406/429/404).
    // These are marked "checked" so normal Check Activity skips them, and
    // they have no activity date so the Active tab can't reach them either.
    async function retryFailedChecks() {
        const results = await dbGetAllResults();
        const failed = results.filter(p => p.activityChecked && p.activityError && !p.gone && !p.restricted);

        if (failed.length === 0) {
            setStatus('No retryable failures. (Deleted 404s and private 401s are excluded — they cannot resolve.)');
            return;
        }

        console.log('[ASL] Retrying', failed.length, 'failed checks');
        for (const p of failed) {
            p.activityChecked = false;
            p.checkedAt = null;
            p.activityError = null;
        }
        await dbPutResults(failed);
        setStatus('Retrying ' + failed.length + ' failed activity checks (with photo refresh)...');
        await loadAndDisplayResults();
        // refreshAvatars = true: these profiles usually have stale pics too,
        // and we're already fetching their activity, so restore both at once.
        setTimeout(() => startActivityCheck(true, failed), 500);
    }

    // v8.13.0 trusted the og:image tag, which on FetLife is their own site logo
    // rather than the member's photo — so some profiles ended up holding an
    // identical picture. A real avatar is unique to one person, so any image
    // saved against several profiles is site furniture. Clear those.
    const PURGE_FLAG = 'asl_purged_shared_avatars_v2';
    async function purgeSharedAvatars() {
        try {
            if (localStorage.getItem(PURGE_FLAG)) return;
            const all = await dbGetAllResults();
            const counts = new Map();
            for (const p of all) {
                if (!p.avatar) continue;
                const k = p.avatar.length + '|' + p.avatar.slice(-64);
                counts.set(k, (counts.get(k) || 0) + 1);
            }
            const toClear = all.filter(p => {
                if (!p.avatar) return false;
                return counts.get(p.avatar.length + '|' + p.avatar.slice(-64)) >= 3;
            });
            if (toClear.length) {
                for (const p of toClear) p.avatar = '';
                await dbPutResults(toClear);
                console.log('[ASL] Cleared', toClear.length, 'duplicate (site graphic) avatars');
            }
            localStorage.setItem(PURGE_FLAG, '1');
        } catch(e) {
            console.error('[ASL] purgeSharedAvatars failed:', e);
        }
    }

    // Fetch one profile's picture, recording each step. Returns the picture
    // (base64 where the download succeeded, otherwise the bare URL) or null.
    //
    // This already asks for /activity to find the picture, so it reads the
    // dates out of the same response — refreshing when someone was last
    // active costs nothing extra here, and a stale date is as misleading as
    // a stale photo.
    async function photoPipeline(nickname, trace) {
        const note = m => { if (trace) trace.push(m); };
        const profileUrl = 'https://fetlife.com/' + nickname;
        let avatar = null;
        let sourceUrl = null;
        let lastActivity = null;
        let canonicalNick = null;
        let candidateCount = null;
        try {
            const resp = await fetchActivityRaw(profileUrl);
            note('Activity feed: HTTP ' + resp.status);
            if (isLockedOut(resp)) {
                note('FetLife has locked you out — stopping.');
                return { avatar: null, sourceUrl: null, lastActivity: null,
                         canonicalNick: null, lockedOut: true, candidateCount };
            }
            if (resp.ok) {
                let data = null;
                try { data = JSON.parse(resp.responseText); }
                catch(e) { note('Feed came back as a web page, not data (' + (resp.responseText || '').length + ' chars)'); }
                const canonical = nicknameFromUrl(resp.finalUrl) || nickname;
                canonicalNick = canonical;
                if (data && data.story_groups) {
                    for (const group of data.story_groups) {
                        for (const story of (group.stories || [])) {
                            if (!story.created_at) continue;
                            const d = new Date(story.created_at);
                            if (!isNaN(d.getTime()) && (!lastActivity || d > lastActivity)) lastActivity = d;
                        }
                    }
                } else if (!data) {
                    lastActivity = parseActivityFromHtml(resp.responseText).date;
                }
                if (lastActivity) note('Last active: ' + lastActivity.toDateString());
                const url = data ? findAvatarForNickname(data, canonical, 0) : null;
                if (url && isMemberPicture(url.replace(/\\\//g, '/'))) {
                    note('Feed has their picture');
                    sourceUrl = url.replace(/\\\//g, '/');
                    avatar = await fetchImageAsBase64(sourceUrl, trace) || null;
                } else {
                    note('Feed has no picture — trying the profile page');
                }
            }
            if (!avatar) {
                const pg = await gmFetch(profileUrl, { 'Accept': 'text/html' });
                note('Profile page: HTTP ' + pg.status + ', ' + ((pg.responseText || '').length) + ' chars');
                const cands = collectAvatarCandidates(pg.responseText || '');
                candidateCount = cands.length;
                note('Member pictures on that page: ' + cands.length);
                const chosen = pickOwnerAvatar(pg.responseText || '', nickname, trace);
                if (chosen) {
                    note('Using: ' + chosen.substring(0, 95));
                    sourceUrl = chosen;
                    avatar = await fetchImageAsBase64(chosen, trace) || chosen;
                }
            }
        } catch(e) {
            note('Error: ' + e.message);
        }
        return { avatar, sourceUrl, lastActivity, canonicalNick,
                 lockedOut: false, candidateCount };
    }

    async function recheckByAge() {
        const minAge = parseInt(document.getElementById('asl-recheck-amin').value) || 18;
        const maxAge = parseInt(document.getElementById('asl-recheck-amax').value) || 99;
        const skipWithPics = document.getElementById('asl-recheck-skip-pics').checked;
        let active = await getActiveSet(skipWithPics);
        const toReset = active.filter(p => p.age >= minAge && p.age <= maxAge);

        if (toReset.length === 0) {
            setStatus('No active profiles found in age range ' + minAge + '-' + maxAge + (skipWithPics ? ' (without a saved pic)' : ''));
            return;
        }

        for (const p of toReset) { p.activityChecked = false; p.checkedAt = null; }
        await dbPutResults(toReset);
        setStatus('Re-checking ' + toReset.length + ' active profiles (age ' + minAge + '-' + maxAge + ') with avatar refresh...');
        await loadAndDisplayResults();
        setTimeout(() => startActivityCheck(true, toReset), 500);
    }

    async function recheckLastN() {
        let from = parseInt(document.getElementById('asl-recheck-from').value) || 1;
        let to = parseInt(document.getElementById('asl-recheck-to').value) || 500;
        if (from > to) { const t = from; from = to; to = t; }
        const skipWithPics = document.getElementById('asl-recheck-skip-pics').checked;
        let active = await getActiveSet(skipWithPics);
        // Order to match the Active tab's current sort
        const activeSort = (document.getElementById('asl-active-sort') || {}).value || 'activity';
        active = sortProfiles(active, activeSort);
        const toReset = active.slice(from - 1, to);
        console.log('[ASL] Re-check range #' + from + '-' + to + ' (sort=' + activeSort + ', skipPics=' + skipWithPics + '):', toReset.map(p => p.nickname));

        if (toReset.length === 0) {
            setStatus('No active profiles in range ' + from + '-' + to + ' (only ' + active.length + ' active' + (skipWithPics ? ' without a pic' : '') + ').');
            return;
        }

        for (const p of toReset) { p.activityChecked = false; p.checkedAt = null; }
        await dbPutResults(toReset);
        setStatus('Re-checking active profiles #' + from + '-' + to + ' (' + toReset.length + ') with avatar refresh...');
        await loadAndDisplayResults();
        setTimeout(() => startActivityCheck(true, toReset), 500);
    }

    async function startActivityCheck(refreshAvatars, explicitProfiles) {
        const results = await dbGetAllResults();
        if (results.length === 0) {
            setStatus('No results to check activity for.');
            return;
        }

        const activityDays = parseInt(document.getElementById('asl-activity').value) || 90;
        if (activityDays === 0) {
            setStatus('Activity filter set to "Any" — nothing to check.');
            return;
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - activityDays);

        let unchecked;
        if (explicitProfiles && explicitProfiles.length) {
            // Re-check exactly the profiles passed in (nothing else)
            unchecked = explicitProfiles;
        } else {
            const allUnchecked = results.filter(p => !p.activityChecked);
            if (allUnchecked.length === 0) {
                setStatus('All profiles already checked. Filtering...');
                await loadAndDisplayResults();
                return;
            }
            const checkLimit = parseInt(document.getElementById('asl-check-limit').value) || 100;
            unchecked = allUnchecked.slice(-checkLimit);
        }

        activityCheckAbort = false;
        lockoutDetected = false;
        lastCheckBatchTime = Date.now();
        localStorage.setItem('asl_last_check_batch', String(lastCheckBatchTime));

        const progressEl = document.getElementById('asl-activity-progress');
        const checkBtn = document.getElementById('asl-check-activity');
        const stopBtn = document.getElementById('asl-stop-activity');
        checkBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        progressEl.style.display = 'block';

        const total = unchecked.length;
        let checked = 0;
        let active = 0;
        let inactive = 0;
        let errors = 0;

        // The photo filler steps aside while this runs, so the two never make
        // requests at the same time.
        activityCheckRunning = true;
        try {
        for (const p of unchecked) {
            if (activityCheckAbort) {
                console.log('[ASL] Activity check stopped by user.');
                break;
            }

            checked++;
            progressEl.innerHTML = `
                Checking activity: <strong>${checked}</strong> / ${total}
                &nbsp;—&nbsp; <span style="color:#6c6">${active} active</span>
                &nbsp;/&nbsp; <span style="color:#c66">${inactive} inactive</span>
                ${errors > 0 ? '&nbsp;/&nbsp; <span style="color:#cc6">' + errors + ' errors</span>' : ''}
                &nbsp;— ${esc(p.nickname)}
                <div class="bar"><div class="fill" style="width:${Math.round(checked/total*100)}%"></div></div>
            `;

            // One request to /activity gives both the date and (in refresh mode)
            // the avatar — avoids the redundant second call that caused rate-limit errors.
            const result = await fetchActivityDate(p.url, refreshAvatars);

            // Hard stop if FetLife locked the account — continuing makes it worse
            if (result.lockedOut || lockoutDetected) {
                lockoutDetected = true;
                activityCheckAbort = true;
                progressEl.innerHTML = '<strong style="color:#f66">⛔ STOPPED — FetLife temporarily locked your account.</strong><br>' +
                    'Wait until the lockout expires, then increase the delay before running again. ' +
                    'Checked ' + (checked - 1) + ' of ' + total + ' before stopping.';
                setStatus('Stopped: FetLife lockout detected. Wait it out, then slow the delay down.');
                console.warn('[ASL] LOCKOUT DETECTED — aborting run at profile', p.nickname);
                break;
            }

            if (refreshAvatars) {
                // Only replace the photo when we actually found one. Clearing on
                // a miss would wipe working pics; dead URLs are already detected
                // and cleared when they fail to render.
                if (!result.error && result.avatar) p.avatar = result.avatar;
            }

            // Handle username changes: if the profile redirected to a new
            // nickname, migrate the record to the new key.
            const canonical = result && result.canonical;
            if (canonical && canonical.toLowerCase() !== p.nickname.toLowerCase()) {
                console.log('[ASL] Username change:', p.nickname, '→', canonical);
                await dbRenameAvatar(p.nickname, canonical);
                await dbDelete(p.nickname);
                p.nickname = canonical;
                p.url = 'https://fetlife.com/' + canonical;
            }

            p.activityChecked = true;
            p.checkedAt = Date.now();
            if (result.error) {
                // A failed request tells us nothing about whether they're active.
                // Keep the existing lastActivity instead of wiping it — clearing
                // it silently drops the profile out of the Active tab.
                p.activityError = result.error;
                // Permanent per-profile conditions — retrying can never help:
                //  404 = account deleted or renamed away
                //  401/403 = activity feed is private/restricted to us
                if (result.error === 404) p.gone = true;
                if (result.error === 401 || result.error === 403) p.restricted = true;
                errors++;
                if (result.error === 429 || result.error === 503) {
                    console.log('[ASL] Rate limited, waiting 30s...');
                    progressEl.innerHTML += '<br><span style="color:#cc6">Rate limited — waiting 30 seconds...</span>';
                    await sleep(30000);
                }
            } else if (result.date) {
                // Successful check — clear any stale error flag
                p.activityError = null;
                p.gone = false;
                p.restricted = false;
                p.lastActivity = result.date.toISOString();
                if (result.date >= cutoffDate) {
                    active++;
                } else {
                    inactive++;
                }
            } else {
                // Successful response, but the feed had no activity at all
                p.activityError = null;
                p.gone = false;
                p.restricted = false;
                p.lastActivity = null;
                inactive++;
            }

            // Save after each check so progress isn't lost
            await dbPutResults([p]);

            if (checked < total && !activityCheckAbort) {
                const minS = parseFloat((document.getElementById('asl-act-min') || {}).value) || 3;
                const maxS = parseFloat((document.getElementById('asl-act-max') || {}).value) || 6;
                const delay = randomDelay(minS * 1000, Math.max(maxS, minS) * 1000);
                console.log('[ASL] Next activity check in', Math.round(delay/1000), 'seconds');
                await sleep(delay);
            }
        }

        } finally {
            activityCheckRunning = false;
            startPhotoWorker();
        }

        stopBtn.style.display = 'none';
        const remaining = unchecked.length - checked;
        const msg = activityCheckAbort
            ? `Activity check paused — ${checked}/${total} checked. ${active} active, ${inactive} inactive.${remaining > 0 ? ' ' + remaining + ' remaining in batch.' : ''}`
            : `Activity check complete! ${active} active, ${inactive} inactive out of ${total} checked.`;
        progressEl.innerHTML = `<strong>${msg}</strong>`;
        setStatus(msg);
        // Show the freshly-active profiles in the Active tab
        await loadAndDisplayResults();
        document.querySelector('#asl-tabs button[data-t="active"]')?.click();
    }

    // Re-run the whole job - activity AND photo - over one search. The other
    // check buttons cannot reach this: "Check Activity" only takes profiles
    // never checked, and the two re-check buttons on the Active tab only see
    // profiles that are already active. A search whose photos and dates went
    // wrong had no way back into the pipeline before this.
    //
    // It names its scope in its own label, so scoping it to the dropdown is
    // not the trap the whole-set rule guards against: nothing here is
    // ambiguous about which profiles it will touch.
    function estimateMinutes(count) {
        const el = id => (document.getElementById(id) || {}).value;
        const avg = ((parseFloat(el('asl-act-min')) || 3) + (parseFloat(el('asl-act-max')) || 6)) / 2;
        // A profile costs one request, or two when the photo is not in the
        // feed and the profile page has to be read as well.
        const lo = Math.round(count * avg / 60);
        const hi = Math.round(count * avg * 2 / 60);
        const fmt = m => m >= 90 ? (m / 60).toFixed(1) + ' hours' : Math.max(1, m) + ' minutes';
        return lo === hi ? fmt(lo) : fmt(lo) + ' to ' + fmt(hi);
    }

    async function recheckSelectedSearch() {
        const sel = ((document.getElementById('asl-batch') || {}).value) || 'all';
        if (sel === 'all') return;
        const label = sel === '0' ? 'the earlier results' : 'Search ' + sel;
        const skip = !!(document.getElementById('asl-recheck-batch-skip') || {}).checked;

        const all = await dbGetAllResults();
        // Deleted and private profiles are never re-requested: they cannot
        // resolve, and asking again only spends requests.
        let list = all.filter(p => String(p.batch || 0) === sel && !isDeadEnd(p));
        const total = list.length;
        if (skip) {
            const have = await dbGetAvatarKeys();
            const freshAfter = Date.now() - STALE_ACTIVITY_MS;
            list = list.filter(p => !(have.has(p.nickname) && p.activityChecked && p.checkedAt &&
                                      new Date(p.checkedAt).getTime() >= freshAfter));
        }
        if (!list.length) {
            alert(total
                ? 'Nothing to do in ' + label + ' - all ' + total +
                  ' profiles already have a photo and a recent check.\n\n' +
                  'Untick the skip box to force all of them through again.'
                : 'There are no profiles in ' + label + ' to check.');
            return;
        }
        const ok = confirm(
            'Re-check ' + list.length + ' profile' + (list.length === 1 ? '' : 's') +
            ' in ' + label + '?\n\n' +
            'This fetches their latest activity AND their photo, so they land in the ' +
            'Active tab properly.\n\n' +
            'At your current delay this takes roughly ' + estimateMinutes(list.length) + '. ' +
            'You can stop it at any time, and running it again picks up where it left off.'
        );
        if (!ok) return;
        startActivityCheck(true, list);
    }

    // =====================
    // PARSE MEMBER CARD
    // =====================
    function parseCard(card) {
        try {
            const nickname = card.getAttribute('data-member-card');
            if (!nickname) return null;

            const rawText = card.textContent.replace(/\s+/g, ' ').trim();
            const img = card.querySelector('img');
            let avatar = '';
            if (img) {
                // Try multiple sources — FetLife may use lazy loading
                avatar = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('src') || '';
                // An empty src resolves to the page's own URL. Only a real
                // member picture is worth keeping, and refusing it here means
                // a bad one is never stored even as a fallback.
                if (avatar && !isMemberPicture(avatar)) avatar = '';
            }

            let infoText = rawText;
            if (rawText.toLowerCase().startsWith(nickname.toLowerCase())) {
                infoText = rawText.substring(nickname.length).trim();
            }
            const nickIdx = rawText.indexOf(nickname);
            if (nickIdx >= 0) {
                infoText = rawText.substring(nickIdx + nickname.length).trim();
            }

            const asl = parseASL(infoText);

            let location = '';
            const placeLinks = card.querySelectorAll('a[href*="/p/"]');
            if (placeLinks.length > 0) {
                const parts = [];
                placeLinks.forEach(a => {
                    const t = a.textContent.trim();
                    if (t && !parts.includes(t)) parts.push(t);
                });
                location = parts.join(', ');
            }
            if (!location) {
                const locMatch = rawText.match(/([A-Z][a-zA-Z\s]+),\s*([A-Z][a-zA-Z\s]+)/);
                if (locMatch) location = locMatch[0];
            }

            return {
                nickname, age: asl.age, gender: asl.gender, genderCode: asl.genderCode,
                role: asl.role, location, avatar, url: 'https://fetlife.com/' + nickname,
            };
        } catch (e) {
            console.error('[ASL] parseCard error:', e);
            return null;
        }
    }

    function parseASL(text) {
        let age = null, gender = '', genderCode = '', role = '';

        const genderCodes = ['CD/TV','DemiG','Andro','TwoS','Masc','FEM','FtM','MtF','GNC','Cis','DW','Db','Dg','BG','GF','GN','GQ','NB','PG','QG','TG','TM','TW','UoG','IS','AG','TS','TV','W','M','F','B'];
        const gcPattern = genderCodes.map(g => g.replace('/', '\\/')).join('|');

        const agMatch = text.match(new RegExp('^(\\d{2,3})(' + gcPattern + ')\\s+', 'i'));

        if (agMatch) {
            age = parseInt(agMatch[1]);
            genderCode = agMatch[2].toUpperCase();
            gender = GENDER_LABELS[genderCode] || genderCode;

            const rest = text.substring(agMatch[0].length);
            const roleMatch = rest.match(/^(.+?)(?=\s*[A-Z][a-z]+,\s*[A-Z]|\s*\d+\s*Pics|\s*\d+\s*Vids|\s*Follow)/);
            if (roleMatch) {
                role = roleMatch[1].replace(/[^\x20-\x7E]/g, '').trim();
            }
        } else {
            const ageOnly = text.match(/^(\d{2,3})\s+(.+?)(?=\s*[A-Z][a-z]+,\s*[A-Z]|\s*\d+\s*Pics|\s*Follow)/);
            if (ageOnly) {
                const n = parseInt(ageOnly[1]);
                if (n >= 18 && n <= 200) {
                    age = n;
                    role = ageOnly[2].replace(/[^\x20-\x7E]/g, '').trim();
                }
            } else {
                const justAge = text.match(/^(\d{2,3})/);
                if (justAge) {
                    const n = parseInt(justAge[1]);
                    if (n >= 18 && n <= 200) age = n;
                }
            }
        }

        if (!role) {
            for (const r of ROLES) {
                if (text.includes(r)) { role = r; break; }
            }
        }

        return { age, gender, genderCode, role };
    }

    // =====================
    // MATCHING
    // =====================
    function matchesFilter(p, params) {
        if (p.age === null) return false;
        if (p.age < params.ageMin || p.age > params.ageMax) return false;

        if (params.genders.length > 0 && params.genders.length < GENDERS.length) {
            if (!p.genderCode) return false;
            if (!params.genders.includes(p.genderCode)) return false;
        }

        if (params.roleFilterEnabled && params.roles.length > 0 && params.roles.length < ROLES.length) {
            if (!p.role) return false;
            const r = p.role.toLowerCase();
            const match = params.roles.some(sr => {
                const s = sr.toLowerCase();
                return r === s || r.includes(s) || s.includes(r);
            });
            if (!match) return false;
        }

        if (params.locFilter && !(p.location || '').toLowerCase().includes(params.locFilter)) return false;

        return true;
    }

    // =====================
    // DISPLAY RESULTS
    // =====================
    function makePlaceholder() {
        const div = document.createElement('div');
        Object.assign(div.style, {width:'110px',height:'110px',borderRadius:'8px',background:'#333',display:'flex',alignItems:'center',justifyContent:'center',color:'#666',fontSize:'24px',flexShrink:'0'});
        div.textContent = '?';
        return div;
    }

    function sortProfiles(list, sortMode) {
        const sorted = [...list];
        if (sortMode === 'newest') {
            sorted.sort((a, b) => {
                const batchDiff = (b.batch || 0) - (a.batch || 0);
                if (batchDiff !== 0) return batchDiff;
                return (b.foundAt || 0) - (a.foundAt || 0);
            });
        } else if (sortMode === 'age-asc') {
            sorted.sort((a, b) => (a.age || 999) - (b.age || 999));
        } else if (sortMode === 'age-desc') {
            sorted.sort((a, b) => (b.age || 0) - (a.age || 0));
        } else if (sortMode === 'checked') {
            sorted.sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0));
        } else { // 'activity'
            sorted.sort((a, b) => {
                const da = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
                const db = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
                return db - da;
            });
        }
        return sorted;
    }

    // Deleted (404) and private (401/403) profiles are permanent dead ends.
    // They stay in the database - nothing is thrown away unasked - but they are
    // kept out of both lists unless the user asks for them, so a review list
    // is people who can actually be reviewed.
    function isDeadEnd(p) {
        return !!(p.gone || p.restricted);
    }

    // One entry per search run, newest first. There is no stored batch
    // timestamp, so the date is the earliest thing that search found.
    function batchSummaries(list) {
        const map = new Map();
        for (const p of list) {
            const key = p.batch || 0;
            let b = map.get(key);
            if (!b) { b = { batch: key, count: 0, first: Infinity, pages: '' }; map.set(key, b); }
            b.count++;
            if (p.foundAt && p.foundAt < b.first) b.first = p.foundAt;
            if (!b.pages && p.batchPages) b.pages = p.batchPages;
        }
        return [...map.values()].sort((a, b) => b.batch - a.batch);
    }

    function batchLabel(b) {
        if (!b.batch) return 'Earlier results (' + b.count + ')';
        let when = '';
        if (b.first !== Infinity) {
            const d = new Date(b.first);
            const opts = { month: 'short', day: 'numeric' };
            if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
            when = ' \u00b7 ' + d.toLocaleDateString('en-US', opts);
        }
        return 'Search ' + b.batch + when + ' (' + b.count + ')';
    }

    // Rebuild a search dropdown only when the searches behind it have actually
    // changed, so a redraw never yanks the list out from under an open select.
    // The chosen search survives the redraw; if it no longer has anything in
    // this list, the view falls back to All rather than showing nothing.
    function syncBatchOptions(selectId, summaries) {
        const sel = document.getElementById(selectId);
        if (!sel) return 'all';
        const sig = summaries.map(b => b.batch + ':' + b.count).join('|');
        if (sel.dataset.sig !== sig) {
            const want = sel.value || 'all';
            sel.innerHTML = '';
            const all = document.createElement('option');
            all.value = 'all';
            all.textContent = 'All searches';
            sel.appendChild(all);
            for (const b of summaries) {
                const o = document.createElement('option');
                o.value = String(b.batch);
                o.textContent = batchLabel(b);
                sel.appendChild(o);
            }
            sel.dataset.sig = sig;
            sel.value = [...sel.options].some(o => o.value === want) ? want : 'all';
        }
        return sel.value || 'all';
    }

    // When a stored avatar URL fails to load it has expired. Clear it (batched)
    // so the "missing photos" count reflects what's actually broken.
    const brokenAvatarQueue = new Set();
    let brokenFlushTimer = null;
    function markAvatarBroken(nickname) {
        brokenAvatarQueue.add(nickname);
        if (brokenFlushTimer) clearTimeout(brokenFlushTimer);
        brokenFlushTimer = setTimeout(async () => {
            const names = [...brokenAvatarQueue];
            brokenAvatarQueue.clear();
            brokenFlushTimer = null;
            try {
                await dbDeleteAvatars(names);
                console.log('[ASL] Cleared', names.length, 'dead avatar URLs');
            } catch(e) { console.error('[ASL] markAvatarBroken failed:', e); }
        }, 1500);
    }

    // =====================
    // AUTOMATIC PHOTO FILLING
    // =====================
    // Photos fill themselves in for whatever is on screen. There is nothing to
    // click and nothing to know: a card drawn without a picture puts itself in
    // a queue, and the queue is worked through slowly in the background.

    // The rule that keeps the wrong face off a profile: a picture belongs to
    // one person. FetLife draws YOUR avatar in the header of every page, so it
    // appears on everyone's profile — and if an attachment ever gets offered
    // for a second person, it is chrome, and refused from then on.
    async function saveAvatar(nickname, avatar, sourceUrl) {
        const id = sourceUrl ? attachmentId(sourceUrl) : null;
        if (id) {
            const owner = readJson(ID_OWNER_KEY, {});
            if (owner[id] && owner[id] !== nickname) {
                const chrome = new Set(readJson(CHROME_IDS_KEY, []));
                chrome.add(id);
                writeJson(CHROME_IDS_KEY, [...chrome]);
                console.log('[ASL] Refused shared picture', id, 'for', nickname);
                return false;
            }
            owner[id] = nickname;
            writeJson(ID_OWNER_KEY, owner);
        }
        const rec = await dbGetResult(nickname);
        if (!rec) return false;
        rec.avatar = avatar;
        await dbPutResults([rec]);
        return true;
    }

    const photoQueue = [];
    const photoQueued = new Set();
    let photoWorkerRunning = false;
    let activityCheckRunning = false;

    // A profile whose picture could not be found is not retried for a week.
    // Without this, every redraw re-queues the same hopeless profiles and the
    // queue never drains.
    const PHOTO_RETRY_MS = 7 * 86400000;
    // How old an activity date may get before a visible card refreshes it.
    // Profiles never checked at all are left to the Check Activity button,
    // which is the deliberate, interruptible job with its own progress bar.
    const STALE_ACTIVITY_MS = 14 * 86400000;
    // However a refresh turns out, don't attempt the same profile again for a
    // day. Otherwise a profile that cannot be refreshed re-queues on every
    // redraw and the worker never gets past it.
    const REFRESH_COOLDOWN_MS = 86400000;

    function queuePhoto(nickname, placeholder, lastTried, card, activityDays) {
        if (!nickname || photoQueued.has(nickname)) return;
        if (lastTried && Date.now() - new Date(lastTried).getTime() < PHOTO_RETRY_MS) {
            if (placeholder) placeholder.title = 'No photo found for this profile';
            return;
        }
        photoQueued.add(nickname);
        photoQueue.push({ nickname, placeholder, card, activityDays });
        setPlaceholderState(placeholder, 'waiting');
        updatePhotoStatus();
        startPhotoWorker();
    }

    // The background refresh only ever works on what is drawn on screen, so
    // narrowing the list to one search is also what points the worker at that
    // search. Jobs left over from the previous view are re-pointed at the
    // redrawn card when the same person is still listed, and dropped when they
    // are not - otherwise the worker spends its requests on profiles nobody
    // is looking at any more.
    function prunePhotoQueue(liveCards) {
        if (!photoQueue.length) return;
        let dropped = 0;
        for (let i = photoQueue.length - 1; i >= 0; i--) {
            const job = photoQueue[i];
            if (job.card && job.card.isConnected) continue;
            const fresh = liveCards.get(job.nickname);
            if (fresh) {
                job.card = fresh;
                job.placeholder = fresh.querySelector('a.av > div');
                setPlaceholderState(job.placeholder, 'waiting');
            } else {
                photoQueue.splice(i, 1);
                photoQueued.delete(job.nickname);
                dropped++;
            }
        }
        if (dropped) updatePhotoStatus();
    }

    // The card itself says where it is up to, so "which ones are loading?" is
    // answerable by looking at the list rather than inferring it.
    function setPlaceholderState(el, state) {
        if (!el || el.tagName === 'IMG') return;
        if (state === 'waiting') {
            el.textContent = '\u22ef';
            el.style.color = '#667';
            el.title = 'Waiting to load photo';
        } else if (state === 'loading') {
            el.textContent = '\u25cf';
            el.style.color = '#6bf';
            el.title = 'Loading photo now';
        } else {
            el.textContent = '?';
            el.style.color = '#666';
            el.title = 'No photo found for this profile';
        }
    }

    function photoDelay() {
        const el = id => (document.getElementById(id) || {}).value;
        const min = (parseFloat(el('asl-act-min')) || 3) * 1000;
        const max = (parseFloat(el('asl-act-max')) || 6) * 1000;
        return randomDelay(min, Math.max(max, min + 1));
    }

    async function startPhotoWorker() {
        if (photoWorkerRunning) return;
        photoWorkerRunning = true;
        try {
            while (photoQueue.length && !lockoutDetected) {
                // The activity check is the job the user actually asked for.
                // Never make requests alongside it.
                if (activityCheckRunning) { updatePhotoStatus(); await sleep(5000); continue; }
                const job = photoQueue.shift();
                photoQueued.delete(job.nickname);
                // Skip anything scrolled or filtered off the list since queuing.
                if (job.placeholder && !job.placeholder.isConnected) { updatePhotoStatus(); continue; }
                setPlaceholderState(job.placeholder, 'loading');
                updatePhotoStatus();
                let res = null;
                try { res = await photoPipeline(job.nickname, null); }
                catch(e) { console.error('[ASL] photo fill failed for', job.nickname, e); }
                if (res && res.lockedOut) { lockoutDetected = true; break; }
                if (res && res.lastActivity) await saveActivity(job.nickname, res.lastActivity);
                let saved = false;
                if (res && res.avatar) {
                    saved = await saveAvatar(job.nickname, res.avatar, res.sourceUrl);
                }
                if (!saved) {
                    setPlaceholderState(job.placeholder, 'none');
                    await markPhotoTried(job.nickname);
                }
                await stampRefreshed(job.nickname);
                // Redraw the card from the stored record so the picture AND the
                // refreshed "last active" line are both current.
                if (job.card && job.card.isConnected) {
                    const fresh = await dbGetResult(job.nickname);
                    const pic = await dbGetAvatar(job.nickname);
                    if (fresh) job.card.replaceWith(buildProfileCard(fresh, job.activityDays, pic));
                } else if (saved && job.placeholder && job.placeholder.isConnected) {
                    job.placeholder.replaceWith(makeAvatarImg(job.nickname, res.avatar));
                }
                updatePhotoStatus();
                if (photoQueue.length) await sleep(photoDelay());
            }
        } finally {
            photoWorkerRunning = false;
            updatePhotoStatus();
        }
    }

    // Record a freshly-read activity date from the same request the photo
    // came out of, so the list's "last active" does not drift out of date
    // while the photos are being brought up to date.
    async function saveActivity(nickname, date) {
        try {
            const rec = await dbGetResult(nickname);
            if (!rec) return;
            const known = rec.lastActivity ? new Date(rec.lastActivity) : null;
            if (known && known >= date) return;
            rec.lastActivity = date.toISOString();
            rec.activityChecked = true;
            rec.checkedAt = new Date().toISOString();
            rec.activityError = null;
            await dbPutResults([rec]);
        } catch(e) { console.error('[ASL] saveActivity failed:', e); }
    }

    async function stampRefreshed(nickname) {
        try {
            const rec = await dbGetResult(nickname);
            if (!rec) return;
            rec.refreshTried = new Date().toISOString();
            await dbPutResults([rec]);
        } catch(e) { console.error('[ASL] stampRefreshed failed:', e); }
    }

    async function markPhotoTried(nickname) {
        try {
            const rec = await dbGetResult(nickname);
            if (!rec) return;
            rec.photoTried = new Date().toISOString();
            await dbPutResults([rec]);
        } catch(e) { console.error('[ASL] markPhotoTried failed:', e); }
    }

    function updatePhotoStatus() {
        const el = document.getElementById('asl-photo-status');
        if (!el) return;
        const left = photoQueue.length + (photoWorkerRunning ? 1 : 0);
        if (lockoutDetected) {
            el.textContent = 'Photo loading stopped — FetLife locked you out.';
        } else if (activityCheckRunning && left) {
            el.textContent = 'Background refresh paused until the activity check finishes — ' +
                left + ' waiting.';
        } else if (left) {
            el.textContent = 'Refreshing photos & activity… ' + left +
                ' to go. The blue dot is the one loading now.';
        } else {
            el.textContent = '';
        }
    }

    function makeAvatarImg(nickname, src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', function() {
            const ph = makePlaceholder();
            this.replaceWith(ph);
            // The stored link has expired. Drop it and let the filler redo it.
            markAvatarBroken(nickname);
            queuePhoto(nickname, ph);  // an expired link always deserves a retry
        });
        return img;
    }

    function buildProfileCard(p, activityDays, avatar) {
        const d = document.createElement('div');
        d.className = 'asl-r';
        d.dataset.nick = p.nickname;
        // Pictures are looked up for the cards being drawn and handed in. A
        // record written before the split still carries its own, so read both
        // and a half-moved library still draws every face it has.
        const pic = avatar || p.avatar || '';
        const avLink = document.createElement('a');
        avLink.className = 'av';
        avLink.href = p.url;
        avLink.target = '_blank';
        let ph = null;
        if (pic) {
            avLink.appendChild(makeAvatarImg(p.nickname, pic));
        } else {
            // No picture yet — show a placeholder and have the background
            // filler replace it in place once it has one.
            ph = makePlaceholder();
            avLink.appendChild(ph);
        }
        // Refresh anything missing a picture, and anything whose activity date
        // has gone stale. One request answers both, so a card that needs either
        // gets brought fully up to date.
        const staleAfter = Date.now() - STALE_ACTIVITY_MS;
        const stale = p.activityChecked && p.checkedAt &&
                      new Date(p.checkedAt).getTime() < staleAfter;
        const cooling = p.refreshTried &&
            Date.now() - new Date(p.refreshTried).getTime() < REFRESH_COOLDOWN_MS;
        if ((!pic || stale) && !cooling) {
            queuePhoto(p.nickname, ph, pic ? null : p.photoTried, d, activityDays);
        }
        const meta = [p.age||'', p.gender||'', p.role||''].filter(Boolean).join(' / ');
        let activityLine = '';
        if (p.activityChecked) {
            if (p.lastActivity) {
                const dd = new Date(p.lastActivity);
                const dateStr = dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const daysAgo = Math.floor((Date.now() - dd.getTime()) / 86400000);
                const isRecent = daysAgo <= (activityDays || 90);
                activityLine = `<div class="m ${isRecent ? 'active' : 'inactive'}">Last active: ${dateStr} (${daysAgo}d ago)</div>`;
            } else if (p.activityError) {
                const label = p.gone ? 'Account deleted or renamed (404)'
                            : p.restricted ? 'Activity is private (' + p.activityError + ')'
                            : 'Activity check failed (' + p.activityError + ')';
                activityLine = `<div class="m inactive">${label}</div>`;
            } else {
                activityLine = `<div class="m inactive">No activity found</div>`;
            }
        }
        d.appendChild(avLink);
        const infoHtml = `<div class="i"><a href="${esc(p.url)}" target="_blank">${esc(p.nickname)}</a>${meta?`<div class="m">${esc(meta)}</div>`:''}${p.location?`<div class="m">${esc(p.location)}</div>`:''}${activityLine}</div><div class="act"><a href="${esc(p.url)}" target="_blank">Profile</a><a href="https://fetlife.com/conversations/new?with=${esc(p.nickname)}" target="_blank">Message</a></div>`;
        d.insertAdjacentHTML('beforeend', infoHtml);
        return d;
    }

    async function renderProfileList(containerId, profiles, sortMode, activityDays, showBatchDividers) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        const sorted = sortProfiles(profiles, sortMode);
        const PAGE_SIZE = 50;
        const loadMoreId = containerId + '-more';
        let shown = 0;

        async function renderBatch() {
            const batch = sorted.slice(shown, shown + PAGE_SIZE);
            // Claim this page before awaiting, so a double-click on Load More
            // cannot draw the same fifty profiles twice.
            const from = shown;
            shown += batch.length;
            const pics = await dbGetAvatars(batch.map(p => p.nickname));
            let currentBatch = from > 0 ? (sorted[from - 1] || {}).batch : null;
            for (const p of batch) {
                if (showBatchDividers && sortMode === 'newest' && p.batch && p.batch !== currentBatch) {
                    currentBatch = p.batch;
                    const divider = document.createElement('div');
                    divider.className = 'asl-batch-divider';
                    divider.textContent = '— Search ' + p.batch + ' (pages ' + (p.batchPages || '?') + ') —';
                    container.appendChild(divider);
                }
                container.appendChild(buildProfileCard(p, activityDays, pics.get(p.nickname)));
            }
            const oldBtn = document.getElementById(loadMoreId);
            if (oldBtn) oldBtn.remove();
            if (shown < sorted.length) {
                const btn = document.createElement('button');
                btn.id = loadMoreId;
                btn.className = 'asl-b';
                btn.style.background = '#47a';
                btn.style.color = '#fff';
                btn.textContent = 'Load More (' + (sorted.length - shown) + ' remaining)';
                btn.addEventListener('click', () => { renderBatch(); });
                container.appendChild(btn);
            }
        }
        await renderBatch();
    }

    async function loadAndDisplayResults() {
        const results = await dbGetAllResults();
        const activityDays = parseInt(document.getElementById('asl-activity').value) || 90;
        const total = results.length;
        const checkedCount = results.filter(p => p.activityChecked).length;
        const uncheckedCount = total - checkedCount;

        // Active = checked, has a lastActivity within the threshold
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - activityDays);
        const active = results.filter(p => p.activityChecked && p.lastActivity && new Date(p.lastActivity) >= cutoff);

        // Counters
        // The Search dropdown and the Find box narrow each list, and dead-end
        // profiles are kept out of it. None of that touches the buttons below,
        // which still act on the whole set — a narrowed view must never make a
        // bulk action hit the wrong profiles.
        const findVal = id => ((document.getElementById(id) || {}).value || '').trim().toLowerCase();
        const byName = (list, q) => q ? list.filter(p => (p.nickname || '').toLowerCase().includes(q)) : list;
        const byBatch = (list, sel) => sel === 'all' ? list : list.filter(p => String(p.batch || 0) === sel);
        const rq = findVal('asl-find');
        const aq = findVal('asl-active-find');

        const showDeadR = !!(document.getElementById('asl-show-hidden') || {}).checked;
        const showDeadA = !!(document.getElementById('asl-active-show-hidden') || {}).checked;
        const deadResults = results.filter(isDeadEnd).length;
        const deadActive = active.filter(isDeadEnd).length;
        const resultsPool = showDeadR ? results : results.filter(p => !isDeadEnd(p));
        const activePool = showDeadA ? active : active.filter(p => !isDeadEnd(p));

        // Each dropdown counts its own list, so the number beside a search is
        // what selecting it will actually show.
        const rBatch = syncBatchOptions('asl-batch', batchSummaries(resultsPool));
        const aBatch = syncBatchOptions('asl-active-batch', batchSummaries(activePool));

        const shownResults = byName(byBatch(resultsPool, rBatch), rq);
        const shownActive = byName(byBatch(activePool, aBatch), aq);

        const filterBits = (sel, q, hidden) => {
            const bits = [];
            if (sel !== 'all') bits.push(sel === '0' ? 'earlier results' : 'Search ' + sel);
            if (q) bits.push('matching "' + q + '"');
            if (hidden) bits.push(hidden + ' deleted/private hidden');
            return bits;
        };
        const rBits = filterBits(rBatch, rq, showDeadR ? 0 : deadResults);
        const aBits = filterBits(aBatch, aq, showDeadA ? 0 : deadActive);

        const rcount = document.getElementById('asl-rcount');
        if (rcount) rcount.textContent = total === 0 ? 'No results yet.'
            : (rBits.length ? 'Showing ' + shownResults.length + ' of ' + total + ' · ' + rBits.join(' · ')
                  : total + ' total · ' + checkedCount + ' checked · ' + uncheckedCount + ' unchecked');
        const acount = document.getElementById('asl-active-count');
        if (acount) acount.textContent = aBits.length
            ? 'Showing ' + shownActive.length + ' of ' + active.length + ' active · ' + aBits.join(' · ')
            : active.length + ' active profiles';

        // The "show deleted & private" checkboxes only appear when there is
        // something behind them.
        const setDeadToggle = (wrapId, nId, n) => {
            const wrap = document.getElementById(wrapId);
            const nEl = document.getElementById(nId);
            if (wrap) wrap.style.display = n ? 'block' : 'none';
            if (nEl) nEl.textContent = String(n);
        };
        setDeadToggle('asl-hidden-wrap', 'asl-hidden-n', deadResults);
        setDeadToggle('asl-active-hidden-wrap', 'asl-active-hidden-n', deadActive);
        const rtab = document.getElementById('asl-rtab-count');
        if (rtab) rtab.textContent = total ? ('(' + total + ')') : '';
        const atab = document.getElementById('asl-atab-count');
        if (atab) atab.textContent = active.length ? ('(' + active.length + ')') : '';

        // Buttons
        const checkBtn = document.getElementById('asl-check-activity');
        if (checkBtn) {
            checkBtn.style.display = total ? 'block' : 'none';
            checkBtn.textContent = 'Check Activity (' + uncheckedCount + ' unchecked)';
        }
        // Retry-failed button: only show when there are errored checks
        const failedCount = results.filter(p => p.activityChecked && p.activityError && !p.gone && !p.restricted).length;
        const retryBtn = document.getElementById('asl-retry-failed');
        if (retryBtn) {
            retryBtn.style.display = failedCount > 0 ? 'block' : 'none';
            retryBtn.textContent = 'Retry Failed Checks (' + failedCount + ')';
        }
        const csvBtn = document.getElementById('asl-csv');
        if (csvBtn) csvBtn.style.display = total ? 'block' : 'none';
        const clearBtn = document.getElementById('asl-clear');
        if (clearBtn) clearBtn.style.display = total ? 'block' : 'none';
        // Always the whole set, whatever the list is narrowed to, and it says
        // the number out loud so there is nothing to infer.
        // Scoped to the dropdown on purpose, and it says so in its own label.
        const batchList = rBatch === 'all' ? [] :
            results.filter(p => String(p.batch || 0) === rBatch && !isDeadEnd(p));
        const rbBtn = document.getElementById('asl-recheck-batch');
        const rbWrap = document.getElementById('asl-recheck-batch-skip-wrap');
        if (rbBtn) {
            rbBtn.style.display = batchList.length ? 'block' : 'none';
            rbBtn.textContent = 'Re-check ' + (rBatch === '0' ? 'earlier results' : 'Search ' + rBatch) +
                ' (' + batchList.length + ' profile' + (batchList.length === 1 ? '' : 's') + ')';
        }
        if (rbWrap) rbWrap.style.display = batchList.length ? 'block' : 'none';

        const goneCount = results.filter(p => p.gone).length;
        const goneBtn = document.getElementById('asl-remove-gone');
        if (goneBtn) {
            goneBtn.style.display = goneCount ? 'block' : 'none';
            goneBtn.textContent = 'Remove ' + goneCount + ' deleted account' + (goneCount === 1 ? '' : 's');
        }

        // Render both lists
        const resultsSort = (document.getElementById('asl-sort') || {}).value || 'newest';
        const activeSort = (document.getElementById('asl-active-sort') || {}).value || 'newest';
        // Dividers only earn their place when more than one search is in view.
        await renderProfileList('asl-res', shownResults, resultsSort, activityDays, rBatch === 'all');
        await renderProfileList('asl-active-res', shownActive, activeSort, activityDays, aBatch === 'all');

        const liveCards = new Map();
        for (const el of document.querySelectorAll('#asl .asl-r[data-nick]')) {
            if (!liveCards.has(el.dataset.nick)) liveCards.set(el.dataset.nick, el);
        }
        prunePhotoQueue(liveCards);
    }

    // =====================
    // CSV IMPORT FOR DEDUP
    // =====================
    async function importCSVForDedup() {
        const fileInput = document.getElementById('asl-import-file');
        const file = fileInput.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const lines = text.split('\n');
            const nicknames = [];

            for (let i = 1; i < lines.length; i++) { // Skip header
                const line = lines[i].trim();
                if (!line) continue;
                // Parse first CSV field (nickname) — handles quoted fields
                let nickname;
                if (line.startsWith('"')) {
                    const end = line.indexOf('"', 1);
                    nickname = line.substring(1, end);
                } else {
                    nickname = line.split(',')[0];
                }
                if (nickname) nicknames.push(nickname);
            }

            if (nicknames.length === 0) {
                setStatus('No nicknames found in CSV.');
                return;
            }

            await dbAddSeenNicknames(nicknames);
            const totalSeen = await dbGetSeenCount();
            setStatus('Imported ' + nicknames.length + ' nicknames for dedup. Total seen: ' + totalSeen);
            updateSeenCount();
        } catch(e) {
            console.error('[ASL] CSV import error:', e);
            setStatus('Error importing CSV: ' + e.message);
        }
        fileInput.value = ''; // Reset file input
    }

    async function updateSeenCount() {
        const el = document.getElementById('asl-seen-count');
        if (!el) return;
        const count = await dbGetSeenCount();
        el.textContent = count > 0 ? count + ' previously seen profiles (will be skipped)' : '';
    }

    // =====================
    // CSV EXPORT
    // =====================
    function writeCSV(rows, filenamePrefix) {
        const hdr = ['Nickname','Age','Gender','Role','Location','Last Active','Profile URL'];
        const dataRows = rows.map(p => {
            let lastActive = '';
            if (p.lastActivity) {
                lastActive = new Date(p.lastActivity).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } else if (p.activityChecked) {
                lastActive = 'None found';
            }
            return [p.nickname, p.age||'', p.gender||'', p.role||'', p.location||'', lastActive, p.url];
        });
        const csv = [hdr,...dataRows].map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
        const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filenamePrefix + '-' + new Date().toISOString().slice(0,10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
    }

    async function exportCSV() {
        const results = await dbGetAllResults();
        if (results.length === 0) { alert('No results'); return; }
        writeCSV(results, 'fetlife-all-results');
    }

    async function exportActiveCSV() {
        const active = await getActiveSet(false);
        if (active.length === 0) { alert('No active profiles'); return; }
        const activeSort = (document.getElementById('asl-active-sort') || {}).value || 'activity';
        writeCSV(sortProfiles(active, activeSort), 'fetlife-active');
    }

    function esc(s) {
        return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
    }

    // =====================
    // INIT
    // =====================
    if (location.hostname === 'fetlife.com') {
        (async function init() {
            await migrateFromLocalStorage();
            seedChromeFromHeader();
            await purgeSharedAvatars();
            buildUI();

            const isSearching = checkForOngoingSearch();

            if (!isSearching) {
                await loadAndDisplayResults();
                // After the first draw, so the panel is usable while it runs,
                // and never during a crawl - that navigates the page away.
                splitAvatarsIfNeeded();
            }
        })();
    }
})();
