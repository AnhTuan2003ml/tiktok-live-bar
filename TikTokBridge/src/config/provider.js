'use strict';

const LIVE_PROVIDERS = ['piratetok', 'auto', 'tiktok', 'tikfinity'];
const DEFAULT_LIVE_PROVIDER = 'piratetok';

function normalizeProvider(value) {
    const provider = String(value ?? '').trim().toLowerCase();
    return LIVE_PROVIDERS.includes(provider) ? provider : DEFAULT_LIVE_PROVIDER;
}

module.exports = { DEFAULT_LIVE_PROVIDER, LIVE_PROVIDERS, normalizeProvider };
