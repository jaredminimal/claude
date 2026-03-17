// ==UserScript==
// @name           FetLife ASL Search (Modern Edition)
// @version        1.0.0
// @namespace      https://github.com/jaredminimal/fetlife-asl-search
// @description    Search FetLife profiles by age, sex, location, and role. Modern rewrite compatible with current FetLife.
// @match          https://fetlife.com/*
// @grant          GM_xmlhttpRequest
// @grant          GM_addStyle
// @grant          GM.xmlHttpRequest
// @grant          GM.addStyle
// @connect        fetlife.com
// @run-at         document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------
    // Compatibility layer
    // ---------------------
    const gmXHR = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
        ? GM.xmlHttpRequest.bind(GM)
        : (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null);

    const gmAddStyle = (typeof GM !== 'undefined' && GM.addStyle)
        ? GM.addStyle.bind(GM)
        : (typeof GM_addStyle !== 'undefined' ? GM_addStyle : function (css) {
            const s = document.createElement('style');
            s.textContent = css;
            document.head.appendChild(s);
        });

    // ---------------------
    // Configuration
    // ---------------------
    const CONFIG = {
        // Delay between page fetches (ms). Higher = safer from bans.
        searchDelay: 4000,
        // Max pages to crawl per search
        maxPages: 50,
        // Results per batch before pausing
        resultsPerPage: 20,
    };

    // ---------------------
    // State
    // ---------------------
    let searchState = {
        running: false,
        aborted: false,
        totalScanned: 0,
        totalMatches: 0,
        currentPage: 1,
    };

    // ---------------------
    // Styles
    // ---------------------
    gmAddStyle(`
        #fl-asl-toggle {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 100000;
            background: #c22;
            color: #fff;
            border: none;
            border-radius: 50%;
            width: 56px;
            height: 56px;
            font-size: 22px;
            cursor: pointer;
            box-shadow: 0 3px 12px rgba(0,0,0,0.4);
            transition: background 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #fl-asl-toggle:hover { background: #e33; }

        #fl-asl-panel {
            position: fixed;
            bottom: 86px;
            right: 20px;
            z-index: 100000;
            width: 420px;
            max-height: 80vh;
            background: #1a1a2e;
            color: #e0e0e0;
            border: 1px solid #444;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px;
            display: none;
            flex-direction: column;
            overflow: hidden;
        }
        #fl-asl-panel.open { display: flex; }

        #fl-asl-panel .panel-header {
            background: #c22;
            color: #fff;
            padding: 12px 16px;
            font-weight: 600;
            font-size: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        #fl-asl-panel .panel-header button {
            background: none;
            border: none;
            color: #fff;
            font-size: 20px;
            cursor: pointer;
            padding: 0 4px;
        }

        #fl-asl-panel .panel-body {
            padding: 16px;
            overflow-y: auto;
            flex: 1;
        }

        #fl-asl-panel label {
            display: block;
            margin-bottom: 4px;
            font-weight: 500;
            color: #aaa;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        #fl-asl-panel input[type="number"],
        #fl-asl-panel input[type="text"],
        #fl-asl-panel select {
            width: 100%;
            padding: 8px 10px;
            margin-bottom: 12px;
            background: #16213e;
            border: 1px solid #333;
            border-radius: 6px;
            color: #e0e0e0;
            font-size: 14px;
            box-sizing: border-box;
        }
        #fl-asl-panel input:focus,
        #fl-asl-panel select:focus {
            outline: none;
            border-color: #c22;
        }

        #fl-asl-panel .checkbox-group {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 12px;
        }
        #fl-asl-panel .checkbox-group label {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            text-transform: none;
            font-weight: normal;
            font-size: 13px;
            color: #ccc;
            margin-bottom: 0;
            cursor: pointer;
            letter-spacing: 0;
        }
        #fl-asl-panel .checkbox-group input[type="checkbox"] {
            accent-color: #c22;
        }

        #fl-asl-panel .row {
            display: flex;
            gap: 12px;
        }
        #fl-asl-panel .row > div { flex: 1; }

        #fl-asl-panel .section-title {
            font-size: 11px;
            font-weight: 600;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin: 8px 0 8px;
            border-bottom: 1px solid #333;
            padding-bottom: 4px;
        }

        #fl-asl-btn-search {
            width: 100%;
            padding: 10px;
            background: #c22;
            color: #fff;
            border: none;
            border-radius: 6px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 4px;
            transition: background 0.2s;
        }
        #fl-asl-btn-search:hover { background: #e33; }
        #fl-asl-btn-search:disabled { background: #666; cursor: not-allowed; }

        #fl-asl-btn-stop {
            width: 100%;
            padding: 10px;
            background: #555;
            color: #fff;
            border: none;
            border-radius: 6px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 8px;
            display: none;
        }
        #fl-asl-btn-stop:hover { background: #777; }

        #fl-asl-status {
            margin-top: 10px;
            padding: 8px 10px;
            background: #16213e;
            border-radius: 6px;
            font-size: 13px;
            color: #aaa;
            display: none;
        }

        #fl-asl-results {
            margin-top: 12px;
        }
        .fl-asl-result {
            display: flex;
            gap: 10px;
            padding: 10px;
            background: #16213e;
            border-radius: 8px;
            margin-bottom: 8px;
            align-items: center;
            border: 1px solid #222;
            transition: border-color 0.2s;
        }
        .fl-asl-result:hover { border-color: #c22; }
        .fl-asl-result img {
            width: 50px;
            height: 50px;
            border-radius: 50%;
            object-fit: cover;
            flex-shrink: 0;
        }
        .fl-asl-result .info { flex: 1; min-width: 0; }
        .fl-asl-result .info a {
            color: #fff;
            text-decoration: none;
            font-weight: 600;
            font-size: 14px;
        }
        .fl-asl-result .info a:hover { text-decoration: underline; }
        .fl-asl-result .info .meta {
            color: #999;
            font-size: 12px;
            margin-top: 2px;
        }
        .fl-asl-result .actions a {
            color: #c22;
            text-decoration: none;
            font-size: 12px;
        }
        .fl-asl-result .actions a:hover { text-decoration: underline; }

        #fl-asl-speed {
            width: 100%;
            margin-bottom: 12px;
            accent-color: #c22;
        }
    `);

    // ---------------------
    // Gender / Role options
    // ---------------------
    const GENDERS = [
        'Male', 'Female', 'Transgender', 'Trans - Male/Man',
        'Trans - Female/Woman', 'Gender Fluid', 'Genderqueer',
        'Non-binary', 'Crossdresser/Transvestite', 'Intersex',
        'Two-spirit', 'Agender', 'Butch', 'Femme', 'Cis Man',
        'Cis Woman', 'Trans Man', 'Trans Woman',
    ];

    const ROLES = [
        'Dominant', 'Domme', 'Dom', 'Switch', 'Submissive', 'Sub',
        'Master', 'Mistress', 'Slave', 'Top', 'Bottom', 'Sadist',
        'Masochist', 'Sadomasochist', 'Kinkster', 'Fetishist',
        'Hedonist', 'Exhibitionist', 'Voyeur', 'Rigger', 'Rope Bunny',
        'Daddy', 'Mommy', 'Boy', 'Girl', 'Brat', 'Brat Tamer',
        'Owner', 'Pet', 'Primal', 'Primal Hunter', 'Primal Prey',
        'Degrader', 'Degradee', 'Boss', 'Princess', 'Doll',
        'Puppy', 'Kitten', 'Pony', 'Latex Fetishist', 'Leather Fetishist',
        'Captain', 'Swinger', 'Vanilla', 'Unsure', 'Not Applicable',
    ];

    // ---------------------
    // Build UI
    // ---------------------
    function buildUI() {
        // Floating toggle button
        const toggle = document.createElement('button');
        toggle.id = 'fl-asl-toggle';
        toggle.textContent = 'A/S/L';
        toggle.title = 'FetLife ASL Search';
        document.body.appendChild(toggle);

        // Panel
        const panel = document.createElement('div');
        panel.id = 'fl-asl-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <span>ASL Search</span>
                <button id="fl-asl-close" title="Close">&times;</button>
            </div>
            <div class="panel-body">
                <div class="section-title">Search Source</div>
                <label>Search In</label>
                <select id="fl-asl-source">
                    <option value="location">Current Location Page (browse to a city/region first)</option>
                    <option value="search">FetLife Search by Keyword</option>
                    <option value="url">Custom URL</option>
                </select>
                <div id="fl-asl-keyword-wrap" style="display:none;">
                    <label>Keyword</label>
                    <input type="text" id="fl-asl-keyword" placeholder="e.g. a username or keyword">
                </div>
                <div id="fl-asl-url-wrap" style="display:none;">
                    <label>URL (kinksters list page)</label>
                    <input type="text" id="fl-asl-url" placeholder="https://fetlife.com/cities/1234/kinksters">
                </div>

                <div class="section-title">Age</div>
                <div class="row">
                    <div>
                        <label>Min Age</label>
                        <input type="number" id="fl-asl-age-min" min="18" max="99" value="18">
                    </div>
                    <div>
                        <label>Max Age</label>
                        <input type="number" id="fl-asl-age-max" min="18" max="99" value="99">
                    </div>
                </div>

                <div class="section-title">Gender / Sex</div>
                <div class="checkbox-group" id="fl-asl-genders">
                    ${GENDERS.map(g => `<label><input type="checkbox" value="${g}" checked> ${g}</label>`).join('')}
                </div>

                <div class="section-title">Role</div>
                <div class="checkbox-group" id="fl-asl-roles">
                    ${ROLES.map(r => `<label><input type="checkbox" value="${r}" checked> ${r}</label>`).join('')}
                </div>

                <div class="section-title">Location Filter</div>
                <label>Contains text (optional)</label>
                <input type="text" id="fl-asl-location" placeholder="e.g. New York, California, US">

                <div class="section-title">Speed</div>
                <label>Delay between requests: <span id="fl-asl-speed-label">4</span>s</label>
                <input type="range" id="fl-asl-speed" min="2" max="15" value="4" step="1">

                <button id="fl-asl-btn-search">Search</button>
                <button id="fl-asl-btn-stop">Stop Search</button>
                <div id="fl-asl-status"></div>
                <div id="fl-asl-results"></div>
            </div>
        `;
        document.body.appendChild(panel);

        // Events
        toggle.addEventListener('click', () => panel.classList.toggle('open'));
        document.getElementById('fl-asl-close').addEventListener('click', () => panel.classList.remove('open'));

        const sourceSelect = document.getElementById('fl-asl-source');
        sourceSelect.addEventListener('change', () => {
            document.getElementById('fl-asl-keyword-wrap').style.display =
                sourceSelect.value === 'search' ? '' : 'none';
            document.getElementById('fl-asl-url-wrap').style.display =
                sourceSelect.value === 'url' ? '' : 'none';
        });

        const speedSlider = document.getElementById('fl-asl-speed');
        speedSlider.addEventListener('input', () => {
            document.getElementById('fl-asl-speed-label').textContent = speedSlider.value;
        });

        // Select All / None helpers
        addSelectHelpers('fl-asl-genders', 'Gender');
        addSelectHelpers('fl-asl-roles', 'Role');

        document.getElementById('fl-asl-btn-search').addEventListener('click', startSearch);
        document.getElementById('fl-asl-btn-stop').addEventListener('click', stopSearch);
    }

    function addSelectHelpers(containerId, label) {
        const container = document.getElementById(containerId);
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'width:100%; margin-bottom: 4px; display:flex; gap:8px;';
        const btnAll = document.createElement('a');
        btnAll.href = '#';
        btnAll.textContent = 'Select All';
        btnAll.style.cssText = 'color:#c22; font-size:12px; cursor:pointer;';
        btnAll.addEventListener('click', e => {
            e.preventDefault();
            container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        });
        const btnNone = document.createElement('a');
        btnNone.href = '#';
        btnNone.textContent = 'Select None';
        btnNone.style.cssText = 'color:#c22; font-size:12px; cursor:pointer;';
        btnNone.addEventListener('click', e => {
            e.preventDefault();
            container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        });
        wrapper.append(btnAll, btnNone);
        container.parentNode.insertBefore(wrapper, container);
    }

    // ---------------------
    // Search logic
    // ---------------------
    function getSearchParams() {
        return {
            ageMin: parseInt(document.getElementById('fl-asl-age-min').value) || 18,
            ageMax: parseInt(document.getElementById('fl-asl-age-max').value) || 99,
            genders: [...document.querySelectorAll('#fl-asl-genders input:checked')].map(cb => cb.value.toLowerCase()),
            roles: [...document.querySelectorAll('#fl-asl-roles input:checked')].map(cb => cb.value.toLowerCase()),
            locationFilter: document.getElementById('fl-asl-location').value.trim().toLowerCase(),
        };
    }

    function getStartURL() {
        const source = document.getElementById('fl-asl-source').value;
        if (source === 'search') {
            const kw = document.getElementById('fl-asl-keyword').value.trim();
            if (!kw) { alert('Please enter a search keyword.'); return null; }
            return 'https://fetlife.com/search/kinksters?q=' + encodeURIComponent(kw);
        }
        if (source === 'url') {
            const url = document.getElementById('fl-asl-url').value.trim();
            if (!url) { alert('Please enter a URL.'); return null; }
            return url;
        }
        // 'location' mode: detect from current page URL
        const loc = window.location.href;
        const locationPatterns = [
            /fetlife\.com\/cities\/\d+/,
            /fetlife\.com\/administrative_areas\/\d+/,
            /fetlife\.com\/countries\/\d+/,
            /fetlife\.com\/places\/\d+/,
            /fetlife\.com\/groups\/\d+/,
            /fetlife\.com\/events\/\d+/,
            /fetlife\.com\/users\/\d+\/friends/,
            /fetlife\.com\/fetishes\/\d+/,
        ];
        for (const pat of locationPatterns) {
            const m = loc.match(pat);
            if (m) {
                let base = m[0];
                if (!base.startsWith('https://')) base = 'https://' + base;
                // Append /kinksters if it's a location page
                if (/\/(cities|administrative_areas|countries|places)\/\d+$/.test(base)) {
                    base += '/kinksters';
                }
                if (/\/groups\/\d+$/.test(base)) {
                    base += '/group_memberships';
                }
                if (/\/events\/\d+$/.test(base)) {
                    base += '/rsvps';
                }
                if (/\/fetishes\/\d+$/.test(base)) {
                    base += '/kinksters';
                }
                return base;
            }
        }
        // Fallback: try current URL if it looks like a kinksters page
        if (/\/kinksters/.test(loc) || /\/group_memberships/.test(loc) || /\/rsvps/.test(loc) || /\/friends/.test(loc)) {
            return loc.split('?')[0];
        }
        alert('Cannot detect a member list on this page.\n\nEither:\n- Navigate to a city/region/country page first\n- Use "FetLife Search by Keyword" mode\n- Use "Custom URL" mode with a direct link to a kinksters list');
        return null;
    }

    function startSearch() {
        const url = getStartURL();
        if (!url) return;

        searchState = { running: true, aborted: false, totalScanned: 0, totalMatches: 0, currentPage: 1 };
        document.getElementById('fl-asl-results').innerHTML = '';
        document.getElementById('fl-asl-btn-search').disabled = true;
        document.getElementById('fl-asl-btn-stop').style.display = '';
        updateStatus('Starting search...');

        crawlPage(url, 1);
    }

    function stopSearch() {
        searchState.aborted = true;
        searchState.running = false;
        document.getElementById('fl-asl-btn-search').disabled = false;
        document.getElementById('fl-asl-btn-stop').style.display = 'none';
        updateStatus(`Stopped. Scanned ${searchState.totalScanned} profiles, found ${searchState.totalMatches} matches.`);
    }

    function updateStatus(msg) {
        const el = document.getElementById('fl-asl-status');
        el.style.display = '';
        el.textContent = msg;
    }

    function crawlPage(baseURL, page) {
        if (searchState.aborted || page > CONFIG.maxPages) {
            if (!searchState.aborted) {
                stopSearch();
                updateStatus(`Done. Scanned ${searchState.totalScanned} profiles, found ${searchState.totalMatches} matches.`);
            }
            return;
        }

        const sep = baseURL.includes('?') ? '&' : '?';
        const url = baseURL + sep + 'page=' + page;
        updateStatus(`Fetching page ${page}... (${searchState.totalMatches} matches from ${searchState.totalScanned} scanned)`);

        gmXHR({
            method: 'GET',
            url: url,
            headers: {
                'Accept': 'text/html',
            },
            onload: function (response) {
                if (searchState.aborted) return;

                if (response.status === 403 || response.status === 429) {
                    updateStatus(`Rate limited (${response.status}). Try increasing the delay and try again later.`);
                    stopSearch();
                    return;
                }

                if (response.status !== 200) {
                    updateStatus(`Error: HTTP ${response.status}. Stopping.`);
                    stopSearch();
                    return;
                }

                const parser = new DOMParser();
                const doc = parser.parseFromString(response.responseText, 'text/html');

                // Try multiple selector strategies for member cards
                let cards = extractMemberCards(doc);

                if (cards.length === 0) {
                    updateStatus(`Done. No more profiles found. Scanned ${searchState.totalScanned} profiles, found ${searchState.totalMatches} matches.`);
                    stopSearch();
                    return;
                }

                const params = getSearchParams();
                for (const profile of cards) {
                    searchState.totalScanned++;
                    if (matchesSearch(profile, params)) {
                        searchState.totalMatches++;
                        displayResult(profile);
                    }
                }

                updateStatus(`Page ${page} done. ${searchState.totalMatches} matches from ${searchState.totalScanned} scanned. Next page in ${getDelay() / 1000}s...`);

                // Schedule next page
                searchState.currentPage = page + 1;
                setTimeout(() => crawlPage(baseURL, page + 1), getDelay());
            },
            onerror: function (err) {
                updateStatus('Network error. Retrying in 10s...');
                setTimeout(() => crawlPage(baseURL, page), 10000);
            }
        });
    }

    function getDelay() {
        return (parseInt(document.getElementById('fl-asl-speed').value) || 4) * 1000;
    }

    // ---------------------
    // Profile extraction - tries multiple selectors
    // ---------------------
    function extractMemberCards(doc) {
        let profiles = [];

        // Strategy 1: Modern .fl-member-card elements
        let cards = doc.querySelectorAll('.fl-member-card');
        if (cards.length > 0) {
            for (const card of cards) {
                const p = parseMemberCard(card);
                if (p) profiles.push(p);
            }
            if (profiles.length > 0) return profiles;
        }

        // Strategy 2: Look for .user_in_list elements (older layout)
        cards = doc.querySelectorAll('.user_in_list');
        if (cards.length > 0) {
            for (const card of cards) {
                const p = parseUserInList(card);
                if (p) profiles.push(p);
            }
            if (profiles.length > 0) return profiles;
        }

        // Strategy 3: Look for profile links with avatar images in any list/grid
        // Scans for common patterns: link to /users/ID with an img inside
        const allLinks = doc.querySelectorAll('a[href*="/users/"]');
        const seen = new Set();
        for (const link of allLinks) {
            const href = link.getAttribute('href') || '';
            const idMatch = href.match(/\/users\/(\d+)/);
            if (!idMatch || seen.has(idMatch[1])) continue;

            // Find the nearest container that might have profile info
            const container = link.closest('[class*="member"], [class*="card"], [class*="profile"], [class*="kinkster"], li, tr, article, div.flex') || link.parentElement;
            if (!container) continue;

            const text = container.textContent || '';
            // Try to detect age pattern (number followed by gender-like text)
            const ageMatch = text.match(/(\d{2})\s*(Male|Female|Trans|M|F|Enby|Non-binary|Genderqueer|Gender Fluid|Cis|Crossdresser|Intersex|Butch|Femme|Agender|Two-spirit)/i);
            if (!ageMatch && !link.querySelector('img')) continue;

            seen.add(idMatch[1]);
            const profile = parseGenericContainer(container, idMatch[1]);
            if (profile) profiles.push(profile);
        }

        return profiles;
    }

    function parseMemberCard(card) {
        try {
            const link = card.querySelector('a[href*="/users/"]');
            if (!link) return null;
            const idMatch = (link.getAttribute('href') || '').match(/\/users\/(\d+)/);
            if (!idMatch) return null;

            const img = card.querySelector('img');
            const nickname = img ? (img.getAttribute('alt') || '') : (link.textContent || '').trim();

            // Info line: "28F Submissive" or "32 Male Switch"
            const infoEl = card.querySelector('.fl-member-card__info, [class*="info"], [class*="meta"]');
            const infoText = infoEl ? infoEl.textContent.trim() : '';

            const locationEl = card.querySelector('.fl-member-card__location, [class*="location"]');
            const locationText = locationEl ? locationEl.textContent.trim() : '';

            return buildProfile(idMatch[1], nickname, infoText, locationText, img ? img.src : '');
        } catch (e) { return null; }
    }

    function parseUserInList(card) {
        try {
            const link = card.querySelector('a[href*="/users/"]');
            if (!link) return null;
            const idMatch = (link.getAttribute('href') || '').match(/\/users\/(\d+)/);
            if (!idMatch) return null;

            const img = card.querySelector('img');
            const nickname = img ? (img.getAttribute('alt') || '') : '';

            const quietEl = card.querySelector('.quiet');
            const infoText = quietEl ? quietEl.textContent.trim() : '';

            const smallEl = card.querySelector('.small');
            const locationText = smallEl ? smallEl.textContent.trim() : '';

            return buildProfile(idMatch[1], nickname, infoText, locationText, img ? img.src : '');
        } catch (e) { return null; }
    }

    function parseGenericContainer(container, userId) {
        try {
            const text = container.textContent || '';

            // Try to find nickname from first link with /users/
            const link = container.querySelector('a[href*="/users/' + userId + '"]');
            let nickname = '';
            if (link) {
                const img = link.querySelector('img');
                nickname = img ? (img.getAttribute('alt') || '') : link.textContent.trim();
            }
            if (!nickname) {
                nickname = 'User ' + userId;
            }

            const img = container.querySelector('img');
            const avatarUrl = img ? img.src : '';

            // Extract all text and try to parse age/gender/role/location
            return buildProfile(userId, nickname, text, text, avatarUrl);
        } catch (e) { return null; }
    }

    function buildProfile(userId, nickname, infoText, locationText, avatarUrl) {
        const parsed = parseInfoText(infoText);
        const location = parseLocation(locationText);

        return {
            userId: userId,
            nickname: nickname || 'User ' + userId,
            age: parsed.age,
            gender: parsed.gender,
            role: parsed.role,
            location: location,
            locationRaw: locationText,
            avatarUrl: avatarUrl || '',
        };
    }

    function parseInfoText(text) {
        let age = null, gender = '', role = '';
        if (!text) return { age, gender, role };

        // Common format: "28F Submissive" or "32 Male Switch" or "28 Cis Woman Submissive"
        // Age is a 2-digit number
        const ageMatch = text.match(/\b(\d{2,3})\b/);
        if (ageMatch) age = parseInt(ageMatch[1]);

        // Gender detection - look for known gender terms
        const genderTerms = [
            'Trans - Male/Man', 'Trans - Female/Woman', 'Trans Male', 'Trans Female',
            'Trans Man', 'Trans Woman', 'Cis Man', 'Cis Woman',
            'Gender Fluid', 'Genderqueer', 'Non-binary', 'Crossdresser/Transvestite',
            'Crossdresser', 'Transvestite', 'Intersex', 'Two-spirit', 'Agender',
            'Butch', 'Femme', 'Transgender', 'Male', 'Female', 'Enby',
            'M', 'F', 'GF', 'GQ', 'NB', 'CD/TV',
        ];
        for (const term of genderTerms) {
            if (text.toLowerCase().includes(term.toLowerCase())) {
                gender = term;
                break;
            }
        }
        // Normalize short forms
        if (gender === 'M') gender = 'Male';
        if (gender === 'F') gender = 'Female';
        if (gender === 'GF') gender = 'Gender Fluid';
        if (gender === 'GQ') gender = 'Genderqueer';
        if (gender === 'NB') gender = 'Non-binary';
        if (gender === 'CD/TV') gender = 'Crossdresser/Transvestite';

        // Role detection
        const roleTerms = [
            'Brat Tamer', 'Primal Hunter', 'Primal Prey', 'Rope Bunny',
            'Latex Fetishist', 'Leather Fetishist', 'Not Applicable',
            'Dominant', 'Domme', 'Dom', 'Switch', 'Submissive', 'Sub',
            'Master', 'Mistress', 'Slave', 'Top', 'Bottom', 'Sadist',
            'Masochist', 'Sadomasochist', 'Kinkster', 'Fetishist',
            'Hedonist', 'Exhibitionist', 'Voyeur', 'Rigger',
            'Daddy', 'Mommy', 'Boy', 'Girl', 'Brat',
            'Owner', 'Pet', 'Primal', 'Degrader', 'Degradee',
            'Boss', 'Princess', 'Doll', 'Puppy', 'Kitten', 'Pony',
            'Captain', 'Swinger', 'Vanilla', 'Unsure',
        ];
        for (const term of roleTerms) {
            // Match whole word to avoid "Dom" matching inside "Dominant" etc.
            const regex = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
            if (regex.test(text)) {
                role = term;
                break;
            }
        }

        return { age, gender, role };
    }

    function parseLocation(text) {
        if (!text) return '';
        // Location is typically comma-separated: "City, Region" or "City, Region, Country"
        // Remove any non-location noise by looking for comma-separated parts
        const parts = text.match(/([A-Z][\w\s.-]+(?:,\s*[A-Z][\w\s.-]+)*)/);
        return parts ? parts[0].trim() : text.trim();
    }

    // ---------------------
    // Matching
    // ---------------------
    function matchesSearch(profile, params) {
        // Age filter
        if (profile.age !== null) {
            if (params.ageMin && profile.age < params.ageMin) return false;
            if (params.ageMax && profile.age > params.ageMax) return false;
        }

        // Gender filter (if any are selected)
        if (params.genders.length > 0 && profile.gender) {
            const g = profile.gender.toLowerCase();
            if (!params.genders.some(sg => g.includes(sg) || sg.includes(g))) return false;
        }

        // Role filter (if any are selected)
        if (params.roles.length > 0 && profile.role) {
            const r = profile.role.toLowerCase();
            if (!params.roles.some(sr => r.includes(sr) || sr.includes(r))) return false;
        }

        // Location filter
        if (params.locationFilter) {
            const loc = (profile.locationRaw || '').toLowerCase();
            if (!loc.includes(params.locationFilter)) return false;
        }

        return true;
    }

    // ---------------------
    // Display result
    // ---------------------
    function displayResult(profile) {
        const container = document.getElementById('fl-asl-results');
        const div = document.createElement('div');
        div.className = 'fl-asl-result';

        const avatarHTML = profile.avatarUrl
            ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="">`
            : `<div style="width:50px;height:50px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#666;">?</div>`;

        const meta = [
            profile.age ? profile.age : '',
            profile.gender || '',
            profile.role || '',
        ].filter(Boolean).join(' / ');

        const location = profile.locationRaw || '';

        div.innerHTML = `
            ${avatarHTML}
            <div class="info">
                <a href="https://fetlife.com/users/${escapeHtml(profile.userId)}" target="_blank">${escapeHtml(profile.nickname)}</a>
                <div class="meta">${escapeHtml(meta)}</div>
                ${location ? `<div class="meta">${escapeHtml(location)}</div>` : ''}
            </div>
            <div class="actions">
                <a href="https://fetlife.com/conversations/new?with=${escapeHtml(profile.userId)}" target="_blank">Message</a>
            </div>
        `;

        container.appendChild(div);

        // Auto-scroll to latest result
        div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ---------------------
    // Initialize
    // ---------------------
    if (window.location.hostname === 'fetlife.com') {
        buildUI();
    }

})();
