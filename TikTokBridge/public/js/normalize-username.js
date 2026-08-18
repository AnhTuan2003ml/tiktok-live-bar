/* ─────────────────────────────────────────────────────────
   TISO — normalize TikTok username/LIVE URL
   Dùng chung cho Control Panel (browser) và Node Bridge.
   UMD: browser -> window.TikTokUsername, Node -> require()
   © 2025 TISO
───────────────────────────────────────────────────────── */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TikTokUsername = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const TIKTOK_DOMAIN = 'tiktok.com';
    const USERNAME_PATTERN = /^[A-Za-z0-9._]{2,24}$/;
    const PROTOCOL_PATTERN = /^https?:\/\//i;
    const SCHEMELESS_TIKTOK_PATTERN = /^([a-z0-9-]+\.)*tiktok\.com([/:?]|$)/i;

    function isValidTikTokHost(hostname) {
        const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
        return host === TIKTOK_DOMAIN || host.endsWith('.' + TIKTOK_DOMAIN);
    }

    function looksLikeUrl(input) {
        const trimmed = String(input || '').trim();
        if (!trimmed) return false;
        return PROTOCOL_PATTERN.test(trimmed) || SCHEMELESS_TIKTOK_PATTERN.test(trimmed);
    }

    function extractFromUrl(input) {
        const trimmed = String(input || '').trim();
        let url = null;
        if (PROTOCOL_PATTERN.test(trimmed)) {
            try { url = new URL(trimmed); } catch (error) { return null; }
        } else if (SCHEMELESS_TIKTOK_PATTERN.test(trimmed)) {
            try { url = new URL('https://' + trimmed); } catch (error) { return null; }
        } else {
            return null;
        }
        if (!url || !isValidTikTokHost(url.hostname)) return null;
        const match = /^\/@([^/]+)/.exec(url.pathname);
        return match ? decodeURIComponent(match[1]) : null;
    }

    function normalizeTikTokUsername(input) {
        if (typeof input !== 'string') return null;
        const trimmed = input.trim();
        if (!trimmed) return null;

        let candidate;
        if (looksLikeUrl(trimmed)) {
            candidate = extractFromUrl(trimmed);
            if (candidate === null) return null;
        } else {
            candidate = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
        }
        return USERNAME_PATTERN.test(candidate) ? candidate : null;
    }

    return {
        TIKTOK_DOMAIN: TIKTOK_DOMAIN,
        normalizeTikTokUsername: normalizeTikTokUsername,
        extractTikTokUsername: normalizeTikTokUsername,
        isValidTikTokHost: isValidTikTokHost,
        looksLikeUrl: looksLikeUrl
    };
}));
