/**
 * Shared, dependency-free helpers for the Shiori Reading Sync extension.
 *
 * This file is loaded as a classic script before content.js and also by the
 * options/popup pages. It intentionally exposes a single `Shiori` global so the
 * same code works in Chrome MV3 and Firefox without a bundler.
 */
(function (root) {
    'use strict';

    const CONFIG_KEY = 'shiori.sync.config.v1';
    const LOCAL_PROGRESS_PREFIX = 'shiori.progress.v1.';
    const DEFAULT_API_PATH = '/api/v1';

    const GENERIC_CONTENT_SELECTORS = [
        'article',
        '[itemprop="articleBody"]',
        '.chapter-content',
        '.chapter-body',
        '.chapter__content',
        '.entry-content',
        '.post-content',
        '.read-content',
        '#chapter-content',
        '#chapter-body',
        // NovelPing-family readers render the chapter text into #chr-content
        // (their <main> wraps the whole reader; the nesting rule in
        // findContentElement picks the specific element over the wrapper).
        '#chr-content',
        '#content',
        'main',
    ];

    const GENERIC_TITLE_SELECTORS = [
        'meta[property="og:novel:book_name"]',
        'meta[property="og:title"]',
        'h1',
        '.novel-title',
        '.series-title',
        '.entry-title',
    ];

    const GENERIC_CHAPTER_TITLE_SELECTORS = [
        '.chapter-title',
        '.chapter__title',
        // NovelPing-family readers mark the chapter heading with .chr-title
        // (.chapter-title does not exist there and h1 is the series title).
        '.chr-title',
        '.entry-title',
        'h1',
    ];

    // No default site profiles on purpose. The extension must not initialize on
    // sites the user has not explicitly listed (default presets or user-added
    // profiles) — some sites are hostile to injected scripts. Wildcard
    // auto-detect ("*") remains available for users who deliberately add it.
    const DEFAULT_SITES = [];

    const DEFAULT_TRACKERS = [
        {
            id: 'custom-default',
            type: 'custom',
            name: 'Custom sync server',
            baseUrl: '',
            token: '',
            enabled: true,
        },
    ];

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function defaultConfig() {
        return {
            version: 1,
            activeTrackerId: 'custom-default',
            autoRestore: true,
            restoreThresholdPercent: 3,
            trackers: clone(DEFAULT_TRACKERS),
            sites: clone(DEFAULT_SITES),
        };
    }

    function mergeConfig(raw) {
        const defaults = defaultConfig();
        if (!raw || typeof raw !== 'object') return defaults;

        // Migration: NovelUpdates/NovelList were catalogs, not reading sites.
        // Drop their preset site profiles and placeholder tracker cards from
        // configs saved by older versions.
        const migratedTrackers = (Array.isArray(raw.trackers) ? raw.trackers : [])
            .filter((tracker) => tracker.type !== 'novelupdates' && tracker.type !== 'novellist');
        const migratedSites = (Array.isArray(raw.sites) ? raw.sites : [])
            .filter((site) => site.type !== 'preset' && site.id !== 'generic');

        const trackers = migratedTrackers.length > 0
            ? migratedTrackers.map((tracker) => ({
                ...tracker,
                id: String(tracker.id || '').trim() || `tracker-${Math.random().toString(36).slice(2)}`,
                type: tracker.type || 'custom',
                name: String(tracker.name || 'Custom sync server'),
                baseUrl: String(tracker.baseUrl || '').replace(/\/+$/, ''),
                token: String(tracker.token || ''),
                enabled: tracker.enabled !== false,
            }))
            : defaults.trackers;

        const hasBuiltins = new Set(trackers.map((tracker) => tracker.type));
        for (const builtin of defaults.trackers) {
            if (builtin.type !== 'custom' && !hasBuiltins.has(builtin.type)) {
                trackers.push(clone(builtin));
            }
        }

        const sites = migratedSites.length > 0
            ? migratedSites.map((site) => ({
                ...site,
                id: String(site.id || '').trim() || `site-${Math.random().toString(36).slice(2)}`,
                type: site.type || 'custom',
                name: String(site.name || site.host || 'Custom site'),
                host: String(site.host || '*').trim(),
                mode: site.mode === 'series' ? 'series' : 'chapter',
                enabled: site.enabled !== false,
            }))
            : clone(defaults.sites);

        // Keep wildcard fallbacks last; specific hosts must win.
        const generic = sites.filter((site) => site.host === '*');
        const specific = sites.filter((site) => site.host !== '*');
        const orderedSites = [...specific, ...generic];

        const activeTrackerId = trackers.some((tracker) => tracker.id === raw.activeTrackerId)
            ? raw.activeTrackerId
            : (trackers.find((tracker) => tracker.type === 'custom')?.id || trackers[0].id);

        return {
            version: 1,
            activeTrackerId,
            autoRestore: raw.autoRestore !== false,
            restoreThresholdPercent: Number.isFinite(Number(raw.restoreThresholdPercent))
                ? Math.max(0, Math.min(100, Number(raw.restoreThresholdPercent)))
                : 3,
            trackers,
            sites: orderedSites,
        };
    }

    function normalizeSite(raw) {
        let value = String(raw || '').trim().toLowerCase();
        if (!value) return '';
        if (value.includes('://')) {
            try {
                value = new URL(value).host;
            } catch {
                return '';
            }
        } else {
            value = value.split('/')[0];
        }
        value = value.replace(/^.*@/, '');
        const [host, port] = value.split(':');
        const normalizedHost = host.replace(/^www\./, '');
        if (!normalizedHost || !/^[a-z0-9.-]+$/.test(normalizedHost)) return '';
        if (port && port !== '80' && port !== '443') return `${normalizedHost}:${port}`;
        return normalizedHost;
    }

    function hostMatches(host, pattern) {
        const normalizedHost = normalizeSite(host);
        const normalizedPattern = String(pattern || '').trim().toLowerCase();
        if (!normalizedHost || !normalizedPattern) return false;
        if (normalizedPattern === '*' || normalizedPattern === '<all_urls>') return true;
        if (normalizedPattern.startsWith('*.')) {
            const suffix = normalizedPattern.slice(2);
            return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
        }
        const patternHost = normalizeSite(normalizedPattern);
        if (!patternHost) return false;
        return normalizedHost === patternHost || normalizedHost.endsWith(`.${patternHost}`);
    }

    function findSite(config, url) {
        let host = '';
        try {
            host = new URL(url).host;
        } catch {
            return null;
        }
        return (config?.sites || []).find((site) => site.enabled !== false && hostMatches(host, site.host)) || null;
    }

    function getActiveTracker(config) {
        return (config?.trackers || []).find((tracker) => tracker.id === config.activeTrackerId && tracker.enabled !== false)
            || (config?.trackers || []).find((tracker) => tracker.type === 'custom' && tracker.enabled !== false)
            || null;
    }

    function slugify(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 160);
    }

    function safeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function chapterNumberFromText(value) {
        const text = safeText(value);
        if (!text) return null;
        const patterns = [
            /(?:chapter|ch\.?|episode|ep\.?|part|book)\s*[-:#]?\s*(\d+(?:\.\d+)?)/i,
            /\b(\d+(?:\.\d+)?)\s*$/,
        ];
        for (const pattern of patterns) {
            const match = pattern.exec(text);
            if (match) {
                const number = Number(match[1]);
                if (Number.isFinite(number)) return number;
            }
        }
        return null;
    }

    function stripChapterFromTitle(value) {
        return safeText(value)
            .replace(/\s*[-–—|:]\s*(?:chapter|ch\.?|episode|ep\.?|part|book)\s*[-:#]?\s*\d+(?:\.\d+)?\b.*$/i, '')
            .replace(/\s+(?:chapter|ch\.?|episode|ep\.?|part|book)\s*[-:#]?\s*\d+(?:\.\d+)?\b.*$/i, '')
            .trim();
    }

    function firstText(document, selectors) {
        for (const selector of selectors || []) {
            const element = document.querySelector(selector);
            if (!element) continue;
            const text = safeText(element.getAttribute?.('content') || element.textContent);
            if (text) return text;
        }
        return '';
    }

    function absoluteUrl(value, baseUrl) {
        if (!value) return '';
        try {
            return new URL(value, baseUrl).toString();
        } catch {
            return '';
        }
    }

    function canonicalUrl(document, baseUrl) {
        const selector = 'link[rel="canonical"], meta[property="og:url"]';
        const element = document.querySelector(selector);
        return absoluteUrl(element?.getAttribute('href') || element?.getAttribute('content'), baseUrl);
    }

    function extractSeriesTitle(document, site, pageTitle) {
        const selected = site?.titleSelector ? firstText(document, [site.titleSelector]) : '';
        if (selected) return stripChapterFromTitle(selected) || selected;
        const generic = firstText(document, site?.titleSelectors || GENERIC_TITLE_SELECTORS);
        if (generic) return stripChapterFromTitle(generic) || generic;
        return stripChapterFromTitle(pageTitle) || pageTitle;
    }

    function extractChapterTitle(document, site, pageTitle) {
        const selected = site?.chapterTitleSelector
            ? firstText(document, [site.chapterTitleSelector])
            : '';
        if (selected) return selected;
        const generic = firstText(document, site?.chapterTitleSelectors || GENERIC_CHAPTER_TITLE_SELECTORS);
        if (generic) return generic;
        return pageTitle;
    }

    function findContentElement(document, site) {
        const selectors = site?.contentSelectors || (site?.contentSelector ? [site.contentSelector] : []);
        const candidates = selectors.length > 0 ? selectors : GENERIC_CONTENT_SELECTORS;
        const matches = [];
        for (const selector of candidates) {
            for (const element of document.querySelectorAll(selector)) {
                const length = (element.textContent || '').trim().length;
                if (length > 0) matches.push({ element, length });
            }
        }
        if (matches.length === 0) return null;
        // When candidates nest (a wrapper like <main> contains the real chapter
        // element), the most specific match wins: a plain longest-text rule
        // always favours the wrapper, which misplaces scroll percentages and
        // paragraph indexes. Among equally specific matches the largest wins.
        const nested = matches.filter((m) =>
            matches.some((other) => other !== m && other.element.contains(m.element))
        );
        const pool = nested.length > 0 ? nested : matches;
        return pool.reduce((a, b) => (b.length >= a.length ? b : a)).element;
    }

    // URL segments that describe a section of the site rather than a series
    // (novelping.com/book/, royalroad.com/fiction/, ...). The last remaining
    // segment must never be one of these.
    const GENERIC_PATH_SEGMENTS = new Set([
        'book', 'books', 'novel', 'novels', 'read', 'reader', 'reading',
        'fiction', 'series', 'story', 'stories', 'title', 'work', 'works',
        'chapters', 'chapterlist', 'chapter-list', 'tableofcontents', 'toc',
    ]);

    /**
     * Derive a stable series identity from a URL: drop trailing chapter-ish
     * and numeric segments, then use the last remaining path segment.
     *
     * This is more stable than slugifying the page title, because og:titles
     * leak site suffixes ("The Author's POV | NovelPing" -> a different key on
     * the series page than on its chapter pages) and chapter subtitles. For
     * the same novel, `/book/{slug}/chapter-690` and `/novel/{slug}` both
     * reduce to "{slug}", so chapter pages and the series index agree.
     */
    function seriesSlugFromUrl(url) {
        try {
            const segments = new URL(url).pathname
                .split('/')
                .filter(Boolean)
                .filter((segment) => !/^(?:chapter|ch|read|reader|episode|ep|part)s?(?:[-_].*)?$/i.test(segment))
                .filter((segment) => !/^\d+(?:\.\d+)?$/.test(segment))
                .filter((segment) => !/^[a-z]{1,2}$/i.test(segment));
            const last = segments[segments.length - 1];
            if (!last) return '';
            const normalized = last.toLowerCase().replace(/\.[a-z0-9]+$/, '');
            if (GENERIC_PATH_SEGMENTS.has(normalized)) return '';
            return normalized;
        } catch {
            return '';
        }
    }

    function chapterNumberForPage(url, title) {
        const text = safeText(title);
        // A labelled chapter in the title is more reliable than a numeric novel
        // id in the URL (e.g. /novel/12345/).
        if (/(?:chapter|ch\.?|episode|ep\.?|part|book)\s*[-:#]?\s*\d/i.test(text)) {
            const fromTitle = chapterNumberFromText(text);
            if (fromTitle != null) return fromTitle;
        }
        let decoded = url;
        try {
            decoded = decodeURIComponent(url);
        } catch {
            // Keep the raw URL for malformed percent escapes.
        }
        return chapterNumberFromText(decoded) ?? chapterNumberFromText(text);
    }

    /**
     * Extract a chapter-page descriptor. Selectors fall back to conservative
     * heuristics so custom sites work without configuration.
     */
    function extractChapterPage(document, url, site, pageTitle) {
        const chapterTitle = extractChapterTitle(document, site, pageTitle);
        const seriesTitle = extractSeriesTitle(document, site, pageTitle);
        const chapterNumber = chapterNumberForPage(url, `${chapterTitle} ${pageTitle}`);
        const seriesUrl = absoluteUrl(
            site?.seriesUrlSelector
                ? document.querySelector(site.seriesUrlSelector)?.getAttribute('href')
                : '',
            url,
        ) || canonicalUrl(document, url) || url;

        const seriesKey = site?.seriesKeySelector
            ? safeText(document.querySelector(site.seriesKeySelector)?.textContent)
            : (seriesSlugFromUrl(seriesUrl) || seriesSlugFromUrl(url) || slugify(seriesTitle));

        return {
            mode: 'chapter',
            site: normalizeSite(url),
            seriesKey,
            seriesTitle: seriesTitle || seriesKey,
            seriesUrl,
            chapter: chapterNumber ?? 0,
            chapterTitle: chapterTitle || '',
            chapterUrl: url,
            contentElement: findContentElement(document, site),
        };
    }

    function extractSeriesPage(document, url, site, pageTitle) {
        const seriesTitle = extractSeriesTitle(document, site, pageTitle);
        return {
            mode: 'series',
            site: normalizeSite(url),
            seriesKey: seriesSlugFromUrl(url) || slugify(seriesTitle),
            seriesTitle: seriesTitle || url,
            seriesUrl: canonicalUrl(document, url) || url,
            chapterLinks: collectChapterLinks(document, site, url),
        };
    }

    function collectChapterLinks(document, site, baseUrl) {
        const selector = site?.chapterLinkSelector || 'a[href]';
        const links = [];
        for (const anchor of document.querySelectorAll(selector)) {
            const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
            if (!href) continue;
            const text = safeText(anchor.textContent);
            const chapter = chapterNumberFromText(text) ?? chapterNumberFromText(href);
            if (chapter == null) continue;
            if (links.some((link) => link.chapter === chapter)) continue;
            links.push({ chapter, title: text, url: href });
        }
        return links.sort((a, b) => a.chapter - b.chapter);
    }

    function paragraphElements(content) {
        if (!content) return [];
        return Array.from(content.querySelectorAll('p, li, blockquote'))
            .filter((element) => safeText(element.textContent).length > 0);
    }

    /**
     * Scroll percentage within the chapter content, independent of font size or
     * viewport width. Falls back to the document when no content container can
     * be identified.
     */
    function calculateProgress(content, viewportHeight, scrollY) {
        const viewport = Math.max(1, Number(viewportHeight) || 1);
        const scroll = Number(scrollY) || 0;

        if (!content) {
            const doc = document.documentElement;
            const total = Math.max(doc.scrollHeight, document.body?.scrollHeight || 0);
            const scrollable = Math.max(1, total - viewport);
            return {
                scrollPercent: clampPercent((scroll / scrollable) * 100),
                paragraphIndex: -1,
            };
        }

        const rect = content.getBoundingClientRect();
        const contentTop = scroll + rect.top;
        const contentHeight = Math.max(content.scrollHeight || 0, rect.height || 0, 1);
        const scrollable = Math.max(1, contentHeight - viewport);
        const scrolled = scroll - contentTop;
        const percent = clampPercent((scrolled / scrollable) * 100);

        // A short chapter has no scroll range of its own; treat it as complete
        // only once the bottom of the content has passed the viewport top.
        const shortChapterDone = contentHeight <= viewport && scroll + viewport >= contentTop + contentHeight;
        const scrollPercent = shortChapterDone ? 100 : percent;

        return {
            scrollPercent,
            // getBoundingClientRect() is viewport-relative, so compare against a
            // viewport coordinate rather than an absolute document position.
            paragraphIndex: firstVisibleParagraphIndex(content, viewport * 0.1),
        };
    }

    function firstVisibleParagraphIndex(content, viewportTop) {
        const paragraphs = paragraphElements(content);
        if (paragraphs.length === 0) return -1;
        const index = paragraphs.findIndex((paragraph) => {
            const rect = paragraph.getBoundingClientRect();
            return rect.bottom > viewportTop;
        });
        return index < 0 ? paragraphs.length - 1 : index;
    }

    function scrollToProgress(content, percent, paragraphIndex) {
        const viewport = window.innerHeight || document.documentElement.clientHeight || 1;
        const clamped = clampPercent(percent);

        if (content && Number.isInteger(paragraphIndex) && paragraphIndex >= 0) {
            const paragraphs = paragraphElements(content);
            const target = paragraphs[paragraphIndex];
            if (target) {
                const rect = target.getBoundingClientRect();
                const targetY = window.scrollY + rect.top - viewport * 0.1;
                window.scrollTo({ top: Math.max(0, targetY), behavior: 'instant' });
                return true;
            }
        }

        if (content) {
            const rect = content.getBoundingClientRect();
            const contentTop = window.scrollY + rect.top;
            const contentHeight = Math.max(content.scrollHeight || 0, rect.height || 0, 1);
            const scrollable = Math.max(1, contentHeight - viewport);
            window.scrollTo({ top: Math.max(0, contentTop + (clamped / 100) * scrollable), behavior: 'instant' });
            return true;
        }

        const total = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
        const scrollable = Math.max(1, total - viewport);
        window.scrollTo({ top: (clamped / 100) * scrollable, behavior: 'instant' });
        return false;
    }

    function clampPercent(value) {
        if (!Number.isFinite(Number(value))) return 0;
        return Math.max(0, Math.min(100, Math.round(Number(value) * 100) / 100));
    }

    function isAhead(candidate, current) {
        if (!candidate) return false;
        if (!current) return true;
        const candidateChapter = Number(candidate.chapter) || 0;
        const currentChapter = Number(current.chapter) || 0;
        if (candidateChapter > currentChapter) return true;
        if (candidateChapter < currentChapter) return false;
        return (Number(candidate.scroll_percent) || 0) > (Number(current.scroll_percent) || 0);
    }

    function progressDeltaIsSignificant(candidate, current, threshold) {
        if (!current) return true;
        if ((Number(candidate.chapter) || 0) !== (Number(current.chapter) || 0)) return true;
        return Math.abs((Number(candidate.scroll_percent) || 0) - (Number(current.scroll_percent) || 0))
            >= Math.max(0, Number(threshold) || 0);
    }

    function localProgressKey(site, seriesKey) {
        return `${LOCAL_PROGRESS_PREFIX}${site}:${seriesKey}`;
    }

    async function storageGet(key) {
        const api = root.browser ?? root.chrome;
        if (!api?.storage?.local) return null;
        return new Promise((resolve) => {
            api.storage.local.get([key], (result) => resolve(result?.[key] ?? null));
        });
    }

    async function storageSet(key, value) {
        const api = root.browser ?? root.chrome;
        if (!api?.storage?.local) return;
        await new Promise((resolve) => api.storage.local.set({ [key]: value }, resolve));
    }

    async function storageRemove(key) {
        const api = root.browser ?? root.chrome;
        if (!api?.storage?.local) return;
        await new Promise((resolve) => api.storage.local.remove(key, resolve));
    }

    async function loadConfig() {
        const raw = await storageGet(CONFIG_KEY);
        return mergeConfig(raw);
    }

    async function saveConfig(config) {
        const normalized = mergeConfig(config);
        await storageSet(CONFIG_KEY, normalized);
        return normalized;
    }

    async function resetConfig() {
        const config = defaultConfig();
        await storageSet(CONFIG_KEY, config);
        return config;
    }

    function apiBase(tracker) {
        const base = String(tracker?.baseUrl || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('Custom sync server URL is not configured.');
        return base + DEFAULT_API_PATH;
    }

    async function apiRequest(tracker, path, options = {}) {
        const base = apiBase(tracker);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeout ?? 15000);
        try {
            const response = await fetch(base + path, {
                method: options.method || 'GET',
                headers: {
                    Authorization: `Bearer ${tracker.token || ''}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: controller.signal,
                keepalive: options.keepalive === true,
                credentials: 'omit',
            });

            const text = await response.text();
            let data = null;
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch {
                    data = { raw: text };
                }
            }

            if (!response.ok && response.status !== 409) {
                const message = data?.error?.message || `Sync server returned HTTP ${response.status}`;
                throw new Error(message);
            }

            return { status: response.status, ok: response.ok, data };
        } finally {
            clearTimeout(timeout);
        }
    }

    async function putProgress(tracker, entry) {
        const result = await apiRequest(tracker, '/progress', { method: 'PUT', body: entry, keepalive: true });
        return {
            applied: result.data?.applied === true,
            entry: result.data?.entry || null,
        };
    }

    /**
     * Looks up the server position for a series. The server matches with a
     * LIKE query, so entries are compared exactly first and then tolerantly:
     * an older bind may have stored a slug variant of the same key (for
     * example a title slug with a site suffix), and both directions are
     * covered by prefix comparison.
     */
    async function findProgress(tracker, site, seriesKey) {
        const query = new URLSearchParams({
            site,
            q: seriesKey,
            limit: '100',
        });
        const result = await apiRequest(tracker, `/progress?${query.toString()}`);
        const entries = (result.data?.entries || []).filter((entry) => Number(entry.chapter) >= 1);
        const candidates = entries.filter((entry) => entry.site === site);
        const exact = candidates.find((entry) => entry.series_key === seriesKey);
        if (exact) return exact;
        const needle = seriesKey.toLowerCase();
        return candidates.find((entry) => {
            const stored = String(entry.series_key || '').toLowerCase();
            return stored.startsWith(needle) || needle.startsWith(stored);
        }) || null;
    }

    async function listProgress(tracker, query = '') {
        const params = new URLSearchParams({ limit: '200' });
        if (query) params.set('q', query);
        const result = await apiRequest(tracker, `/progress?${params.toString()}`);
        return result.data?.entries || [];
    }

    async function health(tracker) {
        const base = String(tracker?.baseUrl || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('Custom sync server URL is not configured.');
        const response = await fetch(`${base}${DEFAULT_API_PATH}/health`, { credentials: 'omit' });
        if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}`);
        return response.json();
    }

    /**
     * Builds a server entry from the extracted page. Returns null when the
     * page is not a usable chapter (no chapter number detected): pushing a
     * chapter-0 entry would poison the server row and block real progress.
     */
    function makeEntry(page, progress, device) {
        const chapter = Number(page.chapter);
        if (!Number.isFinite(chapter) || chapter < 1) return null;
        const percent = clampPercent(progress.scrollPercent);
        return {
            site: page.site,
            series_key: page.seriesKey,
            series_title: page.seriesTitle,
            series_url: page.seriesUrl,
            chapter,
            chapter_title: page.chapterTitle,
            chapter_url: page.chapterUrl,
            scroll_percent: percent,
            // Explicit completion signal: the phone derives chapter read state
            // from this, so a 100% chapter must not be left as "reading".
            status: percent >= 100 ? 'completed' : 'reading',
            paragraph_index: Number.isInteger(progress.paragraphIndex) ? progress.paragraphIndex : -1,
            updated_at: Date.now(),
            device: device || 'browser',
        };
    }

    /**
     * Generates a random sync token (32 lowercase hex chars). Tokens are data
     * buckets on the server, not registered secrets - the first client to use
     * one defines it, so generating here is safe.
     */
    function generateToken() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
        return out;
    }

    const Shiori = {
        CONFIG_KEY,
        DEFAULT_API_PATH,
        DEFAULT_SITES,
        DEFAULT_TRACKERS,
        defaultConfig,
        mergeConfig,
        normalizeSite,
        hostMatches,
        findSite,
        getActiveTracker,
        generateToken,
        slugify,
        seriesSlugFromUrl,
        safeText,
        chapterNumberFromText,
        stripChapterFromTitle,
        extractChapterPage,
        extractSeriesPage,
        collectChapterLinks,
        calculateProgress,
        firstVisibleParagraphIndex,
        scrollToProgress,
        clampPercent,
        isAhead,
        progressDeltaIsSignificant,
        localProgressKey,
        storageGet,
        storageSet,
        storageRemove,
        loadConfig,
        saveConfig,
        resetConfig,
        apiRequest,
        putProgress,
        findProgress,
        listProgress,
        health,
        makeEntry,
    };

    root.Shiori = Shiori;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Shiori;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
