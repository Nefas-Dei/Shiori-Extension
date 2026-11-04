(function () {
    'use strict';

    const S = globalThis.Shiori;
    if (!S) return;

    const api = globalThis.browser ?? globalThis.chrome;
    const $ = (id) => document.getElementById(id);
    let activeTab = null;
    let config = null;
    let tracker = null;

    function setBadge(text, tone) {
        const badge = $('badge');
        badge.textContent = text;
        badge.className = `badge${tone ? ` ${tone}` : ''}`;
    }

    function setStatus(text, tone) {
        const node = $('status');
        node.textContent = text || '';
        node.className = `status${tone ? ` ${tone}` : ''}`;
    }

    function queryActiveTab() {
        return new Promise((resolve) => {
            if (api === globalThis.browser) {
                api.tabs.query({ active: true, currentWindow: true }).then((tabs) => resolve(tabs[0] || null));
            } else {
                api.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] || null));
            }
        });
    }

    function sendTabMessage(tabId, message) {
        if (api === globalThis.browser) return api.tabs.sendMessage(tabId, message);
        return new Promise((resolve, reject) => {
            api.tabs.sendMessage(tabId, message, (response) => {
                const error = api.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve(response);
            });
        });
    }

    function formatPosition(progress) {
        if (!progress) return '—';
        const chapter = Number(progress.chapter) || 0;
        const percent = Math.round(Number(progress.scroll_percent) || 0);
        return `Ch. ${Number.isInteger(chapter) ? chapter : chapter.toFixed(1)} · ${percent}%`;
    }

    async function refreshStatus() {
        if (!activeTab?.id) return;
        try {
            const status = await sendTabMessage(activeTab.id, { type: 'shiori:status' });
            if (!status?.ok) return;

            if (!status.configured) {
                setStatus('Configure a custom sync server in Options.', 'error');
                return;
            }
            if (!status.site) {
                setStatus('This page does not match an enabled reading site.', 'error');
                return;
            }

            $('site').textContent = `${status.site.name} · ${status.site.mode === 'series' ? 'series' : 'chapter'}`;
            if (status.page) {
                $('chapter').textContent = status.page.chapter
                    ? `Ch. ${status.page.chapter}${status.page.chapterTitle ? ` — ${status.page.chapterTitle}` : ''}`
                    : (status.page.seriesTitle || '—');
            }
            $('position').textContent = formatPosition(status.progress);
            $('sync').disabled = false;
            setBadge('ready', 'ok');
            setStatus(status.site.mode === 'series'
                ? 'Click a chapter link to record a checkpoint.'
                : 'Scroll the chapter; progress syncs automatically.');
        } catch {
            setStatus('Content script is unavailable on this page. Reload the tab after installing or updating the extension.');
            $('sync').disabled = true;
            setBadge('inactive');
        }
    }

    async function syncNow() {
        if (!activeTab?.id) return;
        const button = $('sync');
        button.disabled = true;
        setStatus('Syncing…');
        try {
            const result = await sendTabMessage(activeTab.id, { type: 'shiori:sync-now' });
            if (!result?.ok) throw new Error(result?.error || 'Sync failed');
            $('position').textContent = formatPosition(result.progress);
            setStatus('Progress sent to the sync server.', 'ok');
        } catch (error) {
            setStatus(error.message || 'Sync failed.', 'error');
        } finally {
            button.disabled = false;
        }
    }

    async function main() {
        config = await S.loadConfig();
        tracker = S.getActiveTracker(config);
        activeTab = await queryActiveTab();

        if (tracker?.type === 'custom' && tracker.baseUrl) {
            $('tracker').textContent = tracker.name;
            setBadge('configured');
        } else {
            $('tracker').textContent = 'Not configured';
            setBadge('setup', 'error');
            setStatus('Open options and add your custom sync server.', 'error');
        }

        if (activeTab?.url) {
            const site = S.findSite(config, activeTab.url);
            $('site').textContent = site ? `${site.name} · ${site.mode === 'series' ? 'series' : 'chapter'}` : 'No matching profile';
        }

        if (tracker?.type === 'custom' && tracker.baseUrl) {
            await refreshStatus();
        }

        $('sync').addEventListener('click', syncNow);
        $('options').addEventListener('click', () => {
            if (api === globalThis.browser) api.runtime.openOptionsPage();
            else api.runtime.openOptionsPage();
        });
    }

    main().catch((error) => {
        setBadge('error', 'error');
        setStatus(error.message || 'Could not load extension state.', 'error');
    });
})();
