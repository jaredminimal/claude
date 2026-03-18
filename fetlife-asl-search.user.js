// ==UserScript==
// @name           FetLife ASL Search (Modern Edition)
// @version        3.0.0
// @namespace      https://github.com/jaredminimal/fetlife-asl-search
// @description    Search FetLife profiles by age, sex, location, and role. Crawls member lists with CSV export.
// @match          https://fetlife.com/*
// @grant          GM_addStyle
// @grant          GM.addStyle
// @run-at         document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------
    // Style injection
    // ---------------------
    const addStyle = (typeof GM !== 'undefined' && GM.addStyle)
        ? GM.addStyle.bind(GM)
        : (typeof GM_addStyle !== 'undefined' ? GM_addStyle : function (css) {
            const s = document.createElement('style');
            s.textContent = css;
            document.head.appendChild(s);
        });

    // ---------------------
    // State
    // ---------------------
    let searchState = {
        running: false,
        aborted: false,
        totalScanned: 0,
        totalMatches: 0,
        currentPage: 1,
        allResults: [],
        urlQueue: [],
        currentUrlIndex: 0,
    };

    // ---------------------
    // Styles
    // ---------------------
    addStyle(`
        #fl-asl-toggle {
            position: fixed; bottom: 20px; right: 20px; z-index: 100000;
            background: #c22; color: #fff; border: none; border-radius: 50%;
            width: 56px; height: 56px; font-size: 18px; font-weight: 700;
            cursor: pointer; box-shadow: 0 3px 12px rgba(0,0,0,0.4);
            transition: background 0.2s; display: flex; align-items: center;
            justify-content: center; line-height: 1;
        }
        #fl-asl-toggle:hover { background: #e33; }

        #fl-asl-panel {
            position: fixed; top: 10px; right: 10px; z-index: 100000;
            width: 460px; max-height: calc(100vh - 20px);
            background: #1a1a2e; color: #e0e0e0;
            border: 1px solid #444; border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px; display: none; flex-direction: column; overflow: hidden;
        }
        #fl-asl-panel.open { display: flex; }

        #fl-asl-panel .panel-header {
            background: #c22; color: #fff; padding: 10px 16px;
            font-weight: 600; font-size: 15px;
            display: flex; justify-content: space-between; align-items: center;
            flex-shrink: 0;
        }
        #fl-asl-panel .panel-header button {
            background: none; border: none; color: #fff;
            font-size: 20px; cursor: pointer; padding: 0 4px;
        }
        #fl-asl-panel .panel-body {
            padding: 14px; overflow-y: auto; flex: 1;
        }
        #fl-asl-panel label.field-label {
            display: block; margin-bottom: 4px; font-weight: 500; color: #aaa;
            font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
        }
        #fl-asl-panel input[type="number"],
        #fl-asl-panel input[type="text"],
        #fl-asl-panel select,
        #fl-asl-panel textarea {
            width: 100%; padding: 7px 10px; margin-bottom: 10px;
            background: #16213e; border: 1px solid #333; border-radius: 6px;
            color: #e0e0e0; font-size: 13px; box-sizing: border-box;
            font-family: inherit;
        }
        #fl-asl-panel input:focus, #fl-asl-panel select:focus, #fl-asl-panel textarea:focus {
            outline: none; border-color: #c22;
        }
        #fl-asl-panel .checkbox-group {
            display: flex; flex-wrap: wrap; gap: 4px 8px; margin-bottom: 10px;
            max-height: 80px; overflow-y: auto; padding: 4px;
            background: #16213e; border-radius: 6px;
        }
        #fl-asl-panel .checkbox-group label {
            display: inline-flex; align-items: center; gap: 3px;
            text-transform: none; font-weight: normal; font-size: 12px;
            color: #ccc; margin-bottom: 0; cursor: pointer; letter-spacing: 0;
            white-space: nowrap;
        }
        #fl-asl-panel .checkbox-group input[type="checkbox"] { accent-color: #c22; }
        #fl-asl-panel .row { display: flex; gap: 10px; }
        #fl-asl-panel .row > div { flex: 1; }
        #fl-asl-panel .section-title {
            font-size: 11px; font-weight: 600; color: #888;
            text-transform: uppercase; letter-spacing: 1px;
            margin: 10px 0 6px; border-bottom: 1px solid #333; padding-bottom: 4px;
        }
        #fl-asl-panel .select-helpers {
            display: flex; gap: 8px; margin-bottom: 4px;
        }
        #fl-asl-panel .select-helpers a {
            color: #c22; font-size: 11px; cursor: pointer; text-decoration: none;
        }
        #fl-asl-panel .select-helpers a:hover { text-decoration: underline; }
        .fl-asl-btn {
            width: 100%; padding: 9px; border: none; border-radius: 6px;
            font-size: 14px; font-weight: 600; cursor: pointer;
            margin-top: 4px; transition: background 0.2s;
        }
        #fl-asl-btn-search { background: #c22; color: #fff; }
        #fl-asl-btn-search:hover { background: #e33; }
        #fl-asl-btn-search:disabled { background: #666; cursor: not-allowed; }
        #fl-asl-btn-stop { background: #555; color: #fff; display: none; margin-top: 6px; }
        #fl-asl-btn-stop:hover { background: #777; }
        #fl-asl-btn-export { background: #2a6; color: #fff; display: none; margin-top: 6px; }
        #fl-asl-btn-export:hover { background: #3b7; }
        #fl-asl-status {
            margin-top: 8px; padding: 6px 10px;
            background: #16213e; border-radius: 6px;
            font-size: 12px; color: #aaa; display: none; word-break: break-word;
        }
        #fl-asl-log {
            margin-top: 6px; padding: 6px 8px;
            background: #0d1117; border-radius: 6px;
            font-size: 11px; color: #7d8590; display: none;
            max-height: 80px; overflow-y: auto;
            font-family: monospace; word-break: break-all;
        }
        #fl-asl-results-count {
            margin-top: 8px; font-size: 12px; color: #888; display: none;
        }
        #fl-asl-results { margin-top: 8px; }
        .fl-asl-result {
            display: flex; gap: 8px; padding: 8px;
            background: #16213e; border-radius: 8px;
            margin-bottom: 6px; align-items: center;
            border: 1px solid #222; transition: border-color 0.2s;
        }
        .fl-asl-result:hover { border-color: #c22; }
        .fl-asl-result img {
            width: 44px; height: 44px; border-radius: 50%;
            object-fit: cover; flex-shrink: 0;
        }
        .fl-asl-result .info { flex: 1; min-width: 0; }
        .fl-asl-result .info a {
            color: #fff; text-decoration: none; font-weight: 600; font-size: 13px;
        }
        .fl-asl-result .info a:hover { text-decoration: underline; }
        .fl-asl-result .info .meta { color: #999; font-size: 11px; margin-top: 1px; }
        .fl-asl-result .actions { flex-shrink: 0; }
        .fl-asl-result .actions a {
            color: #c22; text-decoration: none; font-size: 11px;
        }
        .fl-asl-result .actions a:hover { text-decoration: underline; }
        #fl-asl-speed { width: 100%; accent-color: #c22; margin-bottom: 8px; }
        #fl-asl-tabs { display: flex; gap: 0; margin-bottom: 10px; }
        #fl-asl-tabs button {
            flex: 1; padding: 8px 4px; background: #16213e; border: 1px solid #333;
            color: #888; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s;
        }
        #fl-asl-tabs button:first-child { border-radius: 6px 0 0 6px; }
        #fl-asl-tabs button:last-child { border-radius: 0 6px 6px 0; }
        #fl-asl-tabs button.active { background: #c22; color: #fff; border-color: #c22; }
        .fl-asl-tab-content { display: none; }
        .fl-asl-tab-content.active { display: block; }
    `);

    // ---------------------
    // Gender / Role options
    // ---------------------
    const GENDERS = [
        'M', 'F', 'TM', 'TF', 'GF', 'GQ', 'NB', 'TG', 'CD/TV', 'IS',
        'Male', 'Female', 'Cis Man', 'Cis Woman', 'Trans Man', 'Trans Woman',
        'Gender Fluid', 'Genderqueer', 'Non-binary', 'Transgender',
        'Crossdresser/Transvestite', 'Intersex', 'Two-spirit', 'Agender',
        'Butch', 'Femme',
    ];

    const ROLES = [
        'Dominant', 'Domme', 'Dom', 'Switch', 'Submissive', 'Sub',
        'Master', 'Mistress', 'Slave', 'Top', 'Bottom', 'Sadist',
        'Masochist', 'Sadomasochist', 'Kinkster', 'Fetishist',
        'Hedonist', 'Exhibitionist', 'Voyeur', 'Rigger', 'Rope Bunny',
        'Daddy', 'Mommy', 'Boy', 'Girl', 'Brat', 'Brat Tamer',
        'Owner', 'Pet', 'Primal', 'Primal Hunter', 'Primal Prey',
        'Degrader', 'Degradee', 'Boss', 'Princess', 'Doll',
        'Puppy', 'Kitten', 'Pony', 'Captain', 'Swinger', 'Vanilla',
        'Unsure', 'Not Applicable', 'Stag', 'Vixen', 'Dom-leaning Switch',
        'Sub-leaning Switch', 'babygirl', 'babyboy',
    ];

    // ---------------------
    // Build UI
    // ---------------------
    function buildUI() {
        const toggle = document.createElement('button');
        toggle.id = 'fl-asl-toggle';
        toggle.textContent = 'ASL';
        toggle.title = 'FetLife ASL Search';
        document.body.appendChild(toggle);

        const panel = document.createElement('div');
        panel.id = 'fl-asl-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <span>ASL Search v3</span>
                <button id="fl-asl-close" title="Close">&times;</button>
            </div>
            <div class="panel-body">
                <div id="fl-asl-tabs">
                    <button class="active" data-tab="search">Search</button>
                    <button data-tab="results">Results</button>
                    <button data-tab="log">Debug Log</button>
                </div>

                <div class="fl-asl-tab-content active" id="fl-asl-tab-search">
                    <div class="section-title">Where to Search</div>
                    <label class="field-label">Mode</label>
                    <select id="fl-asl-source">
                        <option value="thispage">This Page (auto-detect kinksters list)</option>
                        <option value="url">Paste FetLife URL(s)</option>
                        <option value="search">Search by Keyword</option>
                    </select>
                    <div id="fl-asl-source-url" style="display:none;">
                        <label class="field-label">URL(s) - one per line</label>
                        <textarea id="fl-asl-url" rows="3" placeholder="https://fetlife.com/p/united-states/arizona/phoenix/kinksters"></textarea>
                    </div>
                    <div id="fl-asl-source-search" style="display:none;">
                        <label class="field-label">Keyword</label>
                        <input type="text" id="fl-asl-keyword" placeholder="e.g. a name or keyword">
                    </div>

                    <div class="section-title">Filters</div>
                    <div class="row">
                        <div>
                            <label class="field-label">Min Age</label>
                            <input type="number" id="fl-asl-age-min" min="18" max="99" value="18">
                        </div>
                        <div>
                            <label class="field-label">Max Age</label>
                            <input type="number" id="fl-asl-age-max" min="18" max="99" value="99">
                        </div>
                    </div>

                    <label class="field-label">Gender / Sex</label>
                    <div class="select-helpers" id="fl-asl-gender-helpers"></div>
                    <div class="checkbox-group" id="fl-asl-genders">
                        ${GENDERS.map(g => `<label><input type="checkbox" value="${g}" checked> ${g}</label>`).join('')}
                    </div>

                    <label class="field-label">Role</label>
                    <div class="select-helpers" id="fl-asl-role-helpers"></div>
                    <div class="checkbox-group" id="fl-asl-roles">
                        ${ROLES.map(r => `<label><input type="checkbox" value="${r}" checked> ${r}</label>`).join('')}
                    </div>

                    <label class="field-label">Location contains (optional)</label>
                    <input type="text" id="fl-asl-location" placeholder="e.g. Brooklyn, California, Canada">

                    <div class="section-title">Speed</div>
                    <label class="field-label">Delay: <span id="fl-asl-speed-label">4</span>s between requests</label>
                    <input type="range" id="fl-asl-speed" min="2" max="15" value="4" step="1">
                    <label class="field-label">Max pages per URL</label>
                    <input type="number" id="fl-asl-max-pages" min="1" max="500" value="50">

                    <button class="fl-asl-btn" id="fl-asl-btn-search">Search</button>
                    <button class="fl-asl-btn" id="fl-asl-btn-stop">Stop</button>
                    <div id="fl-asl-status"></div>
                </div>

                <div class="fl-asl-tab-content" id="fl-asl-tab-results">
                    <button class="fl-asl-btn" id="fl-asl-btn-export">Export to CSV</button>
                    <div id="fl-asl-results-count"></div>
                    <div id="fl-asl-results"></div>
                </div>

                <div class="fl-asl-tab-content" id="fl-asl-tab-log">
                    <p style="font-size:11px;color:#666;margin:0 0 6px;">
                        Shows what the script sees. Useful for troubleshooting.
                    </p>
                    <div id="fl-asl-log" style="display:block;max-height:none;height:400px;"></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        // Tab switching
        panel.querySelectorAll('#fl-asl-tabs button').forEach(btn => {
            btn.addEventListener('click', () => {
                panel.querySelectorAll('#fl-asl-tabs button').forEach(b => b.classList.remove('active'));
                panel.querySelectorAll('.fl-asl-tab-content').forEach(t => t.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('fl-asl-tab-' + btn.dataset.tab).classList.add('active');
            });
        });

        toggle.addEventListener('click', () => panel.classList.toggle('open'));
        document.getElementById('fl-asl-close').addEventListener('click', () => panel.classList.remove('open'));

        document.getElementById('fl-asl-source').addEventListener('change', function () {
            document.getElementById('fl-asl-source-url').style.display = this.value === 'url' ? '' : 'none';
            document.getElementById('fl-asl-source-search').style.display = this.value === 'search' ? '' : 'none';
        });

        document.getElementById('fl-asl-speed').addEventListener('input', function () {
            document.getElementById('fl-asl-speed-label').textContent = this.value;
        });

        addSelectHelpers('fl-asl-genders', 'fl-asl-gender-helpers');
        addSelectHelpers('fl-asl-roles', 'fl-asl-role-helpers');

        document.getElementById('fl-asl-btn-search').addEventListener('click', startSearch);
        document.getElementById('fl-asl-btn-stop').addEventListener('click', stopSearch);
        document.getElementById('fl-asl-btn-export').addEventListener('click', exportCSV);
    }

    function addSelectHelpers(checkboxGroupId, helperId) {
        const container = document.getElementById(checkboxGroupId);
        const helper = document.getElementById(helperId);
        ['All', 'None', 'Invert'].forEach(label => {
            const a = document.createElement('a');
            a.textContent = label;
            a.addEventListener('click', e => {
                e.preventDefault();
                container.querySelectorAll('input').forEach(cb => {
                    if (label === 'All') cb.checked = true;
                    else if (label === 'None') cb.checked = false;
                    else cb.checked = !cb.checked;
                });
            });
            helper.appendChild(a);
        });
    }

    // ---------------------
    // Logging
    // ---------------------
    function log(msg) {
        const el = document.getElementById('fl-asl-log');
        if (!el) return;
        const time = new Date().toLocaleTimeString();
        el.textContent += `[${time}] ${msg}\n`;
        el.scrollTop = el.scrollHeight;
        console.log('[ASL]', msg);
    }

    function updateStatus(msg) {
        const el = document.getElementById('fl-asl-status');
        el.style.display = '';
        el.textContent = msg;
        log(msg);
    }

    // ---------------------
    // Search params
    // ---------------------
    function getSearchParams() {
        return {
            ageMin: parseInt(document.getElementById('fl-asl-age-min').value) || 18,
            ageMax: parseInt(document.getElementById('fl-asl-age-max').value) || 99,
            genders: [...document.querySelectorAll('#fl-asl-genders input:checked')].map(cb => cb.value),
            roles: [...document.querySelectorAll('#fl-asl-roles input:checked')].map(cb => cb.value),
            locationFilter: document.getElementById('fl-asl-location').value.trim().toLowerCase(),
        };
    }

    function getDelay() {
        return (parseInt(document.getElementById('fl-asl-speed').value) || 4) * 1000;
    }

    function getMaxPages() {
        return parseInt(document.getElementById('fl-asl-max-pages').value) || 50;
    }

    // ---------------------
    // URL resolution
    // ---------------------
    function resolveURLs(callback) {
        const source = document.getElementById('fl-asl-source').value;

        if (source === 'search') {
            const kw = document.getElementById('fl-asl-keyword').value.trim();
            if (!kw) { alert('Please enter a search keyword.'); return; }
            callback(['https://fetlife.com/search/kinksters?q=' + encodeURIComponent(kw)]);
            return;
        }

        if (source === 'url') {
            const raw = document.getElementById('fl-asl-url').value.trim();
            if (!raw) { alert('Please enter one or more URLs.'); return; }
            const urls = raw.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
            if (urls.length === 0) { alert('No valid URLs. Each line should start with https://'); return; }
            callback(urls);
            return;
        }

        // 'thispage' mode
        const url = detectMemberListURL();
        if (url) callback([url]);
    }

    function detectMemberListURL() {
        const loc = window.location.href;
        log('Detecting from URL: ' + loc);

        // New /p/ format: /p/country/state/city/kinksters
        if (/\/p\/.*\/kinksters/.test(loc) || /\/kinksters/.test(loc) ||
            /\/group_memberships/.test(loc) || /\/rsvps/.test(loc) || /\/friends/.test(loc)) {
            const base = loc.split('?')[0].split('#')[0];
            log('On a member list page: ' + base);
            return base;
        }

        // On a place page without /kinksters
        if (/\/p\//.test(loc)) {
            const base = loc.split('?')[0].split('#')[0].replace(/\/$/, '') + '/kinksters';
            log('On a place page, appending /kinksters: ' + base);
            return base;
        }

        // Old format
        const patterns = [
            { regex: /(https:\/\/fetlife\.com\/(cities|administrative_areas|countries|places)\/\d+)/, suffix: '/kinksters' },
            { regex: /(https:\/\/fetlife\.com\/groups\/\d+)/, suffix: '/group_memberships' },
            { regex: /(https:\/\/fetlife\.com\/events\/\d+)/, suffix: '/rsvps' },
            { regex: /(https:\/\/fetlife\.com\/fetishes\/\d+)/, suffix: '/kinksters' },
            { regex: /(https:\/\/fetlife\.com\/users\/\d+)/, suffix: '/friends' },
        ];
        for (const p of patterns) {
            const m = loc.match(p.regex);
            if (m) {
                const url = m[1] + p.suffix;
                log('Detected old format: ' + url);
                return url;
            }
        }

        alert(
            'Could not detect a member list on this page.\n\n' +
            'Navigate to a place page first (e.g. click a city/state link),\n' +
            'or use "Paste FetLife URL(s)" mode.'
        );
        return null;
    }

    // ---------------------
    // Search orchestration
    // ---------------------
    function startSearch() {
        searchState = {
            running: true, aborted: false,
            totalScanned: 0, totalMatches: 0, currentPage: 1,
            allResults: [], urlQueue: [], currentUrlIndex: 0,
        };

        document.getElementById('fl-asl-results').innerHTML = '';
        document.getElementById('fl-asl-btn-search').disabled = true;
        document.getElementById('fl-asl-btn-stop').style.display = '';
        document.getElementById('fl-asl-btn-export').style.display = 'none';
        document.getElementById('fl-asl-results-count').style.display = 'none';
        document.getElementById('fl-asl-log').textContent = '';
        updateStatus('Resolving URLs...');

        resolveURLs(function (urls) {
            if (!urls || urls.length === 0) { stopSearch(); return; }
            searchState.urlQueue = urls;
            searchState.currentUrlIndex = 0;
            log('URLs to crawl: ' + JSON.stringify(urls));

            // For the FIRST page of the FIRST URL, if it matches the current page,
            // scrape the live DOM directly (guaranteed to have content)
            const currentBase = window.location.href.split('?')[0].split('#')[0];
            if (urls[0].split('?')[0].split('#')[0] === currentBase) {
                log('First URL matches current page — scraping live DOM for page 1');
                scrapeLiveDOM();
            } else {
                crawlNextURL();
            }
        });
    }

    function scrapeLiveDOM() {
        const profiles = extractProfilesFromDocument(document);
        log('Live DOM: extracted ' + profiles.length + ' profiles');

        if (profiles.length === 0) {
            log('No profiles found in live DOM. Will try fetching.');
            crawlNextURL();
            return;
        }

        const params = getSearchParams();
        for (const profile of profiles) {
            searchState.totalScanned++;
            if (matchesSearch(profile, params)) {
                searchState.totalMatches++;
                searchState.allResults.push(profile);
                displayResult(profile);
            }
        }

        updateResultsCount();
        updateStatus(`Page 1 (live): ${searchState.totalMatches} matches / ${searchState.totalScanned} scanned. Next page in ${getDelay() / 1000}s...`);

        // Continue with page 2 via fetch
        searchState.currentPage = 2;
        setTimeout(() => crawlPage(searchState.urlQueue[0], 2), getDelay());
    }

    function crawlNextURL() {
        if (searchState.aborted) return;
        if (searchState.currentUrlIndex >= searchState.urlQueue.length) {
            finishSearch();
            return;
        }
        const url = searchState.urlQueue[searchState.currentUrlIndex];
        log('Crawling URL ' + (searchState.currentUrlIndex + 1) + '/' + searchState.urlQueue.length + ': ' + url);
        searchState.currentPage = 1;
        crawlPage(url, 1);
    }

    function stopSearch() {
        searchState.aborted = true;
        searchState.running = false;
        document.getElementById('fl-asl-btn-search').disabled = false;
        document.getElementById('fl-asl-btn-stop').style.display = 'none';
        if (searchState.allResults.length > 0) {
            document.getElementById('fl-asl-btn-export').style.display = '';
        }
        updateStatus(`Stopped. ${searchState.totalMatches} matches / ${searchState.totalScanned} scanned.`);
        updateResultsCount();
    }

    function finishSearch() {
        searchState.running = false;
        document.getElementById('fl-asl-btn-search').disabled = false;
        document.getElementById('fl-asl-btn-stop').style.display = 'none';
        if (searchState.allResults.length > 0) {
            document.getElementById('fl-asl-btn-export').style.display = '';
        }
        updateStatus(`Done! ${searchState.totalMatches} matches / ${searchState.totalScanned} scanned.`);
        updateResultsCount();
        document.querySelector('#fl-asl-tabs button[data-tab="results"]').click();
    }

    function updateResultsCount() {
        const el = document.getElementById('fl-asl-results-count');
        el.style.display = '';
        el.textContent = `${searchState.totalMatches} matches from ${searchState.totalScanned} profiles scanned`;
    }

    // ---------------------
    // Fetch pages using window.fetch (includes session cookies)
    // ---------------------
    function crawlPage(baseURL, page) {
        if (searchState.aborted) return;
        if (page > getMaxPages()) {
            log('Reached max pages (' + getMaxPages() + ').');
            searchState.currentUrlIndex++;
            setTimeout(crawlNextURL, getDelay());
            return;
        }

        const sep = baseURL.includes('?') ? '&' : '?';
        const url = baseURL + sep + 'page=' + page;
        updateStatus(`[${searchState.currentUrlIndex + 1}/${searchState.urlQueue.length}] Page ${page}... (${searchState.totalMatches} matches / ${searchState.totalScanned} scanned)`);

        // Use window.fetch — this includes session cookies so we get the full page
        fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            headers: {
                'Accept': 'text/html,application/xhtml+xml',
            },
        })
        .then(response => {
            if (searchState.aborted) return null;
            log('HTTP ' + response.status + ' for ' + url);

            if (response.status === 403 || response.status === 429) {
                updateStatus('Rate limited (HTTP ' + response.status + '). Increase delay and try later.');
                stopSearch();
                return null;
            }
            if (!response.ok) {
                updateStatus('Error: HTTP ' + response.status);
                stopSearch();
                return null;
            }
            return response.text();
        })
        .then(html => {
            if (!html || searchState.aborted) return;

            log('Response: ' + html.length + ' bytes');

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const profiles = extractProfilesFromDocument(doc);
            log('Extracted ' + profiles.length + ' profiles from page ' + page);

            if (profiles.length === 0) {
                // Check if we got a "no results" page or just an empty page
                const bodyText = doc.body ? doc.body.textContent.trim() : '';
                if (bodyText.includes("You shouldn't see this")) {
                    log('WARNING: Got empty shell page. FetLife may be blocking fetch requests.');
                    log('Trying alternative fetch method...');
                    crawlPageViaIframe(baseURL, page);
                    return;
                }
                log('No profiles on page ' + page + '. Moving to next URL.');
                searchState.currentUrlIndex++;
                setTimeout(crawlNextURL, getDelay());
                return;
            }

            const params = getSearchParams();
            for (const profile of profiles) {
                searchState.totalScanned++;
                if (matchesSearch(profile, params)) {
                    searchState.totalMatches++;
                    searchState.allResults.push(profile);
                    displayResult(profile);
                }
            }

            updateResultsCount();
            updateStatus(`Page ${page}: ${searchState.totalMatches} matches / ${searchState.totalScanned} scanned. Next in ${getDelay() / 1000}s...`);
            searchState.currentPage = page + 1;
            setTimeout(() => crawlPage(baseURL, page + 1), getDelay());
        })
        .catch(err => {
            log('Fetch error: ' + err.message);
            updateStatus('Network error. Retrying in 10s...');
            setTimeout(() => crawlPage(baseURL, page), 10000);
        });
    }

    // ---------------------
    // Fallback: load page in a hidden iframe to get JS-rendered content
    // ---------------------
    function crawlPageViaIframe(baseURL, page) {
        if (searchState.aborted) return;

        const sep = baseURL.includes('?') ? '&' : '?';
        const url = baseURL + sep + 'page=' + page;
        log('Iframe fallback for: ' + url);

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1024px;height:768px;opacity:0;pointer-events:none;';
        iframe.src = url;

        let loaded = false;
        const timeout = setTimeout(() => {
            if (!loaded) {
                log('Iframe timeout for page ' + page);
                cleanup();
                searchState.currentUrlIndex++;
                setTimeout(crawlNextURL, getDelay());
            }
        }, 30000);

        function cleanup() {
            loaded = true;
            clearTimeout(timeout);
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }

        iframe.addEventListener('load', () => {
            if (loaded || searchState.aborted) { cleanup(); return; }

            // Wait a bit for JS to render content
            setTimeout(() => {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const profiles = extractProfilesFromDocument(iframeDoc);
                    log('Iframe: extracted ' + profiles.length + ' profiles from page ' + page);

                    if (profiles.length === 0) {
                        log('Iframe also found 0 profiles. Page may be empty or blocked.');
                        cleanup();
                        searchState.currentUrlIndex++;
                        setTimeout(crawlNextURL, getDelay());
                        return;
                    }

                    const params = getSearchParams();
                    for (const profile of profiles) {
                        searchState.totalScanned++;
                        if (matchesSearch(profile, params)) {
                            searchState.totalMatches++;
                            searchState.allResults.push(profile);
                            displayResult(profile);
                        }
                    }

                    updateResultsCount();
                    cleanup();
                    updateStatus(`Page ${page} (iframe): ${searchState.totalMatches} matches / ${searchState.totalScanned}. Next in ${getDelay() / 1000}s...`);
                    searchState.currentPage = page + 1;
                    setTimeout(() => crawlPageViaIframe(baseURL, page + 1), getDelay());
                } catch (e) {
                    log('Iframe access error: ' + e.message);
                    cleanup();
                    // If cross-origin error, fall back to scraping current page only
                    updateStatus('Cannot access iframe content. Only live page scraping is available.');
                    stopSearch();
                }
            }, 3000); // Wait 3s for content to render
        });

        document.body.appendChild(iframe);
    }

    // ---------------------
    // Profile extraction from any document
    // ---------------------
    function extractProfilesFromDocument(doc) {
        const profiles = [];
        const seen = new Set();

        // Find all user profile links, excluding nav/header
        const allLinks = doc.querySelectorAll('a[href*="/users/"]');
        log('  Total /users/ links found: ' + allLinks.length);

        // First pass: identify the user links that are in the main content (not nav)
        const userEntries = [];
        for (const link of allLinks) {
            const href = link.getAttribute('href') || '';
            const idMatch = href.match(/\/users\/(\d+)/);
            if (!idMatch) continue;

            // Skip nav/header links
            if (link.closest('nav, header, [class*="fl-nav"], footer')) continue;

            const userId = idMatch[1];
            if (seen.has(userId)) continue;
            seen.add(userId);

            userEntries.push({ link, userId });
        }

        log('  Unique user links in main content: ' + userEntries.length);

        for (const entry of userEntries) {
            const profile = extractProfileFromLink(entry.link, entry.userId, doc);
            if (profile) {
                profiles.push(profile);
                if (profiles.length <= 3) {
                    log('  Sample: ' + JSON.stringify(profile));
                }
            }
        }

        return profiles;
    }

    /**
     * Given a link to /users/ID, look at its surrounding context to extract profile data.
     *
     * From the screenshot, FetLife's current kinkster list format is:
     *   [Avatar]  NickName  25F Princess       [Follow]
     *             Phoenix, Arizona
     *             72 Pics · 10 Vids · 2 Writings
     *
     * The text next to the nickname contains: Age + Gender abbreviation + Role
     * e.g. "25F Princess", "46M Kinkster", "32M Dom-leaning Switch", "36TW Bottom"
     */
    function extractProfileFromLink(link, userId, doc) {
        try {
            // The nickname link text
            let nickname = link.textContent.trim();
            // If the link contains just an image (avatar), the text might be empty
            if (!nickname || nickname.length > 60) {
                // Try to find a text link to this user nearby
                const allUserLinks = doc.querySelectorAll('a[href*="/users/' + userId + '"]');
                for (const a of allUserLinks) {
                    const t = a.textContent.trim();
                    if (t && t.length > 0 && t.length < 60 && !a.querySelector('img')) {
                        nickname = t;
                        break;
                    }
                }
            }
            if (!nickname) nickname = 'User ' + userId;

            // Find avatar
            let avatarUrl = '';
            const allUserLinks = doc.querySelectorAll('a[href*="/users/' + userId + '"]');
            for (const a of allUserLinks) {
                const img = a.querySelector('img');
                if (img && img.src) {
                    avatarUrl = img.src;
                    break;
                }
            }

            // Walk up from the link to find the containing "card" / row
            // We want the element that contains ONE user's info
            let container = link.parentElement;
            for (let i = 0; i < 8 && container; i++) {
                const userLinksInside = container.querySelectorAll('a[href*="/users/"]');
                const uniqueIds = new Set();
                for (const a of userLinksInside) {
                    const m = (a.getAttribute('href') || '').match(/\/users\/(\d+)/);
                    if (m) uniqueIds.add(m[1]);
                }
                // If this container has exactly 1 user and is big enough, use it
                if (uniqueIds.size === 1 && container.textContent.length > 10) {
                    // Keep going up a bit more if the parent also has only this user
                    const parent = container.parentElement;
                    if (parent) {
                        const parentIds = new Set();
                        for (const a of parent.querySelectorAll('a[href*="/users/"]')) {
                            const m = (a.getAttribute('href') || '').match(/\/users\/(\d+)/);
                            if (m) parentIds.add(m[1]);
                        }
                        if (parentIds.size === 1) {
                            container = parent;
                            continue;
                        }
                    }
                    break;
                }
                if (uniqueIds.size > 1) {
                    // Gone too far, step back
                    container = container.children.length > 0 ? link.parentElement : container;
                    break;
                }
                container = container.parentElement;
            }

            if (!container) container = link.parentElement;

            // Get all text content from the container
            const fullText = container.textContent.trim();

            // Extract location from location links in the container
            let location = '';
            const locLinks = container.querySelectorAll(
                'a[href*="/p/"], a[href*="/cities/"], a[href*="/administrative_areas/"], a[href*="/countries/"]'
            );
            const locParts = [];
            for (const ll of locLinks) {
                const t = ll.textContent.trim();
                if (t && !locParts.includes(t)) locParts.push(t);
            }
            location = locParts.join(', ');

            // If no location links found, try to find location-like text
            // (city, state pattern — capitalized words separated by comma)
            if (!location) {
                const locMatch = fullText.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
                if (locMatch) location = locMatch[0];
            }

            // Parse the age/gender/role info
            // Format from screenshot: "25F Princess", "46M Kinkster", "55M Dom-leaning Switch"
            // This appears as text near the nickname
            const aslInfo = parseASLFromText(fullText, nickname);

            return {
                userId: userId,
                nickname: nickname,
                age: aslInfo.age,
                gender: aslInfo.gender,
                role: aslInfo.role,
                location: location,
                avatarUrl: avatarUrl,
                profileUrl: 'https://fetlife.com/users/' + userId,
            };
        } catch (e) {
            log('Error extracting profile for user ' + userId + ': ' + e.message);
            return null;
        }
    }

    /**
     * Parse age, gender, and role from text like "25F Princess" or "32M Dom-leaning Switch"
     *
     * FetLife abbreviations (from screenshot):
     *   M = Male, F = Female, TM = Trans Man, TF = Trans Female,
     *   TW = Trans Woman, GF = Gender Fluid, GQ = Genderqueer,
     *   NB = Non-binary, CD/TV = Crossdresser, FEM = Femme, etc.
     */
    function parseASLFromText(text, nickname) {
        let age = null, gender = '', role = '';

        // Look for the pattern: number + gender abbreviation + role
        // e.g. "25F Princess", "46M Kinkster", "55M Dom-leaning Switch", "36GTW Bottom"
        // The pattern appears after or near the nickname in the text

        // Try specific FetLife format: digits immediately followed by gender code then space then role
        // Pattern: \b(\d{2})([A-Z]{1,4})\s+(.+?)(?:\s*\d+\s*Pics|\s*Follow|$)
        const aslPattern = /\b(\d{2})(M|F|TM|TF|TW|GF|GQ|NB|CD\/TV|FEM|BUT|IS|AG|TS|CD|TG|MTF|FTM|CF|CM)\s+(.+?)(?:\s*\d+\s*Pics|\s*\d+\s*Vids|\s*\d+\s*Writings|\s*Follow|\s*Phoenix|\s*[A-Z][a-z]+,\s*[A-Z]|$)/i;
        const m = text.match(aslPattern);

        if (m) {
            age = parseInt(m[1]);
            gender = expandGender(m[2].toUpperCase());
            role = m[3].trim();
            // Clean up role - remove trailing noise
            role = role.replace(/\s*(Follow|Phoenix|[A-Z][a-z]+,\s*[A-Z][a-z]+|\d+\s*Pics).*$/i, '').trim();
        } else {
            // Fallback: look for any 2-digit number as age
            const ageMatch = text.match(/\b([1-9]\d)\b/);
            if (ageMatch) {
                const n = parseInt(ageMatch[1]);
                if (n >= 18 && n <= 99) age = n;
            }

            // Look for gender keywords
            const genderTerms = [
                'Crossdresser/Transvestite', 'Gender Fluid', 'Genderqueer',
                'Non-binary', 'Cis Man', 'Cis Woman', 'Trans Man', 'Trans Woman',
                'Transgender', 'Intersex', 'Two-spirit', 'Agender', 'Butch', 'Femme',
                'Male', 'Female',
            ];
            for (const term of genderTerms) {
                if (text.toLowerCase().includes(term.toLowerCase())) {
                    gender = term;
                    break;
                }
            }

            // Look for role keywords
            for (const term of ROLES) {
                const regex = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
                if (regex.test(text)) {
                    role = term;
                    break;
                }
            }
        }

        return { age, gender, role };
    }

    function expandGender(code) {
        const map = {
            'M': 'Male', 'F': 'Female', 'TM': 'Trans Man', 'TF': 'Trans Female',
            'TW': 'Trans Woman', 'GF': 'Gender Fluid', 'GQ': 'Genderqueer',
            'NB': 'Non-binary', 'CD/TV': 'Crossdresser/Transvestite',
            'CD': 'Crossdresser', 'TG': 'Transgender', 'FEM': 'Femme',
            'BUT': 'Butch', 'IS': 'Intersex', 'AG': 'Agender', 'TS': 'Two-spirit',
            'MTF': 'Trans Woman', 'FTM': 'Trans Man', 'CF': 'Cis Woman', 'CM': 'Cis Man',
        };
        return map[code] || code;
    }

    // ---------------------
    // Matching
    // ---------------------
    function matchesSearch(profile, params) {
        // Age
        if (profile.age !== null) {
            if (params.ageMin && profile.age < params.ageMin) return false;
            if (params.ageMax && profile.age > params.ageMax) return false;
        }

        // Gender (skip if all checked)
        if (params.genders.length > 0 && params.genders.length < GENDERS.length && profile.gender) {
            const g = profile.gender.toLowerCase();
            const match = params.genders.some(sg => {
                const s = sg.toLowerCase();
                return g === s || g.includes(s) || s.includes(g);
            });
            if (!match) return false;
        }

        // Role (skip if all checked)
        if (params.roles.length > 0 && params.roles.length < ROLES.length && profile.role) {
            const r = profile.role.toLowerCase();
            const match = params.roles.some(sr => {
                const s = sr.toLowerCase();
                return r === s || r.includes(s) || s.includes(r);
            });
            if (!match) return false;
        }

        // Location
        if (params.locationFilter) {
            const loc = (profile.location || '').toLowerCase();
            if (!loc.includes(params.locationFilter)) return false;
        }

        return true;
    }

    // ---------------------
    // Display
    // ---------------------
    function displayResult(profile) {
        const container = document.getElementById('fl-asl-results');
        const div = document.createElement('div');
        div.className = 'fl-asl-result';

        const avatarHTML = profile.avatarUrl
            ? `<img src="${esc(profile.avatarUrl)}" alt="" loading="lazy">`
            : `<div style="width:44px;height:44px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#666;font-size:18px;">?</div>`;

        const meta = [profile.age || '', profile.gender || '', profile.role || ''].filter(Boolean).join(' / ');

        div.innerHTML = `
            ${avatarHTML}
            <div class="info">
                <a href="${esc(profile.profileUrl)}" target="_blank">${esc(profile.nickname)}</a>
                ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
                ${profile.location ? `<div class="meta">${esc(profile.location)}</div>` : ''}
            </div>
            <div class="actions">
                <a href="https://fetlife.com/conversations/new?with=${esc(profile.userId)}" target="_blank">Msg</a>
            </div>
        `;
        container.appendChild(div);
    }

    // ---------------------
    // CSV Export
    // ---------------------
    function exportCSV() {
        if (searchState.allResults.length === 0) { alert('No results to export.'); return; }

        const headers = ['Nickname', 'Age', 'Gender', 'Role', 'Location', 'Profile URL', 'Message URL'];
        const rows = searchState.allResults.map(p => [
            p.nickname, p.age || '', p.gender || '', p.role || '', p.location || '',
            p.profileUrl, 'https://fetlife.com/conversations/new?with=' + p.userId,
        ]);

        const csv = [headers, ...rows]
            .map(row => row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(','))
            .join('\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fetlife-results-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        log('Exported ' + searchState.allResults.length + ' results to CSV');
    }

    function esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    // ---------------------
    // Init
    // ---------------------
    if (window.location.hostname === 'fetlife.com') {
        buildUI();
        log('ASL Search v3 loaded on ' + window.location.href);
    }

})();
