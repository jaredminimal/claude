// ==UserScript==
// @name           FetLife ASL Search (Modern Edition)
// @version        4.0.0
// @namespace      https://github.com/jaredminimal/fetlife-asl-search
// @description    Search FetLife profiles by age, sex, location, and role. Crawls member lists with CSV export.
// @match          https://fetlife.com/*
// @run-at         document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // =====================
    // STATE
    // =====================
    let state = {
        running: false,
        aborted: false,
        scanned: 0,
        matched: 0,
        page: 1,
        results: [],
    };

    // =====================
    // STYLES
    // =====================
    const style = document.createElement('style');
    style.textContent = `
        #asl-btn{position:fixed;bottom:20px;right:20px;z-index:100000;background:#c22;color:#fff;border:none;border-radius:50%;width:56px;height:56px;font-size:18px;font-weight:700;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center}
        #asl-btn:hover{background:#e33}
        #asl{position:fixed;top:10px;right:10px;z-index:100000;width:460px;max-height:calc(100vh - 20px);background:#1a1a2e;color:#e0e0e0;border:1px solid #444;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:none;flex-direction:column;overflow:hidden}
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
        #asl-stop{background:#555;color:#fff;display:none;margin-top:6px}
        #asl-csv{background:#2a6;color:#fff;display:none;margin-top:6px}#asl-csv:hover{background:#3b7}
        #asl-status{margin-top:8px;padding:6px 10px;background:#16213e;border-radius:6px;font-size:12px;color:#aaa;display:none;word-break:break-word}
        #asl-log{background:#0d1117;border-radius:6px;font-size:11px;color:#7d8590;max-height:none;height:400px;overflow-y:auto;font-family:monospace;word-break:break-all;padding:6px 8px;white-space:pre-wrap}
        #asl-rcount{margin-top:8px;font-size:12px;color:#888;display:none}
        #asl-res{margin-top:8px}
        .asl-r{display:flex;gap:8px;padding:8px;background:#16213e;border-radius:8px;margin-bottom:6px;align-items:center;border:1px solid #222}
        .asl-r:hover{border-color:#c22}
        .asl-r img{width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0}
        .asl-r .i{flex:1;min-width:0}
        .asl-r .i a{color:#fff;text-decoration:none;font-weight:600;font-size:13px}
        .asl-r .i a:hover{text-decoration:underline}
        .asl-r .i .m{color:#999;font-size:11px;margin-top:1px}
        .asl-r .act a{color:#c22;text-decoration:none;font-size:11px}
        #asl-tabs{display:flex;margin-bottom:10px}
        #asl-tabs button{flex:1;padding:8px 4px;background:#16213e;border:1px solid #333;color:#888;font-size:12px;font-weight:600;cursor:pointer}
        #asl-tabs button:first-child{border-radius:6px 0 0 6px}
        #asl-tabs button:last-child{border-radius:0 6px 6px 0}
        #asl-tabs button.on{background:#c22;color:#fff;border-color:#c22}
        .asl-tab{display:none}.asl-tab.on{display:block}
        #asl input[type=range]{width:100%;accent-color:#c22;margin-bottom:8px}
    `;
    document.head.appendChild(style);

    // =====================
    // GENDER / ROLE OPTIONS
    // =====================
    // From screenshot: FetLife uses abbreviations like 25F, 46M, 36TW, 30FEM, 55M
    const GENDERS = ['M','F','TM','TF','TW','GF','GQ','NB','CD/TV','FEM','BUT','IS','AG','TS','CF','CM'];
    const GENDER_LABELS = {
        'M':'Male','F':'Female','TM':'Trans Man','TF':'Trans Female','TW':'Trans Woman',
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
        'Dom-leaning Switch','Dom-leaning Sw...','Sub-leaning Switch','babygirl','babyboy',
    ];

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
            <div class="hdr"><span>ASL Search v4</span><button id="asl-x">&times;</button></div>
            <div class="body">
                <div id="asl-tabs">
                    <button class="on" data-t="search">Search</button>
                    <button data-t="results">Results</button>
                    <button data-t="log">Debug</button>
                </div>
                <div class="asl-tab on" id="asl-t-search">
                    <div class="sec">Where to Search</div>
                    <label class="fl">Mode</label>
                    <select id="asl-src">
                        <option value="thispage">This Page</option>
                        <option value="url">Paste URL(s)</option>
                    </select>
                    <div id="asl-src-url" style="display:none">
                        <label class="fl">URL(s) — one per line</label>
                        <textarea id="asl-url" rows="3" placeholder="https://fetlife.com/p/united-states/arizona/kinksters"></textarea>
                    </div>
                    <div class="sec">Filters</div>
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
                    <input type="text" id="asl-loc" placeholder="e.g. Phoenix, California">
                    <div class="sec">Speed</div>
                    <label class="fl">Delay: <span id="asl-dl">4</span>s</label>
                    <input type="range" id="asl-spd" min="2" max="15" value="4" step="1">
                    <label class="fl">Max pages</label>
                    <input type="number" id="asl-mp" min="1" max="2000" value="100">
                    <button class="asl-b" id="asl-go">Search</button>
                    <button class="asl-b" id="asl-stop">Stop</button>
                    <div id="asl-status"></div>
                </div>
                <div class="asl-tab" id="asl-t-results">
                    <button class="asl-b" id="asl-csv">Export CSV</button>
                    <div id="asl-rcount"></div>
                    <div id="asl-res"></div>
                </div>
                <div class="asl-tab" id="asl-t-log">
                    <p style="font-size:11px;color:#666;margin:0 0 6px">Debug output</p>
                    <div id="asl-log"></div>
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
        document.getElementById('asl-src').addEventListener('change', function() {
            document.getElementById('asl-src-url').style.display = this.value === 'url' ? '' : 'none';
        });
        document.getElementById('asl-spd').addEventListener('input', function() {
            document.getElementById('asl-dl').textContent = this.value;
        });

        helpers('asl-g', 'asl-gh');
        helpers('asl-r', 'asl-rh');

        document.getElementById('asl-go').addEventListener('click', startSearch);
        document.getElementById('asl-stop').addEventListener('click', stopSearch);
        document.getElementById('asl-csv').addEventListener('click', exportCSV);
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
    // LOGGING
    // =====================
    function log(msg) {
        const el = document.getElementById('asl-log');
        if (el) {
            el.textContent += '[' + new Date().toLocaleTimeString() + '] ' + msg + '\n';
            el.scrollTop = el.scrollHeight;
        }
        console.log('[ASL]', msg);
    }

    function status(msg) {
        const el = document.getElementById('asl-status');
        el.style.display = '';
        el.textContent = msg;
        log(msg);
    }

    // =====================
    // SEARCH PARAMS
    // =====================
    function getParams() {
        return {
            ageMin: parseInt(document.getElementById('asl-amin').value) || 18,
            ageMax: parseInt(document.getElementById('asl-amax').value) || 99,
            genders: [...document.querySelectorAll('#asl-g input:checked')].map(c => c.value),
            roles: [...document.querySelectorAll('#asl-r input:checked')].map(c => c.value),
            locFilter: document.getElementById('asl-loc').value.trim().toLowerCase(),
        };
    }

    function getDelay() { return (parseInt(document.getElementById('asl-spd').value) || 4) * 1000; }
    function getMaxPages() { return parseInt(document.getElementById('asl-mp').value) || 100; }

    // =====================
    // URL DETECTION
    // =====================
    function getBaseURL() {
        const src = document.getElementById('asl-src').value;
        if (src === 'url') {
            const raw = document.getElementById('asl-url').value.trim();
            if (!raw) { alert('Enter URL(s)'); return null; }
            return raw.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
        }
        // thispage
        let loc = window.location.href.split('?')[0].split('#')[0];
        // Make sure it ends with /kinksters or similar
        if (/\/kinksters$/.test(loc) || /\/group_memberships$/.test(loc) || /\/friends$/.test(loc)) {
            return [loc];
        }
        // If on a place page, append /kinksters
        if (/\/p\//.test(loc) || /\/(cities|administrative_areas|countries)\/\d+/.test(loc)) {
            loc = loc.replace(/\/$/, '') + '/kinksters';
            return [loc];
        }
        alert('Navigate to a kinksters list page first,\nor use "Paste URL(s)" mode.');
        return null;
    }

    // =====================
    // SEARCH
    // =====================
    function startSearch() {
        const urls = getBaseURL();
        if (!urls || urls.length === 0) return;

        state = { running: true, aborted: false, scanned: 0, matched: 0, page: 1, results: [] };
        document.getElementById('asl-res').innerHTML = '';
        document.getElementById('asl-go').disabled = true;
        document.getElementById('asl-stop').style.display = '';
        document.getElementById('asl-csv').style.display = 'none';
        document.getElementById('asl-rcount').style.display = 'none';
        document.getElementById('asl-log').textContent = '';

        log('Starting search');
        log('URLs: ' + JSON.stringify(urls));

        // Step 1: Scrape the current live page (page 1)
        const currentBase = window.location.href.split('?')[0].split('#')[0];
        if (urls[0] === currentBase || urls[0] === currentBase.replace(/\/$/, '')) {
            log('Current page matches target — scraping live DOM first');
            const profiles = scrapeDocument(document);
            log('Live DOM: found ' + profiles.length + ' profiles');
            processProfiles(profiles);
            state.page = 2;
            status('Page 1 done (live). ' + state.matched + ' matches / ' + state.scanned + ' scanned. Fetching page 2...');
            setTimeout(() => fetchPage(urls[0], 2), getDelay());
        } else {
            fetchPage(urls[0], 1);
        }
    }

    function stopSearch() {
        state.aborted = true;
        state.running = false;
        document.getElementById('asl-go').disabled = false;
        document.getElementById('asl-stop').style.display = 'none';
        if (state.results.length > 0) document.getElementById('asl-csv').style.display = '';
        status('Stopped. ' + state.matched + ' matches / ' + state.scanned + ' scanned.');
        updateCount();
    }

    function finishSearch() {
        state.running = false;
        document.getElementById('asl-go').disabled = false;
        document.getElementById('asl-stop').style.display = 'none';
        if (state.results.length > 0) document.getElementById('asl-csv').style.display = '';
        status('Done! ' + state.matched + ' matches / ' + state.scanned + ' scanned.');
        updateCount();
        document.querySelector('#asl-tabs button[data-t="results"]').click();
    }

    function updateCount() {
        const el = document.getElementById('asl-rcount');
        el.style.display = '';
        el.textContent = state.matched + ' matches from ' + state.scanned + ' scanned';
    }

    function processProfiles(profiles) {
        const params = getParams();
        for (const p of profiles) {
            state.scanned++;
            if (matches(p, params)) {
                state.matched++;
                state.results.push(p);
                showResult(p);
            }
        }
        updateCount();
    }

    // =====================
    // LOAD PAGES VIA HIDDEN IFRAME (so Vue.js renders the content)
    // fetch() returns an empty SPA shell — we need JS to execute.
    // =====================
    function fetchPage(baseURL, page) {
        if (state.aborted || page > getMaxPages()) {
            if (!state.aborted) finishSearch();
            return;
        }

        const sep = baseURL.includes('?') ? '&' : '?';
        const url = baseURL + sep + 'page=' + page;
        status('[Page ' + page + '] Loading... (' + state.matched + ' matches / ' + state.scanned + ' scanned)');
        log('Loading iframe: ' + url);

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:1280px;height:900px;opacity:0;pointer-events:none;';
        iframe.src = url;

        let done = false;

        // Timeout: if page doesn't load in 30s, skip it
        const timeout = setTimeout(() => {
            if (done) return;
            done = true;
            log('Iframe timeout for page ' + page);
            cleanup();
            // Try next page in case this was a fluke
            state.page = page + 1;
            setTimeout(() => fetchPage(baseURL, page + 1), getDelay());
        }, 30000);

        function cleanup() {
            clearTimeout(timeout);
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }

        iframe.addEventListener('load', () => {
            if (done || state.aborted) { cleanup(); return; }

            // Wait for Vue to render the member cards
            // Poll every 500ms for up to 10s
            let attempts = 0;
            const maxAttempts = 20;

            function checkForContent() {
                if (done || state.aborted) { cleanup(); return; }
                attempts++;

                try {
                    const iDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const cards = iDoc.querySelectorAll('[data-member-card]');
                    log('  Iframe poll #' + attempts + ': ' + cards.length + ' cards');

                    if (cards.length > 0) {
                        // Found content — scrape it
                        done = true;
                        const profiles = scrapeDocument(iDoc);
                        log('Page ' + page + ' (iframe): ' + profiles.length + ' profiles');
                        cleanup();

                        if (profiles.length === 0) {
                            finishSearch();
                            return;
                        }

                        processProfiles(profiles);
                        state.page = page + 1;
                        status('Page ' + page + ' done. ' + state.matched + ' matches / ' + state.scanned + '. Next in ' + (getDelay()/1000) + 's...');
                        setTimeout(() => fetchPage(baseURL, page + 1), getDelay());
                        return;
                    }

                    if (attempts >= maxAttempts) {
                        // Gave up waiting for Vue to render
                        done = true;
                        log('Page ' + page + ': no cards after ' + maxAttempts + ' polls. May be last page.');
                        cleanup();
                        finishSearch();
                        return;
                    }

                    // Keep polling
                    setTimeout(checkForContent, 500);
                } catch (e) {
                    // Cross-origin or security error
                    done = true;
                    log('Iframe access error: ' + e.message);
                    cleanup();
                    status('Cannot read iframe (blocked by site). Stopping.');
                    stopSearch();
                }
            }

            // Start polling after a short initial delay
            setTimeout(checkForContent, 1000);
        });

        iframe.addEventListener('error', () => {
            if (done) return;
            done = true;
            log('Iframe load error for page ' + page);
            cleanup();
            status('Failed to load page ' + page + '. Retrying in 10s...');
            setTimeout(() => fetchPage(baseURL, page), 10000);
        });

        document.body.appendChild(iframe);
    }

    // =====================
    // SCRAPE PROFILES FROM A DOCUMENT
    // =====================
    // FetLife 2026 structure (from inspecting the live page):
    //
    // <div data-member-card="nickname">
    //   <div class="flex items-center p-3.5">
    //     <div class="flex min-w-0 flex-auto items-center">  ← avatar + info
    //     <div class="flex-none pl-3.5">                     ← follow button
    //
    // Member links use href="/nickname" (NOT /users/ID)
    // Text inside the card: "VioletteRainBrat 25F Princess\nPhoenix, Arizona\n72 Pics..."
    //
    function scrapeDocument(doc) {
        const profiles = [];

        // Primary selector: [data-member-card]
        const cards = doc.querySelectorAll('[data-member-card]');
        log('  [data-member-card] elements: ' + cards.length);

        if (cards.length > 0) {
            for (const card of cards) {
                const p = parseCard(card);
                if (p) profiles.push(p);
            }
            if (profiles.length > 0) {
                if (profiles.length <= 3) log('  Samples: ' + JSON.stringify(profiles.slice(0, 3)));
                return profiles;
            }
        }

        // Fallback: look for the flex grid of member entries
        // Each entry is in: div.w-full.flex-none.px-1.md\:w-1\/2
        const gridItems = doc.querySelectorAll('div[class*="w-full"][class*="flex-none"][class*="px-1"]');
        log('  Grid items: ' + gridItems.length);
        for (const item of gridItems) {
            // Check if it contains a user-like link
            const link = item.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/search"]):not([href*="/groups"])');
            if (link) {
                const p = parseGridItem(item);
                if (p) profiles.push(p);
            }
        }

        if (profiles.length > 0) {
            if (profiles.length <= 3) log('  Samples: ' + JSON.stringify(profiles.slice(0, 3)));
            return profiles;
        }

        // Last resort: scan all links that look like profile links
        log('  Trying last-resort link scan...');
        const allLinks = doc.querySelectorAll('a[href^="/"]');
        const seen = new Set();
        for (const link of allLinks) {
            const href = link.getAttribute('href');
            // Profile links are like /nickname — single path segment, no slashes after
            if (!href || href.split('/').length !== 2) continue;
            const nick = href.substring(1);
            // Skip known non-profile paths
            if (/^(home|explore|search|groups|events|places|p|settings|inbox|conversations|notifications|support|help|about|terms|privacy|policies|bookmarks|messages|users|fetishes|contact)$/i.test(nick)) continue;
            if (seen.has(nick)) continue;
            if (link.closest('nav, header, footer')) continue;
            seen.add(nick);

            const container = link.closest('div[class*="bg-gray-900"], div[class*="rounded"]') || link.parentElement.parentElement;
            if (container) {
                const p = parseGenericContainer(container, nick);
                if (p) profiles.push(p);
            }
        }

        log('  Last-resort found: ' + profiles.length);
        if (profiles.length <= 3) log('  Samples: ' + JSON.stringify(profiles.slice(0, 3)));
        return profiles;
    }

    // =====================
    // PARSE: data-member-card element
    // =====================
    function parseCard(card) {
        try {
            const nickname = card.getAttribute('data-member-card');
            if (!nickname) return null;

            // Get the text content of the card
            const text = card.textContent.trim();

            // Find avatar image
            const img = card.querySelector('img');
            const avatar = img ? img.src : '';

            // Parse: "nickname 25F Princess Phoenix, Arizona 72 Pics · 10 Vids Follow"
            // The ASL info follows the nickname: age(digits) + gender(letters) + space + role
            const asl = parseASL(text, nickname);

            // Location: look for place links or "City, State" pattern
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
                // Try "City, State" pattern in text
                const locMatch = text.match(/([A-Z][a-zA-Z\s]+),\s*([A-Z][a-zA-Z\s]+)/);
                if (locMatch) location = locMatch[0];
            }

            return {
                nickname,
                age: asl.age,
                gender: asl.gender,
                genderCode: asl.genderCode,
                role: asl.role,
                location,
                avatar,
                url: 'https://fetlife.com/' + nickname,
            };
        } catch (e) {
            log('parseCard error: ' + e.message);
            return null;
        }
    }

    function parseGridItem(item) {
        // Similar to parseCard but for the grid fallback
        const link = item.querySelector('a[href^="/"]:not([href*="/p/"])');
        if (!link) return null;
        const href = link.getAttribute('href');
        if (!href || href.split('/').length !== 2) return null;
        const nickname = href.substring(1);
        return parseGenericContainer(item, nickname);
    }

    function parseGenericContainer(container, nickname) {
        try {
            const text = container.textContent.trim();
            const img = container.querySelector('img');
            const avatar = img ? img.src : '';
            const asl = parseASL(text, nickname);

            let location = '';
            const placeLinks = container.querySelectorAll('a[href*="/p/"]');
            if (placeLinks.length > 0) {
                const parts = [];
                placeLinks.forEach(a => {
                    const t = a.textContent.trim();
                    if (t && !parts.includes(t)) parts.push(t);
                });
                location = parts.join(', ');
            }
            if (!location) {
                const locMatch = text.match(/([A-Z][a-zA-Z\s]+),\s*([A-Z][a-zA-Z\s]+)/);
                if (locMatch) location = locMatch[0];
            }

            return { nickname, age: asl.age, gender: asl.gender, genderCode: asl.genderCode, role: asl.role, location, avatar, url: 'https://fetlife.com/' + nickname };
        } catch (e) { return null; }
    }

    // =====================
    // PARSE AGE / GENDER / ROLE from card text
    // =====================
    // FetLife format from screenshot:
    //   "VioletteRainBrat 25F Princess"  → age=25, gender=F(Female), role=Princess
    //   "themayanviking 46M Kinkster"    → age=46, gender=M(Male), role=Kinkster
    //   "Alexis_V 36TW Bottom"           → age=36, gender=TW(Trans Woman), role=Bottom
    //   "DominatrixElle 30FEM Dom"       → age=30, gender=FEM(Femme), role=Dom
    //   "ScottyArcher 32M Dom-leaning Sw..." → age=32, gender=M, role=Dom-leaning Switch
    //
    function parseASL(text, nickname) {
        let age = null, gender = '', genderCode = '', role = '';

        // Gender codes sorted longest first so TW matches before T
        const genderCodes = ['CD/TV','FEM','BUT','TM','TF','TW','GF','GQ','NB','CF','CM','IS','AG','TS','TG','M','F'];

        // Build regex: \b(\d{2})(GENDERCODE)\s+(.+?)(?=\s*\d+\s*Pics|\s*Follow|\s*$)
        const gcPattern = genderCodes.map(g => g.replace('/', '\\/')).join('|');
        const regex = new RegExp('\\b(\\d{2})(' + gcPattern + ')\\s+(.+?)(?:\\s*\\d+\\s*Pics|\\s*\\d+\\s*Vids|\\s*\\d+\\s*Writings|\\s*Follow|\\s*$)', 'i');

        const m = text.match(regex);
        if (m) {
            age = parseInt(m[1]);
            genderCode = m[2].toUpperCase();
            gender = GENDER_LABELS[genderCode] || genderCode;
            role = m[3].trim();
            // Clean trailing location/noise
            role = role.replace(/\s*(Phoenix|[A-Z][a-z]+,\s*[A-Z]).*$/, '').trim();
            // Remove heart emoji that appears in some entries
            role = role.replace(/[^\x20-\x7E]/g, '').trim();
        } else {
            // Try a simpler pattern: just digits followed by a gender code
            const simpler = new RegExp('\\b(\\d{2})(' + gcPattern + ')\\b', 'i');
            const m2 = text.match(simpler);
            if (m2) {
                age = parseInt(m2[1]);
                genderCode = m2[2].toUpperCase();
                gender = GENDER_LABELS[genderCode] || genderCode;
            }

            // Try to find a role keyword in the text
            for (const r of ROLES) {
                if (text.includes(r)) {
                    role = r;
                    break;
                }
            }
        }

        return { age, gender, genderCode, role };
    }

    // =====================
    // MATCHING
    // =====================
    function matches(p, params) {
        // Age — exclude if no age detected
        if (p.age === null) return false;
        if (p.age < params.ageMin || p.age > params.ageMax) return false;

        // Gender — if filter is active (not all selected), REQUIRE a match
        if (params.genders.length > 0 && params.genders.length < GENDERS.length) {
            // If we couldn't detect gender, exclude the profile
            if (!p.genderCode) return false;
            if (!params.genders.includes(p.genderCode)) return false;
        }

        // Role — if filter is active (not all selected), REQUIRE a match
        if (params.roles.length > 0 && params.roles.length < ROLES.length) {
            if (!p.role) return false;
            const r = p.role.toLowerCase();
            const match = params.roles.some(sr => {
                const s = sr.toLowerCase();
                return r === s || r.includes(s) || s.includes(r);
            });
            if (!match) return false;
        }

        // Location
        if (params.locFilter && !(p.location || '').toLowerCase().includes(params.locFilter)) return false;

        return true;
    }

    // =====================
    // DISPLAY RESULT
    // =====================
    function showResult(p) {
        const c = document.getElementById('asl-res');
        const d = document.createElement('div');
        d.className = 'asl-r';
        const av = p.avatar
            ? `<img src="${esc(p.avatar)}" alt="" loading="lazy">`
            : `<div style="width:44px;height:44px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:18px;flex-shrink:0">?</div>`;
        const meta = [p.age||'', p.gender||'', p.role||''].filter(Boolean).join(' / ');
        d.innerHTML = `${av}<div class="i"><a href="${esc(p.url)}" target="_blank">${esc(p.nickname)}</a>${meta?`<div class="m">${esc(meta)}</div>`:''}${p.location?`<div class="m">${esc(p.location)}</div>`:''}</div><div class="act"><a href="${esc(p.url)}" target="_blank">Profile</a><br><a href="https://fetlife.com/conversations/new?with=${esc(p.nickname)}" target="_blank">Message</a></div>`;
        c.appendChild(d);
    }

    // =====================
    // CSV EXPORT
    // =====================
    function exportCSV() {
        if (state.results.length === 0) { alert('No results'); return; }
        const hdr = ['Nickname','Age','Gender','Role','Location','Profile URL'];
        const rows = state.results.map(p => [
            p.nickname, p.age||'', p.gender||'', p.role||'', p.location||'', p.url
        ]);
        const csv = [hdr, ...rows].map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'fetlife-' + new Date().toISOString().slice(0,10) + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        log('Exported ' + state.results.length + ' results');
    }

    function esc(s) {
        return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
    }

    // =====================
    // INIT
    // =====================
    if (location.hostname === 'fetlife.com') {
        buildUI();
        log('ASL Search v4 loaded on ' + location.href);
    }
})();
