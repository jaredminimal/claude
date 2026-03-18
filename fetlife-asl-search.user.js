// ==UserScript==
// @name           FetLife ASL Search (Modern Edition)
// @version        5.3.0
// @namespace      https://github.com/jaredminimal/fetlife-asl-search
// @description    Search FetLife profiles by age, sex, location, and role. Crawls member lists with CSV export.
// @match          https://fetlife.com/*
// @run-at         document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // =============================================
    // ARCHITECTURE: Page-navigation based crawling
    // =============================================
    // FetLife is a Vue.js SPA. fetch() and iframes return empty shells.
    // The only reliable way to get rendered content is real page navigation.
    //
    // Flow:
    // 1. User sets filters, clicks Search
    // 2. Script scrapes current page's live DOM
    // 3. Saves results + state to localStorage
    // 4. Navigates to next page (?page=N)
    // 5. On load, detects ongoing search, scrapes, saves, navigates again
    // 6. User clicks Stop or max pages reached → shows all results
    //

    const STORAGE_KEY = 'asl_search_state';
    const RESULTS_KEY = 'asl_search_results';
    const PROGRESS_KEY = 'asl_search_progress'; // tracks lastPageCrawled and batchCount across searches

    // Gender codes used by FetLife (from live DOM inspection)
    const GENDERS = ['M','F','W','TM','TF','TW','GF','GQ','NB','CD/TV','FEM','BUT','IS','AG','TS','CF','CM'];
    const GENDER_LABELS = {
        'M':'Male','F':'Female','W':'Woman','TM':'Trans Man','TF':'Trans Female','TW':'Trans Woman',
        'GF':'Gender Fluid','GQ':'Genderqueer','NB':'Non-binary','CD/TV':'Crossdresser',
        'FEM':'Femme','BUT':'Butch','IS':'Intersex','AG':'Agender','TS':'Two-spirit',
        'CF':'Cis Female','CM':'Cis Male'
    };
    const ROLES = [
        'Dominant','Domme','Dom','Switch','Submissive','Sub','Master','Mistress','Slave',
        'Top','Bottom','Sadist','Masochist','Sadomasochist','Kinkster','Fetishist',
        'Hedonist','Exhibitionist','Voyeur','Rigger','Rope Bunny','Daddy','Mommy',
        'Boy','Girl','Brat','Brat Tamer','Owner','Pet','Primal','Primal Hunter',
        'Primal Prey','Degrader','Degradee','Boss','Princess','Doll','Puppy','Kitten',
        'Pony','Captain','Swinger','Vanilla','Unsure','Not Applicable','Stag','Vixen',
        'Dom-leaning Switch','Sub-leaning Switch','babygirl','babyboy','Bull',
        'Exploring','Queen',
    ];

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
        .asl-r img{width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0}
        .asl-r .i{flex:1;min-width:0}
        .asl-r .i a{color:#fff;text-decoration:none;font-weight:600;font-size:13px}
        .asl-r .i a:hover{text-decoration:underline}
        .asl-r .i .m{color:#999;font-size:11px;margin-top:1px}
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
            <div class="hdr"><span>ASL Search v5</span><button id="asl-x">&times;</button></div>
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
                        <div><label class="fl">Min Age</label><input type="number" id="asl-amin" min="18" max="99" value="18"></div>
                        <div><label class="fl">Max Age</label><input type="number" id="asl-amax" min="18" max="99" value="99"></div>
                    </div>
                    <label class="fl">Gender</label>
                    <div class="sh" id="asl-gh"></div>
                    <div class="cg" id="asl-g">${GENDERS.map(g=>`<label><input type="checkbox" value="${g}" checked> ${GENDER_LABELS[g]||g}</label>`).join('')}</div>
                    <label class="fl">Role</label>
                    <div class="sh" id="asl-rh"></div>
                    <div class="cg" id="asl-r">${ROLES.map(r=>`<label><input type="checkbox" value="${r}" checked> ${r}</label>`).join('')}</div>
                    <label class="fl">Location contains (optional)</label>
                    <input type="text" id="asl-loc" placeholder="e.g. Phoenix, Scottsdale">
                    <div class="sec">Step 3: Speed &amp; Limits</div>
                    <label class="fl">Delay between pages: <span id="asl-dl">5</span>s</label>
                    <input type="range" id="asl-spd" min="3" max="20" value="5" step="1">
                    <label class="fl">Pages to search</label>
                    <input type="number" id="asl-mp" min="1" max="2000" value="100">
                    <button class="asl-b" id="asl-go">Start Search</button>
                    <div id="asl-status"></div>
                </div>
                <div class="asl-tab" id="asl-t-results">
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
        if (el) { el.style.display = ''; el.textContent = msg; }
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
        document.getElementById('asl-rtab-count').textContent = '';
        setStatus('Results cleared.');
    }

    // =====================
    // START A NEW SEARCH
    // =====================
    function startNewSearch() {
        // Detect base URL from current page
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

        // Gather filter params
        const pagesToSearch = parseInt(document.getElementById('asl-mp').value) || 100;
        const params = {
            ageMin: parseInt(document.getElementById('asl-amin').value) || 18,
            ageMax: parseInt(document.getElementById('asl-amax').value) || 99,
            genders: [...document.querySelectorAll('#asl-g input:checked')].map(c => c.value),
            roles: [...document.querySelectorAll('#asl-r input:checked')].map(c => c.value),
            locFilter: document.getElementById('asl-loc').value.trim().toLowerCase(),
            delay: (parseInt(document.getElementById('asl-spd').value) || 5) * 1000,
        };

        // Start from current page or continue from where last search ended, whichever is further
        const prog = getProgress();
        const currentPage = getCurrentPageNumber();
        const startPage = Math.max(currentPage, prog.lastPageCrawled + 1);
        const batch = prog.batchCount + 1;
        const endPage = startPage + pagesToSearch - 1;

        // Save search state
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

        // Update progress with new batch count (lastPageCrawled updated as pages are crawled)
        prog.batchCount = batch;
        saveProgress(prog);

        console.log('[ASL] Starting search batch', batch, '— pages', startPage, 'to', endPage);

        // Navigate to the start page (or scrape if already on it)
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

        // Verify we're on the right site/path
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

        // Wait for Vue to render [data-member-card] elements
        waitForCards(function(cards) {
            const profiles = [];
            for (const card of cards) {
                const p = parseCard(card);
                if (p) profiles.push(p);
            }

            console.log('[ASL] Found', profiles.length, 'profiles on page', pageNum);

            if (profiles.length === 0) {
                // No more profiles — search is done
                s.active = false;
                saveState(s);
                const prog = getProgress();
                prog.lastPageCrawled = pageNum;
                saveProgress(prog);
                removeCrawlBanner();
                setStatus('Done! ' + getSavedResults().length + ' matches from ' + s.scanned + ' profiles scanned.');
                loadAndDisplayResults();
                return;
            }

            // Filter and save matches
            const results = getSavedResults();
            const params = s.params;
            let newMatches = 0;
            for (const p of profiles) {
                s.scanned++;
                if (matchesFilter(p, params)) {
                    p.batch = s.batch;
                    p.batchPages = s.startPage + '-' + s.endPage;
                    results.push(p);
                    newMatches++;
                }
            }
            saveResults(results);

            // Update state and progress
            s.currentPage = pageNum + 1;
            saveState(s);
            const prog = getProgress();
            prog.lastPageCrawled = pageNum;
            saveProgress(prog);

            // Update banner
            updateCrawlBanner(s, results.length, pageNum);
            console.log('[ASL] Page', pageNum, ':', newMatches, 'new matches.', results.length, 'total matches.', s.scanned, 'scanned.');

            // Check if we've hit the end page for this batch
            if (pageNum >= s.endPage) {
                s.active = false;
                saveState(s);
                removeCrawlBanner();
                setStatus('Search batch ' + s.batch + ' done. ' + results.length + ' total matches from ' + s.scanned + ' scanned this run.');
                loadAndDisplayResults();
                return;
            }

            // Navigate to next page after delay
            const nextURL = s.baseURL + '?page=' + (pageNum + 1);
            console.log('[ASL] Next page in', s.params.delay/1000, 'seconds:', nextURL);
            setTimeout(() => {
                window.location.href = nextURL;
            }, s.params.delay);
        });
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
                // After 15 seconds, give up — page might be empty
                console.log('[ASL] No cards found after 15s');
                callback([]);
                return;
            }
            setTimeout(check, 500);
        }
        check();
    }

    // =====================
    // CRAWL BANNER (shown at top of page during search)
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
            // Update progress so next search continues from where we stopped
            const prog = getProgress();
            prog.lastPageCrawled = getCurrentPageNumber();
            saveProgress(prog);
        }
        removeCrawlBanner();
        console.log('[ASL] Search stopped by user.');
        loadAndDisplayResults();
    }

    // =====================
    // PARSE MEMBER CARD
    // =====================
    function parseCard(card) {
        try {
            const nickname = card.getAttribute('data-member-card');
            if (!nickname) return null;

            // Normalize whitespace
            const rawText = card.textContent.replace(/\s+/g, ' ').trim();
            const img = card.querySelector('img');
            const avatar = img ? img.src : '';

            // CRITICAL: The text starts with the nickname concatenated directly
            // into the age+gender. E.g. "inlovehun9432F sub Phoenix, Arizona13 Pics..."
            // Strip the nickname from the front to get: "32F sub Phoenix, Arizona13 Pics..."
            let infoText = rawText;
            if (rawText.toLowerCase().startsWith(nickname.toLowerCase())) {
                infoText = rawText.substring(nickname.length).trim();
            }
            // Also handle case where nickname appears with slight variation
            // (sometimes the text repeats the nickname)
            const nickIdx = rawText.indexOf(nickname);
            if (nickIdx >= 0) {
                infoText = rawText.substring(nickIdx + nickname.length).trim();
            }

            const asl = parseASL(infoText);

            // Location from place links
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

        // After stripping the nickname, text looks like:
        //   "32F sub Phoenix, Arizona13 Pics·1 Vid·2 WritingsFollow"
        //   "48M Evolving Phoenix, Arizona29 Pics·8 Vids·1 WritingFollow"
        //   "26W Exhibitionist Phoenix, Arizona11 Pics·1 WritingFollow"
        //   "52F Exploring Phoenix, Arizona9 PicsFollow"
        //   "54M Kinkster Phoenix, Arizona83 Pics·1 Vid·2 WritingsFollow"
        //   "54 Stag Phoenix, Arizona52 Pics·25 VidsFollow"
        //
        // Pattern: {age}{genderCode} {role} {location}{stats}Follow

        // Gender codes — W added (seen in live data), longest first
        const genderCodes = ['CD/TV','FEM','BUT','TM','TF','TW','GF','GQ','NB','CF','CM','IS','AG','TS','TG','W','M','F'];
        const gcPattern = genderCodes.map(g => g.replace('/', '\\/')).join('|');

        // Text now starts with age+gender since nickname is stripped
        // Match at the START of the text: digits + gender code
        const agMatch = text.match(new RegExp('^(\\d{2,3})(' + gcPattern + ')\\s+', 'i'));

        if (agMatch) {
            age = parseInt(agMatch[1]);
            genderCode = agMatch[2].toUpperCase();
            gender = GENDER_LABELS[genderCode] || genderCode;

            // Everything after age+gender+space is: "role location stats Follow"
            const rest = text.substring(agMatch[0].length);

            // Role = text up to first "City, State" pattern or digit+Pics or Follow
            const roleMatch = rest.match(/^(.+?)(?=\s*[A-Z][a-z]+,\s*[A-Z]|\s*\d+\s*Pics|\s*\d+\s*Vids|\s*Follow)/);
            if (roleMatch) {
                role = roleMatch[1].replace(/[^\x20-\x7E]/g, '').trim();
            }
        } else {
            // No gender code — try "54 Stag" or just "54" at start
            const ageOnly = text.match(/^(\d{2,3})\s+(.+?)(?=\s*[A-Z][a-z]+,\s*[A-Z]|\s*\d+\s*Pics|\s*Follow)/);
            if (ageOnly) {
                const n = parseInt(ageOnly[1]);
                if (n >= 18 && n <= 99) {
                    age = n;
                    role = ageOnly[2].replace(/[^\x20-\x7E]/g, '').trim();
                }
            } else {
                // Last try: just find age digits at start
                const justAge = text.match(/^(\d{2,3})/);
                if (justAge) {
                    const n = parseInt(justAge[1]);
                    if (n >= 18 && n <= 99) age = n;
                }
            }
        }

        // If role not found yet, look for known keywords
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
    // DISPLAY RESULTS (from localStorage)
    // =====================
    function loadAndDisplayResults() {
        const results = getSavedResults();
        const container = document.getElementById('asl-res');
        if (!container) return;

        container.innerHTML = '';
        const countEl = document.getElementById('asl-rcount');

        if (results.length === 0) {
            countEl.textContent = 'No results yet.';
            document.getElementById('asl-csv').style.display = 'none';
            document.getElementById('asl-clear').style.display = 'none';
            document.getElementById('asl-rtab-count').textContent = '';
            return;
        }

        countEl.textContent = results.length + ' matches found';
        document.getElementById('asl-csv').style.display = '';
        document.getElementById('asl-clear').style.display = '';
        document.getElementById('asl-rtab-count').textContent = '(' + results.length + ')';

        let currentBatch = null;
        for (const p of results) {
            // Insert batch divider when batch changes
            if (p.batch && p.batch !== currentBatch) {
                currentBatch = p.batch;
                const divider = document.createElement('div');
                divider.className = 'asl-batch-divider';
                divider.textContent = '— Search ' + p.batch + ' (pages ' + (p.batchPages || '?') + ') —';
                container.appendChild(divider);
            }

            const d = document.createElement('div');
            d.className = 'asl-r';
            const av = p.avatar
                ? `<img src="${esc(p.avatar)}" alt="" loading="lazy">`
                : `<div style="width:44px;height:44px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:18px;flex-shrink:0">?</div>`;
            const meta = [p.age||'', p.gender||'', p.role||''].filter(Boolean).join(' / ');
            d.innerHTML = `${av}<div class="i"><a href="${esc(p.url)}" target="_blank">${esc(p.nickname)}</a>${meta?`<div class="m">${esc(meta)}</div>`:''}${p.location?`<div class="m">${esc(p.location)}</div>`:''}</div><div class="act"><a href="${esc(p.url)}" target="_blank">Profile</a><a href="https://fetlife.com/conversations/new?with=${esc(p.nickname)}" target="_blank">Message</a></div>`;
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
        const hdr = ['Nickname','Age','Gender','Role','Location','Profile URL'];
        const rows = results.map(p => [p.nickname, p.age||'', p.gender||'', p.role||'', p.location||'', p.url]);
        const csv = [hdr,...rows].map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
        const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'fetlife-' + new Date().toISOString().slice(0,10) + '.csv';
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

        // Check if there's an ongoing search (we just navigated to a new page)
        const isSearching = checkForOngoingSearch();

        if (!isSearching) {
            // Show any previously saved results
            loadAndDisplayResults();
        }
    }
})();
