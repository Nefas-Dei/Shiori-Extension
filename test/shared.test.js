'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/lib/shared.js');

function fakeElement(text, attributes = {}) {
    return {
        textContent: text,
        getAttribute(name) {
            return attributes[name] ?? null;
        },
        getBoundingClientRect() {
            return attributes.rect || { top: 0, bottom: 0 };
        },
    };
}

function fakeDocument({ selectors = {}, all = {} } = {}) {
    return {
        querySelector(selector) {
            return selectors[selector] ?? null;
        },
        querySelectorAll(selector) {
            return all[selector] ?? [];
        },
    };
}

test('chapter number parsing handles common chapter labels', () => {
    assert.equal(S.chapterNumberFromText('Chapter 12'), 12);
    assert.equal(S.chapterNumberFromText('Ch. 3.5'), 3.5);
    assert.equal(S.chapterNumberFromText('Episode 7: A start'), 7);
    assert.equal(S.chapterNumberFromText('Part 2'), 2);
    assert.equal(S.chapterNumberFromText('https://site.test/book/chapter-42'), 42);
    assert.equal(S.chapterNumberFromText('no number here'), null);
});

test('series titles drop trailing chapter labels without removing the title', () => {
    assert.equal(S.stripChapterFromTitle('My Novel - Chapter 12: The End'), 'My Novel');
    assert.equal(S.stripChapterFromTitle('My Novel Chapter 5'), 'My Novel');
    assert.equal(S.stripChapterFromTitle('My Novel'), 'My Novel');
    assert.equal(S.stripChapterFromTitle('A Series — Episode 9'), 'A Series');
});

test('host normalization and matching cover subdomains and ports', () => {
    assert.equal(S.normalizeSite('https://www.Example.com/path'), 'example.com');
    assert.equal(S.normalizeSite('reader.example.com:8443'), 'reader.example.com:8443');
    assert.equal(S.normalizeSite('not a host'), '');

    assert.equal(S.hostMatches('www.example.com', 'example.com'), true);
    assert.equal(S.hostMatches('reader.example.com', 'example.com'), true);
    assert.equal(S.hostMatches('example.com.evil.test', 'example.com'), false);
    assert.equal(S.hostMatches('anything.test', '*'), true);
    assert.equal(S.hostMatches('a.example.com', '*.example.com'), true);
});

test('config merge keeps built-ins, drops presets and legacy generic, preserves user wildcards', () => {
    const config = S.mergeConfig({
        activeTrackerId: 'home',
        autoRestore: false,
        restoreThresholdPercent: 250,
        trackers: [
            { id: 'home', type: 'custom', name: 'Home', baseUrl: 'https://sync.test/', token: 'secret' },
            { id: 'novelupdates', type: 'novelupdates', name: 'NU', enabled: true },
        ],
        sites: [
            { id: 'novelupdates', type: 'preset', host: 'novelupdates.com', mode: 'series', name: 'NovelUpdates' },
            { id: 'reader', host: 'reader.example.com', mode: 'chapter', name: 'Reader' },
            { id: 'generic', type: 'generic', host: '*', mode: 'chapter', name: 'Generic', enabled: false },
            { id: 'site-wild', host: '*', mode: 'chapter', name: 'My wildcard' },
        ],
    });

    assert.equal(config.activeTrackerId, 'home');
    assert.equal(config.autoRestore, false);
    assert.equal(config.restoreThresholdPercent, 100);
    assert.equal(config.trackers.find((t) => t.id === 'home').baseUrl, 'https://sync.test');
    assert.ok(config.trackers.some((t) => t.type === 'custom'));
    // Catalog placeholders (NovelUpdates/NovelList) are migrated away.
    assert.equal(config.trackers.some((t) => t.type === 'novelupdates'), false);
    assert.equal(config.trackers.some((t) => t.type === 'novellist'), false);
    // The extension must not run on unlisted sites: no presets and no legacy
    // generic auto-detect profile. User-added wildcards are kept, last.
    assert.equal(config.sites.some((s) => s.type === 'preset'), false);
    assert.equal(config.sites.some((s) => s.id === 'generic'), false);
    assert.equal(config.sites.at(-1).id, 'site-wild');
    assert.equal(config.sites.find((s) => s.id === 'reader').host, 'reader.example.com');
    // Fresh configs start with no sites at all.
    assert.deepEqual(S.mergeConfig(null).sites, []);
});

test('progress comparison is monotonic per chapter', () => {
    const entry = (chapter, percent) => ({ chapter, scroll_percent: percent });
    assert.equal(S.isAhead(entry(2, 0), entry(1, 90)), true);
    assert.equal(S.isAhead(entry(1, 80), entry(1, 40)), true);
    assert.equal(S.isAhead(entry(1, 40), entry(1, 80)), false);
    assert.equal(S.isAhead(entry(0, 10), null), true);
    assert.equal(S.isAhead(null, entry(1, 10)), false);
});

test('series slugs come from the URL so chapter and series pages agree', () => {
    // Real-world shapes: novelping.com hosts chapters under /book/ and the
    // series index under /novel/. Both must reduce to the same key, while the
    // title fallback would differ ("The Author's POV | NovelPing").
    assert.equal(S.seriesSlugFromUrl('https://novelping.com/book/the-authors-pov/chapter-690'), 'the-authors-pov');
    assert.equal(S.seriesSlugFromUrl('https://novelping.com/novel/the-authors-pov'), 'the-authors-pov');
    // Slug-only chapter URLs (chapter-epilogue-...) still strip cleanly.
    assert.equal(
        S.seriesSlugFromUrl('https://novelping.com/book/the-authors-pov/chapter-epilogue-the-authors-pov'),
        'the-authors-pov',
    );
    // RoyalRoad keeps the novel slug inside its chapter URLs.
    assert.equal(
        S.seriesSlugFromUrl('https://www.royalroad.com/fiction/59372/the-wandering-inn/chapter/78901234'),
        'the-wandering-inn',
    );
    // Numeric-only or container-only paths have no series name: empty result,
    // callers fall back to the page title.
    assert.equal(S.seriesSlugFromUrl('https://site.test/novel/12345'), '');
    assert.equal(S.seriesSlugFromUrl('https://site.test/book'), '');
    assert.equal(S.seriesSlugFromUrl('not a url'), '');
});

test('makeEntry refuses pages without a usable chapter number', () => {
    const page = {
        site: 'example.com',
        seriesKey: 'my-novel',
        seriesTitle: 'My Novel',
        seriesUrl: 'https://example.com/book/my-novel',
        chapter: 0,
        chapterTitle: '',
        chapterUrl: 'https://example.com/novel/my-novel',
    };
    assert.equal(S.makeEntry(page, { scrollPercent: 40, paragraphIndex: -1 }, 'browser'), null);
});

test('makeEntry clamps percentage and keeps the client timestamp', () => {
    const entry = S.makeEntry(
        {
            site: 'example.com',
            seriesKey: 'my-novel',
            seriesTitle: 'My Novel',
            seriesUrl: 'https://example.com/book',
            chapter: 4,
            chapterTitle: 'Chapter 4',
            chapterUrl: 'https://example.com/book/4',
        },
        { scrollPercent: 130.456, paragraphIndex: 7 },
        'browser',
    );
    assert.equal(entry.scroll_percent, 100);
    assert.equal(entry.paragraph_index, 7);
    assert.equal(entry.chapter, 4);
    assert.equal(entry.device, 'browser');
    assert.ok(entry.updated_at <= Date.now());
});

test('chapter links are extracted, de-duplicated and sorted', () => {
    const doc = fakeDocument({
        all: {
            '.chapters a': [
                fakeElement('Chapter 2', { href: '/book/chapter-2' }),
                fakeElement('Chapter 1', { href: '/book/chapter-1' }),
                fakeElement('Chapter 2 duplicate', { href: '/book/chapter-2b' }),
                fakeElement('Read now', { href: '/book' }),
            ],
        },
    });

    const links = S.collectChapterLinks(doc, { chapterLinkSelector: '.chapters a' }, 'https://reader.test/book');
    assert.deepEqual(links.map((link) => link.chapter), [1, 2]);
    assert.equal(links[0].url, 'https://reader.test/book/chapter-1');
});

test('chapter page extraction uses configured selectors and canonical URL', () => {
    const content = fakeElement('x'.repeat(500));
    const doc = fakeDocument({
        selectors: {
            'h1': fakeElement('My Novel'),
            '.chapter-title': fakeElement('Chapter 12: Arrival'),
            'link[rel="canonical"]': fakeElement('', { href: 'https://reader.test/book/my-novel' }),
            'link[rel="canonical"], meta[property="og:url"]': fakeElement('', { href: 'https://reader.test/book/my-novel' }),
            '.chapter-content': content,
        },
        all: {
            '.chapter-content': [content],
        },
    });

    const page = S.extractChapterPage(
        doc,
        'https://reader.test/book/my-novel/chapter-12',
        {
            titleSelector: 'h1',
            chapterTitleSelector: '.chapter-title',
            contentSelector: '.chapter-content',
        },
        'My Novel - Chapter 12',
    );

    assert.equal(page.site, 'reader.test');
    assert.equal(page.seriesTitle, 'My Novel');
    assert.equal(page.seriesKey, 'my-novel');
    assert.equal(page.chapter, 12);
    assert.equal(page.chapterTitle, 'Chapter 12: Arrival');
    assert.equal(page.seriesUrl, 'https://reader.test/book/my-novel');
    assert.equal(page.contentElement, content);
});

test('scroll progress is relative to the content container', () => {
    const paragraphs = [
        { bottom: 100, textContent: 'a' },
        { bottom: 400, textContent: 'b' },
        { bottom: 900, textContent: 'c' },
    ];
    const paragraphNodes = paragraphs.map((paragraph) => ({
        textContent: paragraph.textContent,
        getBoundingClientRect: () => ({ bottom: paragraph.bottom, top: paragraph.bottom - 100 }),
    }));
    const content = {
        scrollHeight: 3000,
        getBoundingClientRect: () => ({ top: -1000, height: 3000 }),
        querySelectorAll: () => paragraphNodes,
    };

    const progress = S.calculateProgress(content, 1000, 2700);
    assert.equal(progress.scrollPercent, 50);
    assert.equal(progress.paragraphIndex, 1);
});

test('short chapters complete when their bottom passes the viewport', () => {
    const content = {
        scrollHeight: 400,
        getBoundingClientRect: () => ({ top: 100, height: 400 }),
        querySelectorAll: () => [],
    };

    const progress = S.calculateProgress(content, 1000, 600);
    assert.equal(progress.scrollPercent, 100);
    assert.equal(progress.paragraphIndex, -1);
});

test('generateToken returns unique 32-char lowercase hex strings', () => {
    const tokens = new Set();
    for (let i = 0; i < 10; i++) {
        const token = S.generateToken();
        assert.match(token, /^[0-9a-f]{32}$/);
        tokens.add(token);
    }
    assert.equal(tokens.size, 10);
});
