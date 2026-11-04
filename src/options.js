(function () {
    'use strict';

    const S = globalThis.Shiori;
    if (!S) return;

    const $ = (id) => document.getElementById(id);
    let config = null;

    const trackerForm = $('tracker-form');
    const siteForm = $('site-form');
    const importFile = $('import-file');

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === 'text') node.textContent = value;
            else if (key === 'className') node.className = value;
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key in node) node[key] = value;
            else node.setAttribute(key, value);
        }
        for (const child of [].concat(children)) {
            if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
    }

    function toast(message, tone) {
        const node = $('toast');
        node.textContent = message;
        node.style.background = tone === 'error' ? 'var(--danger)' : 'var(--accent)';
        node.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => node.classList.remove('show'), 3000);
    }

    function setStatus(id, message, tone) {
        const node = $(id);
        node.textContent = message || '';
        node.className = `status${tone ? ` ${tone}` : ''}`;
    }

    function trackerTypeLabel(type) {
        return type === 'custom' ? 'custom server' : type;
    }

    function renderTrackers() {
        const list = $('tracker-list');
        list.replaceChildren();

        for (const tracker of config.trackers) {
            const active = tracker.id === config.activeTrackerId;
            const main = el('div', { className: 'row-main' }, [
                el('div', { className: 'row-title', text: tracker.name }),
                el('div', { className: 'row-sub' }, [
                    el('span', { className: 'badge', text: trackerTypeLabel(tracker.type) }),
                    ' ',
                    tracker.type === 'custom'
                        ? (tracker.baseUrl || 'Server URL not set')
                        : (tracker.note || 'Chapter-level sync is handled by the Shiori app.'),
                ]),
            ]);

            const actions = el('div', { className: 'row-actions' });
            if (active) {
                actions.appendChild(el('span', { className: 'badge', text: 'active' }));
            } else if (tracker.type === 'custom') {
                actions.appendChild(el('button', {
                    type: 'button',
                    text: 'Use',
                    onclick: async () => {
                        config.activeTrackerId = tracker.id;
                        config = await S.saveConfig(config);
                        renderTrackers();
                        toast(`Using ${tracker.name}`);
                    },
                }));
            }

            if (tracker.type === 'custom') {
                actions.appendChild(el('button', {
                    type: 'button',
                    text: 'Edit',
                    onclick: () => openTrackerForm(tracker),
                }));
                actions.appendChild(el('button', {
                    type: 'button',
                    text: 'Pair phone',
                    title: 'Show a QR code that configures the Shiori app for this server.',
                    onclick: () => pairWithPhone(tracker),
                }));
                actions.appendChild(el('button', {
                    type: 'button',
                    className: 'danger',
                    text: 'Remove',
                    onclick: async () => {
                        if (!confirm(`Remove ${tracker.name}?`)) return;
                        config.trackers = config.trackers.filter((item) => item.id !== tracker.id);
                        config = await S.saveConfig(config);
                        renderTrackers();
                        toast('Server removed');
                    },
                }));
            }

            list.appendChild(el('div', { className: 'row' }, [main, actions]));
        }
    }

    function openTrackerForm(tracker) {
        $('tracker-id').value = tracker?.id || '';
        $('tracker-name').value = tracker?.name || '';
        $('tracker-url').value = tracker?.baseUrl || '';
        $('tracker-token').value = tracker?.token || '';
        setStatus('tracker-status', '');
        trackerForm.classList.remove('hidden');
        $('tracker-name').focus();
    }

    function closeTrackerForm() {
        trackerForm.classList.add('hidden');
        trackerForm.reset();
        $('tracker-id').value = '';
        setStatus('tracker-status', '');
    }

    function normalizeBaseUrl(value) {
        let text = String(value || '').trim();
        if (!text) return '';
        if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
        try {
            const url = new URL(text);
            return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}`.replace(/\/+$/, '');
        } catch {
            return '';
        }
    }

    async function saveTrackerFromForm(event) {
        event.preventDefault();
        const id = $('tracker-id').value;
        const name = $('tracker-name').value.trim();
        const baseUrl = normalizeBaseUrl($('tracker-url').value);
        const token = $('tracker-token').value.trim();

        if (!name) return setStatus('tracker-status', 'Give the server a name.', 'error');
        if (!baseUrl) return setStatus('tracker-status', 'Enter a valid http(s) server URL.', 'error');
        if (!token) return setStatus('tracker-status', 'Enter the token used by the Shiori app (its identity on the server).', 'error');

        const tracker = { id: id || `custom-${crypto.randomUUID?.() || Date.now().toString(36)}`, type: 'custom', name, baseUrl, token, enabled: true };
        const index = config.trackers.findIndex((item) => item.id === tracker.id);
        if (index >= 0) config.trackers[index] = tracker;
        else config.trackers.unshift(tracker);
        if (!id) config.activeTrackerId = tracker.id;

        config = await S.saveConfig(config);
        renderTrackers();
        closeTrackerForm();
        toast('Server saved');
    }

    async function testTracker() {
        const baseUrl = normalizeBaseUrl($('tracker-url').value);
        const token = $('tracker-token').value.trim();
        if (!baseUrl) return setStatus('tracker-status', 'Enter a valid http(s) server URL.', 'error');
        if (!token) return setStatus('tracker-status', 'Enter the API token first.', 'error');

        setStatus('tracker-status', 'Testing…');
        try {
            const info = await S.health({ baseUrl });
            const entries = await S.listProgress({ baseUrl, token }, '');
            const version = info?.version ? ` v${info.version}` : '';
            setStatus('tracker-status', `Connected${version}. ${entries.length} saved ${entries.length === 1 ? 'entry' : 'entries'}.`, 'ok');
        } catch (error) {
            setStatus('tracker-status', error.message || 'Connection failed.', 'error');
        }
    }

    function buildPairUri(tracker) {
        const host = encodeURIComponent(normalizeBaseUrl(tracker.baseUrl));
        const token = encodeURIComponent(tracker.token || '');
        return `shiori://pair?host=${host}&token=${token}`;
    }

    async function pairWithPhone(tracker) {
        const baseUrl = normalizeBaseUrl(tracker.baseUrl);
        if (!baseUrl) return setStatus('tracker-status', 'Set the server URL before pairing.', 'error');
        if (!tracker.token) return setStatus('tracker-status', 'Set the API token before pairing.', 'error');

        const payload = buildPairUri({ ...tracker, baseUrl });
        const { default: qrcode } = await import('./lib/qrcode.mjs');
        const qr = qrcode(0, 'M');
        qr.addData(payload, 'Byte');
        qr.make();
        $('pair-qr').src = qr.createDataURL(6, 12);
        $('pair-token').value = tracker.token;
        $('pair-token-details').open = false;
        $('pair-modal').classList.remove('hidden');
    }

    function closePairModal() {
        $('pair-modal').classList.add('hidden');
        $('pair-qr').removeAttribute('src');
        $('pair-token').value = '';
    }

    function siteTypeLabel(site) {
        if (site.id === 'generic' || site.host === '*') return 'fallback';
        return site.type || 'custom';
    }

    function renderSites() {
        const list = $('site-list');
        list.replaceChildren();

        for (const site of config.sites) {
            const isGeneric = site.id === 'generic' || site.host === '*';
            const main = el('div', { className: 'row-main' }, [
                el('div', { className: 'row-title', text: site.name }),
                el('div', { className: 'row-sub' }, [
                    el('span', { className: 'badge', text: siteTypeLabel(site) }),
                    ' ',
                    `${site.host} · ${site.mode === 'series' ? 'series page' : 'chapter page'}`,
                ]),
            ]);

            const actions = el('div', { className: 'row-actions' });
            actions.appendChild(el('span', {
                className: 'badge',
                text: site.enabled === false ? 'off' : 'on',
            }));
            actions.appendChild(el('button', {
                type: 'button',
                text: site.enabled === false ? 'Enable' : 'Disable',
                title: isGeneric && site.host === '*' && site.enabled === false
                    ? 'Enable this to track any HTTP(S) article page with the generic heuristics.'
                    : '',
                onclick: async () => {
                    site.enabled = site.enabled === false;
                    config = await S.saveConfig(config);
                    renderSites();
                },
            }));

            if (!isGeneric) {
                actions.appendChild(el('button', {
                    type: 'button',
                    text: 'Edit',
                    onclick: () => openSiteForm(site),
                }));
                actions.appendChild(el('button', {
                    type: 'button',
                    className: 'danger',
                    text: 'Remove',
                    onclick: async () => {
                        if (!confirm(`Remove ${site.name}?`)) return;
                        config.sites = config.sites.filter((item) => item.id !== site.id);
                        config = await S.saveConfig(config);
                        renderSites();
                        toast('Site removed');
                    },
                }));
            }

            list.appendChild(el('div', { className: 'row' }, [main, actions]));
        }
    }

    function openSiteForm(site) {
        $('site-id').value = site?.id || '';
        $('site-name').value = site?.name || '';
        $('site-host').value = site?.host || '';
        $('site-mode').value = site?.mode || 'chapter';
        $('site-title-selector').value = site?.titleSelector || '';
        $('site-chapter-title-selector').value = site?.chapterTitleSelector || '';
        $('site-content-selector').value = site?.contentSelector || (site?.contentSelectors || [])[0] || '';
        $('site-series-url-selector').value = site?.seriesUrlSelector || '';
        $('site-chapter-link-selector').value = site?.chapterLinkSelector || '';
        setStatus('site-status', '');
        siteForm.classList.remove('hidden');
        $('site-name').focus();
    }

    function closeSiteForm() {
        siteForm.classList.add('hidden');
        siteForm.reset();
        $('site-id').value = '';
        setStatus('site-status', '');
    }

    function normalizeHost(value) {
        const text = String(value || '').trim();
        if (text === '*') return '*';
        return S.normalizeSite(text);
    }

    async function saveSiteFromForm(event) {
        event.preventDefault();
        const id = $('site-id').value;
        const name = $('site-name').value.trim();
        const host = normalizeHost($('site-host').value);
        const mode = $('site-mode').value === 'series' ? 'series' : 'chapter';

        if (!name) return setStatus('site-status', 'Give the site a name.', 'error');
        if (!host) return setStatus('site-status', 'Enter a valid host such as reader.example.com.', 'error');

        const site = {
            id: id || `site-${crypto.randomUUID?.() || Date.now().toString(36)}`,
            type: 'custom',
            name,
            host,
            mode,
            enabled: true,
            titleSelector: $('site-title-selector').value.trim(),
            chapterTitleSelector: $('site-chapter-title-selector').value.trim(),
            contentSelector: $('site-content-selector').value.trim(),
            seriesUrlSelector: $('site-series-url-selector').value.trim(),
            chapterLinkSelector: $('site-chapter-link-selector').value.trim(),
        };

        const index = config.sites.findIndex((item) => item.id === site.id);
        if (index >= 0) config.sites[index] = site;
        else config.sites.unshift(site);

        config = await S.saveConfig(config);
        renderSites();
        closeSiteForm();
        toast('Site saved');
    }

    function renderBehavior() {
        $('auto-restore').checked = config.autoRestore !== false;
        $('restore-threshold').value = String(config.restoreThresholdPercent ?? 3);
    }

    async function saveAll() {
        config.autoRestore = $('auto-restore').checked;
        config.restoreThresholdPercent = Math.max(0, Math.min(100, Number($('restore-threshold').value) || 0));
        config = await S.saveConfig(config);
        renderBehavior();
        setStatus('global-status', 'Saved.', 'ok');
        toast('Changes saved');
    }

    function exportConfig() {
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = el('a', { href: url, download: 'shiori-sync-config.json' });
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function importConfig(file) {
        const text = await file.text();
        const parsed = JSON.parse(text);
        config = await S.saveConfig(parsed);
        renderAll();
        setStatus('global-status', `Imported ${file.name}.`, 'ok');
        toast('Configuration imported');
    }

    async function resetConfig() {
        if (!confirm('Reset all trackers, sites and behavior settings?')) return;
        config = await S.resetConfig();
        renderAll();
        setStatus('global-status', 'Reset to defaults.', 'ok');
        toast('Reset to defaults');
    }

    function renderAll() {
        renderTrackers();
        renderSites();
        renderBehavior();
    }

    async function main() {
        config = await S.loadConfig();
        renderAll();

        $('add-tracker').addEventListener('click', () => openTrackerForm(null));
        $('cancel-tracker').addEventListener('click', closeTrackerForm);
        $('test-tracker').addEventListener('click', testTracker);
        trackerForm.addEventListener('submit', saveTrackerFromForm);

        $('pair-close').addEventListener('click', closePairModal);
        $('pair-modal').addEventListener('click', (event) => {
            if (event.target === $('pair-modal')) closePairModal();
        });
        $('pair-copy').addEventListener('click', async () => {
            const token = $('pair-token').value;
            if (!token) return;
            await navigator.clipboard.writeText(token).catch(() => {});
            toast('Token copied');
        });

        $('add-site').addEventListener('click', () => openSiteForm(null));
        $('cancel-site').addEventListener('click', closeSiteForm);
        siteForm.addEventListener('submit', saveSiteFromForm);

        $('save-all').addEventListener('click', saveAll);
        $('export-config').addEventListener('click', exportConfig);
        $('import-config').addEventListener('click', () => importFile.click());
        $('reset-config').addEventListener('click', resetConfig);
        importFile.addEventListener('change', async () => {
            const file = importFile.files?.[0];
            importFile.value = '';
            if (!file) return;
            try {
                await importConfig(file);
            } catch (error) {
                setStatus('global-status', `Import failed: ${error.message}`, 'error');
            }
        });
    }

    main().catch((error) => {
        setStatus('global-status', `Could not load options: ${error.message}`, 'error');
    });
})();
