'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_LIVE_PROVIDER,
    LIVE_PROVIDERS,
    normalizeProvider
} = require('../src/config/provider');

test('exposes the supported providers, TikFinity is the default', () => {
    assert.deepEqual(LIVE_PROVIDERS, ['tikfinity', 'tiktok', 'auto']);
    assert.equal(DEFAULT_LIVE_PROVIDER, 'tikfinity');
});

test('accepts the supported providers', () => {
    assert.equal(normalizeProvider('auto'), 'auto');
    assert.equal(normalizeProvider('tiktok'), 'tiktok');
    assert.equal(normalizeProvider('tikfinity'), 'tikfinity');
});

test('is case-insensitive and trims whitespace', () => {
    assert.equal(normalizeProvider('  Auto  '), 'auto');
    assert.equal(normalizeProvider('TikFinity'), 'tikfinity');
    assert.equal(normalizeProvider('TIKTOK'), 'tiktok');
});

test('falls back to the default (tikfinity) for missing or invalid providers', () => {
    assert.equal(normalizeProvider(undefined), 'tikfinity');
    assert.equal(normalizeProvider(null), 'tikfinity');
    assert.equal(normalizeProvider(''), 'tikfinity');
    assert.equal(normalizeProvider('whatever'), 'tikfinity');
    assert.equal(normalizeProvider(123), 'tikfinity');
});
