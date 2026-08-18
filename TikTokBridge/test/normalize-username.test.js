'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    TIKTOK_DOMAIN,
    normalizeTikTokUsername,
    extractTikTokUsername,
    isValidTikTokHost,
    looksLikeUrl
} = require('../public/js/normalize-username');

test('accepts a bare username', () => {
    assert.equal(normalizeTikTokUsername('why.notstore'), 'why.notstore');
});

test('strips a leading @', () => {
    assert.equal(normalizeTikTokUsername('@why.notstore'), 'why.notstore');
});

test('extracts username from a TikTok LIVE URL', () => {
    assert.equal(normalizeTikTokUsername('https://www.tiktok.com/@why.notstore/live'), 'why.notstore');
});

test('extracts username from a URL with query string', () => {
    assert.equal(normalizeTikTokUsername('https://www.tiktok.com/@why.notstore/live?is_from_webapp=1'), 'why.notstore');
});

test('extracts username from a profile URL without /live', () => {
    assert.equal(normalizeTikTokUsername('https://www.tiktok.com/@why.notstore'), 'why.notstore');
});

test('extracts username from the bare tiktok.com host', () => {
    assert.equal(normalizeTikTokUsername('https://tiktok.com/@why.notstore'), 'why.notstore');
});

test('handles fragments and uppercase hosts', () => {
    assert.equal(normalizeTikTokUsername('https://WWW.TIKTOK.COM/@why.notstore#stream'), 'why.notstore');
    assert.equal(normalizeTikTokUsername('https://www.tiktok.com/@why.notstore/live#chat'), 'why.notstore');
});

test('rejects a non-TikTok URL', () => {
    assert.equal(normalizeTikTokUsername('https://example.com/@why.notstore/live'), null);
});

test('rejects a TikTok URL without an @username segment', () => {
    assert.equal(normalizeTikTokUsername('https://www.tiktok.com/live'), null);
    assert.equal(normalizeTikTokUsername('https://www.tiktok.com/'), null);
});

test('rejects a schemeless URL from a non-TikTok host', () => {
    assert.equal(normalizeTikTokUsername('example.com/@why.notstore/live'), null);
});

test('rejects empty and non-string inputs', () => {
    assert.equal(normalizeTikTokUsername(''), null);
    assert.equal(normalizeTikTokUsername('   '), null);
    assert.equal(normalizeTikTokUsername(123), null);
    assert.equal(normalizeTikTokUsername(null), null);
    assert.equal(normalizeTikTokUsername(undefined), null);
});

test('extractTikTokUsername is exposed as an alias', () => {
    assert.equal(extractTikTokUsername, normalizeTikTokUsername);
});

test('validates TikTok hosts only', () => {
    assert.equal(isValidTikTokHost('tiktok.com'), true);
    assert.equal(isValidTikTokHost('www.tiktok.com'), true);
    assert.equal(isValidTikTokHost('live.tiktok.com'), true);
    assert.equal(isValidTikTokHost('example.com'), false);
    assert.equal(isValidTikTokHost('tiktok.com.evil.com'), false);
    assert.equal(isValidTikTokHost(''), false);
});

test('looksLikeUrl detects URL-ish inputs only', () => {
    assert.equal(looksLikeUrl('https://www.tiktok.com/@why.notstore/live'), true);
    assert.equal(looksLikeUrl('www.tiktok.com/@why.notstore'), true);
    assert.equal(looksLikeUrl('why.notstore'), false);
    assert.equal(looksLikeUrl('@why.notstore'), false);
    assert.equal(looksLikeUrl(''), false);
});

test('does not treat a plain username like a TikTok host as a URL', () => {
    assert.equal(normalizeTikTokUsername('@tiktok.com'), 'tiktok.com');
    assert.equal(normalizeTikTokUsername('why.tiktok.fan'), 'why.tiktok.fan');
    assert.equal(TIKTOK_DOMAIN, 'tiktok.com');
});
