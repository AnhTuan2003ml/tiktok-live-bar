'use strict';

const LIVE_PROVIDERS = ['tikfinity', 'tiktok', 'auto'];
const DEFAULT_LIVE_PROVIDER = 'tikfinity';

function normalizeProvider(value) {
    const provider = String(value ?? '').trim().toLowerCase();
    return LIVE_PROVIDERS.includes(provider) ? provider : DEFAULT_LIVE_PROVIDER;
}

module.exports = { DEFAULT_LIVE_PROVIDER, LIVE_PROVIDERS, normalizeProvider };
