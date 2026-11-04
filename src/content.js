/**
 * Content-script entry point for the Shiori Reading Sync extension.
 *
 * It detects the active site profile, reads the current chapter / scroll
 * position, restores a newer position from the custom tracker, and pushes
 * monotonic progress back with a client-supplied `updated_at` timestamp.
 */
(function () {
    'use strict';

    const S = globalThis.Shiori;
    if (!S) return;

    const PUSH_DEBOUNCE_MS = 1500;
    const MIN_PUSH_INTERVAL_MS = 5000;
    const CONTENT_WAIT_MS = 12000;
    const URL_POLL_MS = 1200;

    let config = null;
    let tracker = null;
    let site = null;
    let page = null;
    let contentElement = null;
    let currentProgress = null;
    let currentLocal = null;
    let pushTimer = null;
    let lastPushAt = 0;
    let suppressUntil = 0;
    let userInteracted = false;
    let initToken = 0;
    let lastHref = location.href;
    let lastErrorToastAt = 0;
    let cleanupPage = null;

    function debug(...args) {
        // Keep the extension quiet on normal reading; useful when debugging a site profile.
        if (config?.debug) console.debug('[Shiori]', ...args);
    }

    function showToast(message, tone) {
        try {
            const id = 'shiori-sync-toast';
            document.getElementById(id)?.remove();
            const toast = document.createElement('div');
            toast.id = id;
            toast.setAttribute('role', 'status');
            toast.textContent = message;
            toast.style.cssText = [
                'position:fixed',
                'right:16px',
                'bottom:16px',
                'z-index:2147483647',
                'max-width:min(360px,calc(100vw - 32px))',
                'padding:10px 14px',
                'border-radius:10px',
                'background:' + (tone === 'error' ? '#7f1d1d' : '#111827'),
                'color:#f9fafb',
                'font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif',
                'box-shadow:0 8px 24px rgba(0,0,0,.28)',
                'opacity:0',
                'transition:opacity .18s ease',
                'pointer-events:none',
            ].join(';');
            document.documentElement.appendChild(toast);
            requestAnimationFrame(() => { toast.style.opacity = '1'; });
            setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 250);
            }, tone === 'error' ? 6000 : 3500);
        } catch {
            // Never let optional UI break reading.
        }
    }

    function errorToast(message) {
        const now = Date.now();
        if (now - lastErrorToastAt < 60000) return;
        lastErrorToastAt = now;
        showToast(message, 'error');
    }

    async function getActiveCustomTracker() {
        if (!config) return null;
        const active = S.getActiveTracker(config);
        if (!active) return null;
        if (active.type !== 'custom') {
            debug('active tracker is not a custom server', active.type);
            return null;
        }
        if (!active.baseUrl) {
            errorToast('Configure the Shiori custom sync server in the extension options.');
            return null;
        }
        return active;
    }

    async function init() {
        const token = ++initToken;
        cleanupPage?.();
        cleanupPage = null;
        clearTimeout(pushTimer);
        pushTimer = null;
        userInteracted = false;
        currentProgress = null;
        currentLocal = null;
        page = null;
        contentElement = null;

        config = await S.loadConfig();
        if (token !== initToken) return;

        site = S.findSite(config, location.href);
        if (!site) {
            debug('no site profile for', location.href);
            return;
        }

        tracker = await getActiveCustomTracker();
        if (!tracker) return;

        if (site.mode === 'series') {
            initSeriesMode(token);
            return;
        }

        await initChapterMode(token);
    }

    async function waitForChapterContent(token) {
        const started = Date.now();
        let last = null;
        while (Date.now() - started < CONTENT_WAIT_MS && token === initToken) {
            last = S.extractChapterPage(document, location.href, site, document.title);
            const text = last.contentElement?.textContent?.trim() || '';
            if (text.length > 200) return last;
            await sleep(350);
        }
        return last || S.extractChapterPage(document, location.href, site, document.title);
    }

    async function initChapterMode(token) {
        page = await waitForChapterContent(token);
        if (token !== initToken) return;

        contentElement = page.contentElement;
        if (!page.seriesKey || !page.chapter) {
            debug('chapter page could not be identified; skipping');
            return;
        }

        const key = S.localProgressKey(page.site, page.seriesKey);
        let local = null;
        try {
            local = await S.storageGet(key);
        } catch {
            local = null;
        }

        let remote = null;
        try {
            remote = await S.findProgress(tracker, page.site, page.seriesKey);
        } catch (error) {
            debug('pull failed', error);
        }

        if (token !== initToken) return;

        const remoteAhead = remote && S.isAhead(remote, local);
        currentLocal = remoteAhead ? remote : (local || remote || null);

        if (remoteAhead && config.autoRestore) {
            adoptRemotePosition(remote, local);
        } else if (remote && !local) {
            // Nothing local yet. Remember the server position so the first scroll
            // doesn't push a lower value with a newer timestamp.
            currentLocal = remote;
        }

        attachChapterListeners(token);
        debug('chapter tracking ready', { page, remote, local });
    }

    function adoptRemotePosition(remote, local) {
        if (!remote) return;
        const sameChapter = Number(remote.chapter) === Number(page.chapter);
        const significant = S.progressDeltaIsSignificant(remote, local, config.restoreThresholdPercent);

        if (sameChapter && significant) {
            suppressUntil = Date.now() + 2200;
            const appliedParagraph = Number.isInteger(remote.paragraph_index) && remote.paragraph_index >= 0;
            S.scrollToProgress(
                contentElement,
                remote.scroll_percent,
                appliedParagraph ? remote.paragraph_index : -1,
            );
            showToast(`Restored ${formatPercent(remote.scroll_percent)} of this chapter from Shiori.`);
            return;
        }

        if (Number(remote.chapter) > Number(page.chapter)) {
            showToast(`Shiori is at chapter ${formatChapter(remote.chapter)}. Open that chapter to continue.`);
        }
    }

    function attachChapterListeners(token) {
        const markInteraction = () => {
            userInteracted = true;
        };
        const interactionEvents = ['pointerdown', 'wheel', 'touchstart', 'keydown'];
        for (const eventName of interactionEvents) {
            window.addEventListener(eventName, markInteraction, { passive: true });
        }

        const onScroll = () => {
            if (Date.now() < suppressUntil) return;
            schedulePush();
        };
        window.addEventListener('scroll', onScroll, { passive: true });

        const onPageHide = () => flushProgress(true);
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') flushProgress(true);
        };
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('visibilitychange', onVisibility);

        // The page may finish loading images/fonts after our first calculation.
        let observer = null;
        if (typeof ResizeObserver === 'function' && document.body) {
            observer = new ResizeObserver(() => {
                if (userInteracted && Date.now() >= suppressUntil) schedulePush();
            });
            observer.observe(document.body);
        }

        // Some readers keep the same URL for every chapter. Re-check the title on
        // navigation-like DOM changes and re-init when the chapter changes.
        let lastSignature = `${location.href}|${document.title}`;
        const urlTimer = setInterval(() => {
            if (token !== initToken) {
                clearInterval(urlTimer);
                return;
            }
            const signature = `${location.href}|${document.title}`;
            if (signature === lastSignature) return;
            lastSignature = signature;
            const next = S.extractChapterPage(document, location.href, site, document.title);
            if (next.chapter !== page?.chapter || next.seriesKey !== page?.seriesKey) {
                flushProgress(true);
                init();
            } else {
                contentElement = next.contentElement || contentElement;
            }
        }, URL_POLL_MS);

        cleanupPage = () => {
            clearInterval(urlTimer);
            observer?.disconnect();
            for (const eventName of interactionEvents) {
                window.removeEventListener(eventName, markInteraction);
            }
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('pagehide', onPageHide);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }

    function schedulePush() {
        if (!userInteracted || Date.now() < suppressUntil) return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => flushProgress(false), PUSH_DEBOUNCE_MS);
    }

    async function flushProgress(force) {
        if (!page || !tracker) return;
        if (!userInteracted && !force) return;

        const now = Date.now();
        if (!force && now - lastPushAt < MIN_PUSH_INTERVAL_MS) {
            schedulePush();
            return;
        }

        const progress = S.calculateProgress(
            contentElement,
            window.innerHeight || document.documentElement.clientHeight,
            window.scrollY,
        );
        const next = S.makeEntry(page, progress, 'browser');

        // Keep progress monotonic for the same chapter: re-reading backwards
        // should not overwrite where the other device already is. A newer chapter
        // always wins.
        if (currentLocal && !S.isAhead(next, currentLocal)) {
            debug('skipping backward progress', next, currentLocal);
            return;
        }

        lastPushAt = now;
        try {
            const result = await S.putProgress(tracker, next);
            if (result.entry) {
                currentLocal = result.entry;
                await S.storageSet(S.localProgressKey(page.site, page.seriesKey), result.entry);
                if (!result.applied && S.isAhead(result.entry, next)) {
                    // Another device wrote a newer position while this page was open.
                    currentLocal = result.entry;
                    if (Number(result.entry.chapter) === Number(page.chapter)) {
                        adoptRemotePosition(result.entry, next);
                    }
                }
            }
            debug('progress pushed', result);
        } catch (error) {
            debug('progress push failed', error);
            errorToast(`Shiori sync failed: ${error.message}`);
        }
    }

    function initSeriesMode(token) {
        page = S.extractSeriesPage(document, location.href, site, document.title);
        if (!page.seriesKey) return;

        // On NovelUpdates/NovelList, chapters are links to external readers. We
        // can still record which chapter the user chose, which gives the app a
        // chapter-level checkpoint until the reader site's exact position arrives.
        const onClick = (event) => {
            if (token !== initToken) return;
            const anchor = event.target?.closest?.('a[href]');
            if (!anchor) return;
            const href = anchor.href;
            if (!href || href.startsWith('javascript:')) return;

            const text = S.safeText(anchor.textContent);
            const chapter = S.chapterNumberFromText(text) ?? S.chapterNumberFromText(href);
            if (chapter == null) return;

            const entry = {
                site: page.site,
                series_key: page.seriesKey,
                series_title: page.seriesTitle,
                series_url: page.seriesUrl,
                chapter,
                chapter_title: text,
                chapter_url: href,
                scroll_percent: 0,
                paragraph_index: 0,
                updated_at: Date.now(),
                device: 'browser',
            };
            S.putProgress(tracker, entry)
                .then((result) => {
                    const saved = result.entry || entry;
                    S.storageSet(S.localProgressKey(page.site, page.seriesKey), saved);
                    debug('series chapter checkpoint', saved);
                })
                .catch((error) => debug('series checkpoint failed', error));
        };
        document.addEventListener('click', onClick, true);
        cleanupPage = () => document.removeEventListener('click', onClick, true);

        S.findProgress(tracker, page.site, page.seriesKey)
            .then((remote) => {
                if (remote) currentLocal = remote;
            })
            .catch(() => {});
        debug('series tracking ready', page);
    }

    function formatPercent(value) {
        return `${Math.round(Number(value) || 0)}%`;
    }

    function formatChapter(value) {
        const number = Number(value) || 0;
        return Number.isInteger(number) ? String(number) : number.toFixed(1);
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;
    runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'shiori:sync-now') {
            flushProgress(true)
                .then(() => sendResponse({ ok: true, progress: currentLocal }))
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        }
        if (message?.type === 'shiori:status') {
            sendResponse({
                ok: true,
                configured: Boolean(tracker),
                site: site ? { name: site.name, mode: site.mode } : null,
                page: page ? {
                    seriesTitle: page.seriesTitle,
                    chapter: page.chapter,
                    chapterTitle: page.chapterTitle,
                    chapterUrl: page.chapterUrl,
                } : null,
                progress: currentLocal,
            });
            return false;
        }
        return false;
    });

    // Initial run + SPA URL changes.
    init();
    setInterval(() => {
        if (location.href === lastHref) return;
        lastHref = location.href;
        flushProgress(true);
        init();
    }, URL_POLL_MS);
})();
