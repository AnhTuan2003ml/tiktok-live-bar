'use strict';

const LIVE_PROVIDERS = ['auto', 'tiktok', 'tikfinity'];
const DEFAULT_LIVE_PROVIDER = 'auto';

function normalizeProvider(value) {
    const provider = String(value ?? '').trim().toLowerCase();
    return LIVE_PROVIDERS.includes(provider) ? provider : DEFAULT_LIVE_PROVIDER;
}

module.exports = { DEFAULT_LIVE_PROVIDER, LIVE_PROVIDERS, normalizeProvider };
