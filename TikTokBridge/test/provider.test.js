'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_LIVE_PROVIDER,
    LIVE_PROVIDERS,
    normalizeProvider
} = require('../src/config/provider');

test('exposes exactly the three supported providers', () => {
    assert.deepEqual(LIVE_PROVIDERS, ['auto', 'tiktok', 'tikfinity']);
    assert.equal(DEFAULT_LIVE_PROVIDER, 'auto');
});

test('accepts the three supported providers', () => {
    assert.equal(normalizeProvider('auto'), 'auto');
    assert.equal(normalizeProvider('tiktok'), 'tiktok');
    assert.equal(normalizeProvider('tikfinity'), 'tikfinity');
});

test('is case-insensitive and trims whitespace', () => {
    assert.equal(normalizeProvider('  Auto  '), 'auto');
    assert.equal(normalizeProvider('TikFinity'), 'tikfinity');
    assert.equal(normalizeProvider('TIKTOK'), 'tiktok');
});

test('falls back to auto for missing or invalid providers', () => {
    assert.equal(normalizeProvider(undefined), 'auto');
    assert.equal(normalizeProvider(null), 'auto');
    assert.equal(normalizeProvider(''), 'auto');
    assert.equal(normalizeProvider('whatever'), 'auto');
    assert.equal(normalizeProvider(123), 'auto');
});
