// ==UserScript==
// @name           FetLife ASL Search + Activity Filter
// @version        7.0.0
// @namespace      https://github.com/jaredminimal/fetlife-asl-search
// @description    Search FetLife profiles by age, sex, location, role — then filter by recent activity. Two-phase crawl with CSV export.
// @match          https://fetlife.com/*
// @run-at         document-idle
// @noframes
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
    const RESULTS_KEY = 'asl_search_results';
    const PROGRESS_KEY = 'asl_search_progress';

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
                </div>
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
                    <label class="fl">Role</label>
                    <div class="sh" id="asl-rh"></div>
                    <div class="cg" id="asl-r">${ROLES.map(r=>`<label><input type="checkbox" value="${r}" checked> ${r}</label>`).join('')}</div>
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
                    <label class="fl">Delay between pages: <span id="asl-dl">3</span>s</label>
                    <input type="range" id="asl-spd" min="3" max="20" value="3" step="1">
                    <label class="fl">Pages to search</label>
                    <input type="number" id="asl-mp" min="1" max="2000" value="100">
                    <button class="asl-b" id="asl-go">Start Search</button>
                    <div id="asl-status"></div>
                </div>
                <div class="asl-tab" id="asl-t-results">
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Sort by</label>
                        <select id="asl-sort" style="width:auto;margin:0">
                            <option value="newest">Newest first</option>
                            <option value="age-asc">Age (youngest)</option>
                            <option value="age-desc">Age (oldest)</option>
                            <option value="activity">Last active</option>
                        </select>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                        <label class="fl" style="margin:0;white-space:nowrap">Check last</label>
                        <input type="number" id="asl-check-limit" min="1" max="9999" value="1000" style="width:70px;margin:0">
                        <label class="fl" style="margin:0;white-space:nowrap">unchecked</label>
                    </div>
                    <button class="asl-b" id="asl-check-activity">Check Activity Now</button>
                    <button class="asl-b" id="asl-stop-activity">Stop Activity Check</button>
                    <div id="asl-activity-progress"></div>
                    <button class="asl-b" id="asl-csv">Export to CSV</button>
                    <button class="asl-b" id="asl-clear">Clear All Results</button>
                    <div id="asl-rcount"></div>
                    <div id="asl-res"></div>
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

        btn.addEventListener('click', () => panel.classList.toggle('open'));
        document.getElementById('asl-x').addEventListener('click', () => panel.classList.remove('open'));
        document.getElementById('asl-spd').addEventListener('input', function() {
            document.getElementById('asl-dl').textContent = this.value;
        });

        helpers('asl-g', 'asl-gh');
        helpers('asl-r', 'asl-rh');

        document.getElementById('asl-go').addEventListener('click', startNewSearch);
        document.getElementById('asl-csv').addEventListener('click', exportCSV);
        document.getElementById('asl-clear').addEventListener('click', clearResults);
        document.getElementById('asl-check-activity').addEventListener('click', startActivityCheck);
        document.getElementById('asl-stop-activity').addEventListener('click', () => { activityCheckAbort = true; });
        document.getElementById('asl-sort').addEventListener('change', loadAndDisplayResults);

        // Load any existing results
        loadAndDisplayResults();
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

    function getSavedResults() {
        try { return JSON.parse(localStorage.getItem(RESULTS_KEY)) || []; } catch(e) { return []; }
    }

    function saveResults(results) {
        localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
    }

    function getProgress() {
        try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || { lastPageCrawled: 0, batchCount: 0 }; }
        catch(e) { return { lastPageCrawled: 0, batchCount: 0 }; }
    }

    function saveProgress(prog) {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(prog));
    }

    function clearResults() {
        localStorage.removeItem(RESULTS_KEY);
        localStorage.removeItem(PROGRESS_KEY);
        document.getElementById('asl-res').innerHTML = '';
        document.getElementById('asl-rcount').textContent = '';
        document.getElementById('asl-csv').style.display = 'none';
        document.getElementById('asl-clear').style.display = 'none';
        document.getElementById('asl-check-activity').style.display = 'none';
        document.getElementById('asl-rtab-count').textContent = '';
        setStatus('Results cleared.');
    }

    // =====================
    // START A NEW SEARCH
    // =====================
    function startNewSearch() {
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

        const pagesToSearch = parseInt(document.getElementById('asl-mp').value) || 100;
        const params = {
            ageMin: parseInt(document.getElementById('asl-amin').value) || 18,
            ageMax: parseInt(document.getElementById('asl-amax').value) || 200,
            genders: [...document.querySelectorAll('#asl-g input:checked')].map(c => c.value),
            roles: [...document.querySelectorAll('#asl-r input:checked')].map(c => c.value),
            locFilter: document.getElementById('asl-loc').value.trim().toLowerCase(),
            delay: (parseInt(document.getElementById('asl-spd').value) || 3) * 1000,
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

        waitForCards(function(cards) {
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

            const results = getSavedResults();
            const existing = new Set(results.map(r => r.nickname));
            const params = s.params;
            let newMatches = 0;
            for (const p of profiles) {
                s.scanned++;
                if (matchesFilter(p, params) && !existing.has(p.nickname)) {
                    p.batch = s.batch;
                    p.batchPages = s.startPage + '-' + s.endPage;
                    results.push(p);
                    existing.add(p.nickname);
                    newMatches++;
                }
            }
            saveResults(results);

            s.currentPage = pageNum + 1;
            saveState(s);
            const prog = getProgress();
            prog.lastPageCrawled = pageNum;
            saveProgress(prog);

            updateCrawlBanner(s, results.length, pageNum);
            console.log('[ASL] Page', pageNum, ':', newMatches, 'new matches.', results.length, 'total matches.', s.scanned, 'scanned.');

            if (pageNum >= s.endPage) {
                s.active = false;
                saveState(s);
                removeCrawlBanner();
                onPhase1Complete(s);
                return;
            }

            const nextURL = s.baseURL + '?page=' + (pageNum + 1);
            console.log('[ASL] Next page in', s.params.delay/1000, 'seconds:', nextURL);
            setTimeout(() => {
                window.location.href = nextURL;
            }, s.params.delay);
        });
    }

    // Called when Phase 1 (page crawling) finishes
    function onPhase1Complete(s) {
        const results = getSavedResults();
        const activityDays = s.params ? s.params.activityDays : 0;

        if (activityDays > 0 && results.length > 0) {
            // Automatically start Phase 2
            setStatus('Phase 1 done — ' + results.length + ' matches from ' + s.scanned + ' scanned. Starting activity check...');
            loadAndDisplayResults();
            setTimeout(() => startActivityCheck(), 1500);
        } else {
            setStatus('Done! ' + results.length + ' matches from ' + s.scanned + ' profiles scanned.');
            loadAndDisplayResults();
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
    function showCrawlBanner(s) {
        removeCrawlBanner();
        const banner = document.createElement('div');
        banner.className = 'asl-crawl-banner';
        banner.id = 'asl-crawl-banner';
        banner.innerHTML = `
            <span id="asl-banner-text">ASL Search ${s.batch || ''} — Page ${getCurrentPageNumber()} of ${s.startPage || '?'}-${s.endPage || '?'} — ${getSavedResults().length} matches so far...</span>
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

    function stopCrawl() {
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
        loadAndDisplayResults();
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

    async function fetchActivityDate(profileUrl) {
        try {
            // Use FetLife's JSON API: /{nickname}/activity returns activity feed JSON
            // with story_groups[].stories[].created_at timestamps.
            // This works reliably unlike HTML scraping (FetLife is a Vue SPA that
            // returns empty shells for HTML fetches).
            const activityUrl = profileUrl.replace(/\/?$/, '/activity');
            const resp = await fetch(activityUrl, {
                credentials: 'same-origin',
                headers: {
                    'Accept': 'application/json',
                }
            });
            if (!resp.ok) {
                console.log('[ASL] Activity fetch failed:', resp.status, profileUrl);
                return { date: null, error: resp.status };
            }
            const data = await resp.json();

            // Find the most recent created_at from any story in any story_group
            let latest = null;
            if (data.story_groups) {
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
            return { date: latest, error: null };
        } catch (e) {
            console.error('[ASL] Activity fetch error:', e, profileUrl);
            return { date: null, error: e.message };
        }
    }

    async function startActivityCheck() {
        const results = getSavedResults();
        if (results.length === 0) {
            setStatus('No results to check activity for.');
            return;
        }

        // Get the activity threshold from the dropdown
        const activityDays = parseInt(document.getElementById('asl-activity').value) || 90;
        if (activityDays === 0) {
            setStatus('Activity filter set to "Any" — nothing to check.');
            return;
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - activityDays);

        // Find profiles that haven't been checked yet, limited by batch size
        const allUnchecked = results.filter(p => !p.activityChecked);
        if (allUnchecked.length === 0) {
            setStatus('All profiles already checked. Filtering...');
            loadAndDisplayResults();
            return;
        }
        const checkLimit = parseInt(document.getElementById('asl-check-limit').value) || 100;
        // Take the LAST N unchecked (bottom of list = most recently added results)
        const unchecked = allUnchecked.slice(-checkLimit);

        activityCheckAbort = false;

        // Show UI
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

            const result = await fetchActivityDate(p.url);

            p.activityChecked = true;
            if (result.error) {
                p.lastActivity = null;
                p.activityError = result.error;
                errors++;
                // On rate limit (429) or server error, wait longer
                if (result.error === 429 || result.error === 503) {
                    console.log('[ASL] Rate limited, waiting 30s...');
                    progressEl.innerHTML += '<br><span style="color:#cc6">Rate limited — waiting 30 seconds...</span>';
                    await sleep(30000);
                }
            } else if (result.date) {
                p.lastActivity = result.date.toISOString();
                if (result.date >= cutoffDate) {
                    active++;
                } else {
                    inactive++;
                }
            } else {
                p.lastActivity = null; // No activity section found
                inactive++;
            }

            // Save after each check so progress isn't lost
            saveResults(results);

            // Random delay between 3-8 seconds to look natural
            if (checked < total && !activityCheckAbort) {
                const delay = randomDelay(3000, 8000);
                console.log('[ASL] Next activity check in', Math.round(delay/1000), 'seconds');
                await sleep(delay);
            }
        }

        // Done
        stopBtn.style.display = 'none';
        const remaining = allUnchecked.length - checked;
        const msg = activityCheckAbort
            ? `Activity check paused — ${checked}/${total} checked. ${active} active, ${inactive} inactive.${remaining > 0 ? ' ' + remaining + ' still unchecked.' : ''}`
            : `Activity check complete! ${active} active, ${inactive} inactive out of ${total} checked.${remaining > 0 ? ' ' + remaining + ' still unchecked.' : ''}`;
        progressEl.innerHTML = `<strong>${msg}</strong>`;
        setStatus(msg);
        loadAndDisplayResults();
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
            const avatar = img ? img.src : '';

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

        if (params.roles.length > 0 && params.roles.length < ROLES.length) {
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
    function loadAndDisplayResults() {
        const results = getSavedResults();
        const container = document.getElementById('asl-res');
        if (!container) return;

        container.innerHTML = '';
        const countEl = document.getElementById('asl-rcount');
        const activityDays = parseInt(document.getElementById('asl-activity').value) || 0;

        // Filter by activity if threshold is set and checks have been done
        let displayResults = results;
        let filteredCount = 0;
        if (activityDays > 0) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - activityDays);
            displayResults = results.filter(p => {
                if (!p.activityChecked) return true; // Show unchecked profiles
                if (!p.lastActivity) { filteredCount++; return false; }
                const d = new Date(p.lastActivity);
                if (d >= cutoff) return true;
                filteredCount++;
                return false;
            });
        }

        if (results.length === 0) {
            countEl.textContent = 'No results yet.';
            document.getElementById('asl-csv').style.display = 'none';
            document.getElementById('asl-clear').style.display = 'none';
            document.getElementById('asl-check-activity').style.display = 'none';
            document.getElementById('asl-rtab-count').textContent = '';
            return;
        }

        const uncheckedCount = results.filter(p => !p.activityChecked).length;
        let statusText = displayResults.length + ' matches shown';
        if (filteredCount > 0) statusText += ' (' + filteredCount + ' filtered as inactive)';
        if (uncheckedCount > 0 && activityDays > 0) statusText += ' — ' + uncheckedCount + ' not yet checked';
        countEl.textContent = statusText;

        document.getElementById('asl-csv').style.display = 'block';
        document.getElementById('asl-clear').style.display = 'block';
        document.getElementById('asl-rtab-count').textContent = '(' + displayResults.length + ')';

        // Show "Check Activity" button if there are unchecked results and filter is active
        const checkBtn = document.getElementById('asl-check-activity');
        if (uncheckedCount > 0 && activityDays > 0) {
            checkBtn.style.display = 'block';
            checkBtn.textContent = 'Check Activity (' + uncheckedCount + ' unchecked)';
        } else {
            checkBtn.style.display = 'none';
        }

        // Sort results
        const sortMode = (document.getElementById('asl-sort') || {}).value || 'newest';
        let sorted = [...displayResults];
        if (sortMode === 'newest') {
            sorted.reverse();
        } else if (sortMode === 'age-asc') {
            sorted.sort((a, b) => (a.age || 999) - (b.age || 999));
        } else if (sortMode === 'age-desc') {
            sorted.sort((a, b) => (b.age || 0) - (a.age || 0));
        } else if (sortMode === 'activity') {
            sorted.sort((a, b) => {
                const da = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
                const db = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
                return db - da;
            });
        }

        let currentBatch = null;
        for (const p of sorted) {
            if (sortMode === 'newest' && p.batch && p.batch !== currentBatch) {
                currentBatch = p.batch;
                const divider = document.createElement('div');
                divider.className = 'asl-batch-divider';
                divider.textContent = '— Search ' + p.batch + ' (pages ' + (p.batchPages || '?') + ') —';
                container.appendChild(divider);
            }

            const d = document.createElement('div');
            d.className = 'asl-r';
            const avImg = p.avatar
                ? `<img src="${esc(p.avatar)}" alt="" loading="lazy">`
                : `<div style="width:110px;height:110px;border-radius:8px;background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:24px;flex-shrink:0">?</div>`;
            const av = `<a class="av" href="${esc(p.url)}" target="_blank">${avImg}</a>`;
            const meta = [p.age||'', p.gender||'', p.role||''].filter(Boolean).join(' / ');

            // Activity line
            let activityLine = '';
            if (p.activityChecked) {
                if (p.lastActivity) {
                    const d = new Date(p.lastActivity);
                    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    const daysAgo = Math.floor((Date.now() - d.getTime()) / 86400000);
                    const isRecent = daysAgo <= (activityDays || 90);
                    activityLine = `<div class="m ${isRecent ? 'active' : 'inactive'}">Last active: ${dateStr} (${daysAgo}d ago)</div>`;
                } else if (p.activityError) {
                    activityLine = `<div class="m inactive">Activity check failed (${p.activityError})</div>`;
                } else {
                    activityLine = `<div class="m inactive">No activity found</div>`;
                }
            }

            d.innerHTML = `${av}<div class="i"><a href="${esc(p.url)}" target="_blank">${esc(p.nickname)}</a>${meta?`<div class="m">${esc(meta)}</div>`:''}${p.location?`<div class="m">${esc(p.location)}</div>`:''}${activityLine}</div><div class="act"><a href="${esc(p.url)}" target="_blank">Profile</a><a href="https://fetlife.com/conversations/new?with=${esc(p.nickname)}" target="_blank">Message</a></div>`;
            container.appendChild(d);
        }

        // Switch to results tab
        const s = getSavedState();
        if (s && !s.active) {
            document.querySelector('#asl-tabs button[data-t="results"]')?.click();
        }
    }

    // =====================
    // CSV EXPORT
    // =====================
    function exportCSV() {
        const results = getSavedResults();
        if (results.length === 0) { alert('No results'); return; }
        const hdr = ['Nickname','Age','Gender','Role','Location','Last Active','Profile URL'];
        const rows = results.map(p => {
            let lastActive = '';
            if (p.lastActivity) {
                lastActive = new Date(p.lastActivity).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } else if (p.activityChecked) {
                lastActive = 'None found';
            }
            return [p.nickname, p.age||'', p.gender||'', p.role||'', p.location||'', lastActive, p.url];
        });
        const csv = [hdr,...rows].map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
        const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'fetlife-activity-' + new Date().toISOString().slice(0,10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
    }

    function esc(s) {
        return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
    }

    // =====================
    // INIT
    // =====================
    if (location.hostname === 'fetlife.com') {
        buildUI();

        const isSearching = checkForOngoingSearch();

        if (!isSearching) {
            loadAndDisplayResults();
        }
    }
})();
