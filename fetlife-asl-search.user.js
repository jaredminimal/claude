// ==UserScript==
// @name           FetLife ASL Search (Modern Edition)
// @version        2.0.0
// @namespace      https://github.com/jaredminimal/fetlife-asl-search
// @description    Search FetLife profiles by age, sex, location, and role. Crawls member lists with CSV export.
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
    // State
    // ---------------------
    let searchState = {
        running: false,
        aborted: false,
        totalScanned: 0,
        totalMatches: 0,
        currentPage: 1,
        allResults: [],       // for CSV export
        urlQueue: [],         // for multi-location crawling
        currentUrlIndex: 0,
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
            font-size: 18px;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 3px 12px rgba(0,0,0,0.4);
            transition: background 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            line-height: 1;
        }
        #fl-asl-toggle:hover { background: #e33; }

        #fl-asl-panel {
            position: fixed;
            top: 10px;
            right: 10px;
            z-index: 100000;
            width: 460px;
            max-height: calc(100vh - 20px);
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
            padding: 10px 16px;
            font-weight: 600;
            font-size: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        #fl-asl-panel .panel-header button {
            background: none; border: none; color: #fff;
            font-size: 20px; cursor: pointer; padding: 0 4px;
        }

        #fl-asl-panel .panel-body {
            padding: 14px;
            overflow-y: auto;
            flex: 1;
        }

        #fl-asl-panel label.field-label {
            display: block;
            margin-bottom: 4px;
            font-weight: 500;
            color: #aaa;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        #fl-asl-panel input[type="number"],
        #fl-asl-panel input[type="text"],
        #fl-asl-panel select,
        #fl-asl-panel textarea {
            width: 100%;
            padding: 7px 10px;
            margin-bottom: 10px;
            background: #16213e;
            border: 1px solid #333;
            border-radius: 6px;
            color: #e0e0e0;
            font-size: 13px;
            box-sizing: border-box;
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
            font-size: 12px; color: #aaa; display: none;
            word-break: break-word;
        }

        #fl-asl-log {
            margin-top: 6px; padding: 6px 8px;
            background: #0d1117; border-radius: 6px;
            font-size: 11px; color: #666; display: none;
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

        /* Tabs */
        #fl-asl-tabs { display: flex; gap: 0; margin-bottom: 10px; }
        #fl-asl-tabs button {
            flex: 1; padding: 8px 4px; background: #16213e; border: 1px solid #333;
            color: #888; font-size: 12px; font-weight: 600; cursor: pointer;
            transition: all 0.2s;
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
        'Unsure', 'Not Applicable',
    ];

    // ---------------------
    // Build UI
    // ---------------------
    function buildUI() {
        // Floating toggle button
        const toggle = document.createElement('button');
        toggle.id = 'fl-asl-toggle';
        toggle.textContent = 'ASL';
        toggle.title = 'FetLife ASL Search';
        document.body.appendChild(toggle);

        // Panel
        const panel = document.createElement('div');
        panel.id = 'fl-asl-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <span>ASL Search v2</span>
                <button id="fl-asl-close" title="Close">&times;</button>
            </div>
            <div class="panel-body">

                <div id="fl-asl-tabs">
                    <button class="active" data-tab="search">Search</button>
                    <button data-tab="results">Results</button>
                    <button data-tab="log">Debug Log</button>
                </div>

                <!-- SEARCH TAB -->
                <div class="fl-asl-tab-content active" id="fl-asl-tab-search">

                    <div class="section-title">Where to Search</div>
                    <label class="field-label">Mode</label>
                    <select id="fl-asl-source">
                        <option value="thispage">This Page (auto-detect member list)</option>
                        <option value="url">Paste a FetLife URL</option>
                        <option value="search">Search by Keyword</option>
                        <option value="discover">Discover from My Profile Location</option>
                    </select>

                    <div id="fl-asl-source-url" style="display:none;">
                        <label class="field-label">URL(s) - one per line</label>
                        <textarea id="fl-asl-url" rows="3" placeholder="https://fetlife.com/administrative_areas/223/kinksters&#10;https://fetlife.com/cities/4567/kinksters"></textarea>
                    </div>

                    <div id="fl-asl-source-search" style="display:none;">
                        <label class="field-label">Keyword</label>
                        <input type="text" id="fl-asl-keyword" placeholder="e.g. a name or keyword">
                    </div>

                    <div id="fl-asl-source-discover" style="display:none;">
                        <p style="font-size:12px;color:#888;margin:0 0 8px;">
                            This will look at your profile to find your location, then crawl that area's member list.
                            You can also click your city/state/country on any FetLife profile to navigate there,
                            then use "This Page" mode.
                        </p>
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

                <!-- RESULTS TAB -->
                <div class="fl-asl-tab-content" id="fl-asl-tab-results">
                    <button class="fl-asl-btn" id="fl-asl-btn-export">Export to CSV</button>
                    <div id="fl-asl-results-count"></div>
                    <div id="fl-asl-results"></div>
                </div>

                <!-- DEBUG TAB -->
                <div class="fl-asl-tab-content" id="fl-asl-tab-log">
                    <p style="font-size:11px;color:#666;margin:0 0 6px;">
                        Debug log showing what the script sees. Useful for troubleshooting.
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

        // Toggle
        toggle.addEventListener('click', () => panel.classList.toggle('open'));
        document.getElementById('fl-asl-close').addEventListener('click', () => panel.classList.remove('open'));

        // Source mode toggle
        const sourceSelect = document.getElementById('fl-asl-source');
        sourceSelect.addEventListener('change', () => {
            document.getElementById('fl-asl-source-url').style.display = sourceSelect.value === 'url' ? '' : 'none';
            document.getElementById('fl-asl-source-search').style.display = sourceSelect.value === 'search' ? '' : 'none';
            document.getElementById('fl-asl-source-discover').style.display = sourceSelect.value === 'discover' ? '' : 'none';
        });

        // Speed slider
        const speedSlider = document.getElementById('fl-asl-speed');
        speedSlider.addEventListener('input', () => {
            document.getElementById('fl-asl-speed-label').textContent = speedSlider.value;
        });

        // Select All / None helpers
        addSelectHelpers('fl-asl-genders', 'fl-asl-gender-helpers');
        addSelectHelpers('fl-asl-roles', 'fl-asl-role-helpers');

        // Buttons
        document.getElementById('fl-asl-btn-search').addEventListener('click', startSearch);
        document.getElementById('fl-asl-btn-stop').addEventListener('click', stopSearch);
        document.getElementById('fl-asl-btn-export').addEventListener('click', exportCSV);
    }

    function addSelectHelpers(checkboxGroupId, helperId) {
        const container = document.getElementById(checkboxGroupId);
        const helper = document.getElementById(helperId);
        const btnAll = document.createElement('a');
        btnAll.textContent = 'All';
        btnAll.addEventListener('click', e => { e.preventDefault(); container.querySelectorAll('input').forEach(cb => cb.checked = true); });
        const btnNone = document.createElement('a');
        btnNone.textContent = 'None';
        btnNone.addEventListener('click', e => { e.preventDefault(); container.querySelectorAll('input').forEach(cb => cb.checked = false); });
        const btnInvert = document.createElement('a');
        btnInvert.textContent = 'Invert';
        btnInvert.addEventListener('click', e => { e.preventDefault(); container.querySelectorAll('input').forEach(cb => cb.checked = !cb.checked); });
        helper.append(btnAll, btnNone, btnInvert);
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
        console.log('[ASL Search]', msg);
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
            genders: [...document.querySelectorAll('#fl-asl-genders input:checked')].map(cb => cb.value.toLowerCase()),
            roles: [...document.querySelectorAll('#fl-asl-roles input:checked')].map(cb => cb.value.toLowerCase()),
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
            if (urls.length === 0) { alert('No valid URLs found. Each line should start with https://'); return; }
            callback(urls);
            return;
        }

        if (source === 'discover') {
            discoverLocationFromProfile(callback);
            return;
        }

        // 'thispage' mode
        const url = detectMemberListURL();
        if (url) {
            callback([url]);
        }
    }

    function detectMemberListURL() {
        const loc = window.location.href;
        log('Detecting member list from current URL: ' + loc);

        // Already on a kinksters/members/friends page
        if (/\/(kinksters|group_memberships|rsvps|friends)/.test(loc)) {
            const base = loc.split('?')[0].split('#')[0];
            log('Already on a member list page: ' + base);
            return base;
        }

        // On a location/group/event/fetish page — append the members endpoint
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
                log('Detected: ' + url);
                return url;
            }
        }

        // Try to find location links on the current page
        log('No direct URL match. Scanning page for location links...');
        const locationLinks = findLocationLinksOnPage();
        if (locationLinks.length > 0) {
            log('Found location link on page: ' + locationLinks[0]);
            return locationLinks[0] + '/kinksters';
        }

        alert(
            'Could not detect a member list on this page.\n\n' +
            'Try one of these:\n' +
            '1. Go to a city/state/country page on FetLife and try again\n' +
            '2. Click on someone\'s location link to get to their city page\n' +
            '3. Use "Paste a FetLife URL" mode\n' +
            '4. Use "Search by Keyword" mode\n' +
            '5. Use "Discover from My Profile" mode'
        );
        return null;
    }

    function findLocationLinksOnPage() {
        const results = [];
        const links = document.querySelectorAll('a[href*="/cities/"], a[href*="/administrative_areas/"], a[href*="/countries/"]');
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && /\/(cities|administrative_areas|countries)\/\d+$/.test(href)) {
                const full = href.startsWith('http') ? href : 'https://fetlife.com' + href;
                if (!results.includes(full)) results.push(full);
            }
        }
        return results;
    }

    function discoverLocationFromProfile(callback) {
        updateStatus('Discovering your location from your profile...');
        // Find the current user's profile link
        const profileLink = document.querySelector('a[href*="/users/"].fl-nav__nickname, a.fl-nav__nickname, [data-user-id] a, a[href^="/users/"]');
        if (!profileLink) {
            // Try to find user ID from the page
            const navNick = document.querySelector('.fl-nav__nickname');
            if (navNick) {
                const href = navNick.closest('a') ? navNick.closest('a').getAttribute('href') : null;
                if (href) {
                    fetchProfileLocation(href, callback);
                    return;
                }
            }
            alert('Could not find your profile link. Please navigate to your profile page and try again, or use a different search mode.');
            return;
        }
        fetchProfileLocation(profileLink.getAttribute('href'), callback);
    }

    function fetchProfileLocation(profilePath, callback) {
        const url = profilePath.startsWith('http') ? profilePath : 'https://fetlife.com' + profilePath;
        log('Fetching profile: ' + url);

        gmXHR({
            method: 'GET',
            url: url,
            headers: { 'Accept': 'text/html' },
            onload: function (resp) {
                if (resp.status !== 200) {
                    updateStatus('Could not load profile (HTTP ' + resp.status + ')');
                    return;
                }
                const doc = new DOMParser().parseFromString(resp.responseText, 'text/html');
                const locLinks = [];

                // Look for location links in the profile
                const allLinks = doc.querySelectorAll('a[href*="/cities/"], a[href*="/administrative_areas/"], a[href*="/countries/"]');
                for (const link of allLinks) {
                    const href = link.getAttribute('href');
                    if (href && /\/(cities|administrative_areas|countries)\/\d+$/.test(href)) {
                        const full = href.startsWith('http') ? href : 'https://fetlife.com' + href;
                        const text = link.textContent.trim();
                        locLinks.push({ url: full + '/kinksters', text: text, type: href.split('/')[1] || '' });
                    }
                }

                if (locLinks.length === 0) {
                    log('No location links found on profile. HTML snippet: ' + resp.responseText.substring(0, 2000));
                    updateStatus('Could not find location links on your profile. Try another search mode.');
                    return;
                }

                log('Found location links: ' + JSON.stringify(locLinks));

                // Use the broadest location (administrative_area > city) for wider coverage
                // Or let user pick — for now use the state/province level if available
                const area = locLinks.find(l => l.type === 'administrative_areas');
                const city = locLinks.find(l => l.type === 'cities');
                const country = locLinks.find(l => l.type === 'countries');

                const chosen = area || city || country;
                if (chosen) {
                    updateStatus('Found location: ' + chosen.text + ' — starting search...');
                    callback([chosen.url]);
                } else {
                    callback([locLinks[0].url]);
                }
            },
            onerror: function () {
                updateStatus('Network error loading profile.');
            }
        });
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
            if (!urls || urls.length === 0) {
                stopSearch();
                return;
            }
            searchState.urlQueue = urls;
            searchState.currentUrlIndex = 0;
            log('URLs to crawl: ' + JSON.stringify(urls));
            crawlNextURL();
        });
    }

    function crawlNextURL() {
        if (searchState.aborted) return;
        if (searchState.currentUrlIndex >= searchState.urlQueue.length) {
            finishSearch();
            return;
        }
        const url = searchState.urlQueue[searchState.currentUrlIndex];
        log('Starting crawl of URL ' + (searchState.currentUrlIndex + 1) + '/' + searchState.urlQueue.length + ': ' + url);
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
        updateStatus(`Stopped. Scanned ${searchState.totalScanned} profiles, found ${searchState.totalMatches} matches.`);
        updateResultsCount();
    }

    function finishSearch() {
        searchState.running = false;
        document.getElementById('fl-asl-btn-search').disabled = false;
        document.getElementById('fl-asl-btn-stop').style.display = 'none';
        if (searchState.allResults.length > 0) {
            document.getElementById('fl-asl-btn-export').style.display = '';
        }
        updateStatus(`Done! Scanned ${searchState.totalScanned} profiles, found ${searchState.totalMatches} matches.`);
        updateResultsCount();

        // Auto-switch to results tab
        document.querySelector('#fl-asl-tabs button[data-tab="results"]').click();
    }

    function updateResultsCount() {
        const el = document.getElementById('fl-asl-results-count');
        el.style.display = '';
        el.textContent = `${searchState.totalMatches} matches from ${searchState.totalScanned} profiles scanned`;
    }

    function crawlPage(baseURL, page) {
        if (searchState.aborted) return;
        if (page > getMaxPages()) {
            log('Reached max pages (' + getMaxPages() + ') for this URL.');
            searchState.currentUrlIndex++;
            setTimeout(crawlNextURL, getDelay());
            return;
        }

        const sep = baseURL.includes('?') ? '&' : '?';
        const url = baseURL + sep + 'page=' + page;
        updateStatus(`[URL ${searchState.currentUrlIndex + 1}/${searchState.urlQueue.length}] Page ${page}... (${searchState.totalMatches} matches / ${searchState.totalScanned} scanned)`);

        gmXHR({
            method: 'GET',
            url: url,
            headers: { 'Accept': 'text/html' },
            onload: function (response) {
                if (searchState.aborted) return;

                log('HTTP ' + response.status + ' for ' + url + ' (' + response.responseText.length + ' bytes)');

                if (response.status === 403 || response.status === 429) {
                    updateStatus('Rate limited (HTTP ' + response.status + '). Increase delay and try again later.');
                    stopSearch();
                    return;
                }
                if (response.status === 302 || response.status === 301) {
                    log('Redirect detected. FetLife may have changed URL format.');
                    updateStatus('Redirect (HTTP ' + response.status + '). The URL may be wrong.');
                    stopSearch();
                    return;
                }
                if (response.status !== 200) {
                    updateStatus('Error: HTTP ' + response.status + '. Stopping.');
                    stopSearch();
                    return;
                }

                const doc = new DOMParser().parseFromString(response.responseText, 'text/html');

                // Log what we see on the page for debugging
                logPageStructure(doc);

                const profiles = extractMemberCards(doc);
                log('Extracted ' + profiles.length + ' profiles from page ' + page);

                if (profiles.length === 0) {
                    log('No profiles found on page ' + page + '. Moving to next URL.');
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
                updateStatus(`Page ${page} done. ${searchState.totalMatches} matches / ${searchState.totalScanned} scanned. Next in ${getDelay() / 1000}s...`);

                // Next page
                searchState.currentPage = page + 1;
                setTimeout(() => crawlPage(baseURL, page + 1), getDelay());
            },
            onerror: function (err) {
                log('Network error: ' + JSON.stringify(err));
                updateStatus('Network error. Retrying in 10s...');
                setTimeout(() => crawlPage(baseURL, page), 10000);
            }
        });
    }

    // ---------------------
    // Debug: log what we see on the page
    // ---------------------
    function logPageStructure(doc) {
        // Log key elements we're looking for
        const selectors = [
            '.fl-member-card',
            '.fl-member-card__info',
            '.fl-member-card__location',
            '.fl-member-card__user',
            '.user_in_list',
            '.member_card',
            '[class*="member"]',
            '[class*="kinkster"]',
            '[class*="card"]',
            'a[href*="/users/"]',
        ];
        for (const sel of selectors) {
            const count = doc.querySelectorAll(sel).length;
            if (count > 0) log(`  Found ${count} elements matching: ${sel}`);
        }

        // Log first few class names on the page for discovery
        const mainContent = doc.querySelector('#main-content, #maincontent, main, [role="main"]');
        if (mainContent) {
            // Get unique class names from first-level children
            const classes = new Set();
            mainContent.querySelectorAll('*').forEach(el => {
                if (el.className && typeof el.className === 'string') {
                    el.className.split(/\s+/).forEach(c => { if (c) classes.add(c); });
                }
            });
            const classArr = [...classes].slice(0, 50);
            log('  Main content classes (first 50): ' + classArr.join(', '));
        }

        // Log the first 500 chars of main content text
        const bodyText = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim().substring(0, 500);
        log('  Page text preview: ' + bodyText);

        // Log all links to /users/ (first 10)
        const userLinks = doc.querySelectorAll('a[href*="/users/"]');
        const linkSample = [...userLinks].slice(0, 10).map(a => {
            return a.getAttribute('href') + ' | text="' + a.textContent.trim().substring(0, 30) + '" | parent=' + (a.parentElement ? a.parentElement.className : 'none');
        });
        if (linkSample.length > 0) log('  User links sample:\n    ' + linkSample.join('\n    '));
    }

    // ---------------------
    // Profile extraction — tries multiple strategies
    // ---------------------
    function extractMemberCards(doc) {
        let profiles = [];

        // Strategy 1: .fl-member-card (known FetLife selector)
        let cards = doc.querySelectorAll('.fl-member-card');
        if (cards.length > 0) {
            log('Strategy 1: .fl-member-card found ' + cards.length + ' cards');
            for (const card of cards) {
                const p = parseMemberCard(card);
                if (p) profiles.push(p);
            }
            if (profiles.length > 0) return profiles;
        }

        // Strategy 2: .user_in_list (older FetLife)
        cards = doc.querySelectorAll('.user_in_list');
        if (cards.length > 0) {
            log('Strategy 2: .user_in_list found ' + cards.length + ' cards');
            for (const card of cards) {
                const p = parseUserInList(card);
                if (p) profiles.push(p);
            }
            if (profiles.length > 0) return profiles;
        }

        // Strategy 3: Any element with "member" or "kinkster" in class containing user links
        const memberLike = doc.querySelectorAll('[class*="member-card"], [class*="member_card"], [class*="kinkster"]');
        if (memberLike.length > 0) {
            log('Strategy 3: member/kinkster class elements found ' + memberLike.length);
            for (const el of memberLike) {
                const p = parseGenericMemberElement(el);
                if (p) profiles.push(p);
            }
            if (profiles.length > 0) return profiles;
        }

        // Strategy 4: Scan all user links and look at their surrounding containers
        log('Strategy 4: Scanning all /users/ links...');
        const userLinks = doc.querySelectorAll('a[href*="/users/"]');
        const seen = new Set();

        for (const link of userLinks) {
            const href = link.getAttribute('href') || '';
            const idMatch = href.match(/\/users\/(\d+)/);
            if (!idMatch) continue;

            const userId = idMatch[1];
            if (seen.has(userId)) continue;

            // Skip nav/header links — look for links that are in the main content
            const inNav = link.closest('nav, header, .fl-nav, [class*="nav"]');
            if (inNav) continue;

            // Walk up to find the best container
            let container = link.parentElement;
            for (let i = 0; i < 5 && container; i++) {
                // Stop if we hit something too large
                const userLinksInside = container.querySelectorAll('a[href*="/users/"]');
                const uniqueUsers = new Set([...userLinksInside].map(a => (a.getAttribute('href') || '').match(/\/users\/(\d+)/)?.[1]).filter(Boolean));
                if (uniqueUsers.size > 3) break; // Too many users in this container, go back
                if (uniqueUsers.size >= 1) {
                    // Check if this level has info we want (text with numbers = possible age)
                    const text = container.textContent || '';
                    if (/\d{2}/.test(text)) break; // Has age-like numbers, good container
                }
                container = container.parentElement;
            }

            if (!container) container = link.parentElement;
            seen.add(userId);

            const profile = parseContainerForProfile(container, userId, link);
            if (profile) {
                profiles.push(profile);
                if (profiles.length <= 3) {
                    log('  Strategy 4 sample: ' + JSON.stringify(profile));
                }
            }
        }

        log('Strategy 4 found ' + profiles.length + ' profiles');
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

            const infoEl = card.querySelector('.fl-member-card__info, [class*="info"], [class*="meta"]');
            const infoText = infoEl ? infoEl.textContent.trim() : '';

            const locationEl = card.querySelector('.fl-member-card__location, [class*="location"]');
            const locationText = locationEl ? locationEl.textContent.trim() : '';

            return buildProfile(idMatch[1], nickname, infoText, locationText, img ? img.src : '');
        } catch (e) { log('parseMemberCard error: ' + e.message); return null; }
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

    function parseGenericMemberElement(el) {
        try {
            const link = el.querySelector('a[href*="/users/"]');
            if (!link) return null;
            const idMatch = (link.getAttribute('href') || '').match(/\/users\/(\d+)/);
            if (!idMatch) return null;
            return parseContainerForProfile(el, idMatch[1], link);
        } catch (e) { return null; }
    }

    function parseContainerForProfile(container, userId, link) {
        try {
            let nickname = '';

            // Try to get nickname from the link text or img alt
            if (link) {
                const img = link.querySelector('img');
                if (img && img.getAttribute('alt')) {
                    nickname = img.getAttribute('alt');
                } else {
                    nickname = link.textContent.trim();
                }
            }

            // If nickname is empty or too long (grabbed too much), try other links
            if (!nickname || nickname.length > 50) {
                const allLinks = container.querySelectorAll('a[href*="/users/' + userId + '"]');
                for (const a of allLinks) {
                    const text = a.textContent.trim();
                    if (text && text.length > 0 && text.length < 50) {
                        nickname = text;
                        break;
                    }
                }
            }
            if (!nickname) nickname = 'User ' + userId;

            // Get avatar
            const img = container.querySelector('img');
            const avatarUrl = img ? (img.getAttribute('src') || '') : '';

            // Get text content for parsing — but exclude nested user containers
            const text = container.textContent || '';

            // Try to separate info text from location text
            // Look for location links
            const locLinks = container.querySelectorAll('a[href*="/cities/"], a[href*="/administrative_areas/"], a[href*="/countries/"]');
            let locationText = '';
            for (const ll of locLinks) {
                locationText += (locationText ? ', ' : '') + ll.textContent.trim();
            }

            return buildProfile(userId, nickname, text, locationText || text, avatarUrl);
        } catch (e) { return null; }
    }

    // ---------------------
    // Profile building & parsing
    // ---------------------
    function buildProfile(userId, nickname, infoText, locationText, avatarUrl) {
        const parsed = parseInfoText(infoText);
        return {
            userId: userId,
            nickname: (nickname || 'User ' + userId).substring(0, 60),
            age: parsed.age,
            gender: parsed.gender,
            role: parsed.role,
            location: locationText.substring(0, 200),
            avatarUrl: avatarUrl || '',
            profileUrl: 'https://fetlife.com/users/' + userId,
        };
    }

    function parseInfoText(text) {
        let age = null, gender = '', role = '';
        if (!text) return { age, gender, role };

        // Age: look for 2-digit number (18-99 range most likely)
        const ageMatch = text.match(/\b([1-9]\d)\b/);
        if (ageMatch) {
            const n = parseInt(ageMatch[1]);
            if (n >= 18 && n <= 99) age = n;
        }

        // Gender: match longest terms first to avoid partial matches
        const genderTerms = [
            'Crossdresser/Transvestite', 'Trans - Male/Man', 'Trans - Female/Woman',
            'Gender Fluid', 'Genderqueer', 'Non-binary', 'Two-spirit',
            'Cis Man', 'Cis Woman', 'Trans Man', 'Trans Woman',
            'Transgender', 'Crossdresser', 'Transvestite', 'Intersex',
            'Agender', 'Butch', 'Femme', 'Male', 'Female',
        ];
        for (const term of genderTerms) {
            if (text.toLowerCase().includes(term.toLowerCase())) {
                gender = term;
                break;
            }
        }

        // Role: match multi-word terms first
        const roleTerms = [
            'Brat Tamer', 'Primal Hunter', 'Primal Prey', 'Rope Bunny',
            'Not Applicable',
            'Dominant', 'Domme', 'Switch', 'Submissive',
            'Master', 'Mistress', 'Slave', 'Sadist', 'Masochist',
            'Sadomasochist', 'Kinkster', 'Fetishist', 'Hedonist',
            'Exhibitionist', 'Voyeur', 'Rigger', 'Daddy', 'Mommy',
            'Brat', 'Owner', 'Pet', 'Primal', 'Degrader', 'Degradee',
            'Boss', 'Princess', 'Doll', 'Puppy', 'Kitten', 'Pony',
            'Captain', 'Swinger', 'Vanilla', 'Unsure',
            'Top', 'Bottom', 'Dom', 'Sub', 'Boy', 'Girl',
        ];
        for (const term of roleTerms) {
            const regex = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
            if (regex.test(text)) {
                role = term;
                break;
            }
        }

        return { age, gender, role };
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

        // Gender (skip filter if all are checked or none are checked)
        if (params.genders.length > 0 && params.genders.length < GENDERS.length && profile.gender) {
            const g = profile.gender.toLowerCase();
            if (!params.genders.some(sg => g.includes(sg) || sg.includes(g))) return false;
        }

        // Role (skip filter if all are checked or none are checked)
        if (params.roles.length > 0 && params.roles.length < ROLES.length && profile.role) {
            const r = profile.role.toLowerCase();
            if (!params.roles.some(sr => r.includes(sr) || sr.includes(r))) return false;
        }

        // Location text
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
            ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="" loading="lazy">`
            : `<div style="width:44px;height:44px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#666;font-size:18px;">?</div>`;

        const meta = [
            profile.age || '',
            profile.gender || '',
            profile.role || '',
        ].filter(Boolean).join(' / ');

        div.innerHTML = `
            ${avatarHTML}
            <div class="info">
                <a href="${escapeHtml(profile.profileUrl)}" target="_blank">${escapeHtml(profile.nickname)}</a>
                ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
                ${profile.location ? `<div class="meta">${escapeHtml(profile.location)}</div>` : ''}
            </div>
            <div class="actions">
                <a href="https://fetlife.com/conversations/new?with=${escapeHtml(profile.userId)}" target="_blank">Msg</a>
            </div>
        `;

        container.appendChild(div);
    }

    // ---------------------
    // CSV Export
    // ---------------------
    function exportCSV() {
        if (searchState.allResults.length === 0) {
            alert('No results to export.');
            return;
        }

        const headers = ['Nickname', 'Age', 'Gender', 'Role', 'Location', 'Profile URL', 'Message URL'];
        const rows = searchState.allResults.map(p => [
            p.nickname,
            p.age || '',
            p.gender || '',
            p.role || '',
            p.location || '',
            p.profileUrl,
            'https://fetlife.com/conversations/new?with=' + p.userId,
        ]);

        const csvContent = [headers, ...rows]
            .map(row => row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(','))
            .join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fetlife-search-results-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        log('Exported ' + searchState.allResults.length + ' results to CSV');
    }

    // ---------------------
    // Utility
    // ---------------------
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
        log('ASL Search v2 loaded on ' + window.location.href);
        log('Tampermonkey/GM API available: ' + (gmXHR ? 'YES' : 'NO'));
    }

})();
