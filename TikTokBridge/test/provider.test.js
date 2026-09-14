'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_LIVE_PROVIDER,
    LIVE_PROVIDERS,
    normalizeProvider
} = require('../src/config/provider');

test('exposes the supported providers, PirateTok is the free default', () => {
    assert.deepEqual(LIVE_PROVIDERS, ['piratetok', 'auto', 'tiktok', 'tikfinity']);
    assert.equal(DEFAULT_LIVE_PROVIDER, 'piratetok');
});

test('accepts the supported providers', () => {
    assert.equal(normalizeProvider('piratetok'), 'piratetok');
    assert.equal(normalizeProvider('auto'), 'auto');
    assert.equal(normalizeProvider('tiktok'), 'tiktok');
    assert.equal(normalizeProvider('tikfinity'), 'tikfinity');
});

test('is case-insensitive and trims whitespace', () => {
    assert.equal(normalizeProvider('  Auto  '), 'auto');
    assert.equal(normalizeProvider('TikFinity'), 'tikfinity');
    assert.equal(normalizeProvider('TIKTOK'), 'tiktok');
});

test('falls back to the default (piratetok) for missing or invalid providers', () => {
    assert.equal(normalizeProvider(undefined), 'piratetok');
    assert.equal(normalizeProvider(null), 'piratetok');
    assert.equal(normalizeProvider(''), 'piratetok');
    assert.equal(normalizeProvider('whatever'), 'piratetok');
    assert.equal(normalizeProvider(123), 'piratetok');
});
