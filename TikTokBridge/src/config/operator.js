'use strict';

const SPAWN_EVENT_TYPES = ['chat', 'gift', 'like', 'follow', 'share', 'member'];
const DEFAULT_SPAWN_EVENTS = Object.freeze({
    chat: true,
    gift: true,
    like: false,
    follow: true,
    share: true,
    member: false
});

function clampInt(value, minimum, maximum, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
}

function clampFloat(value, minimum, maximum, fallback) {
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
}

function sanitizeOperatorConfig(input = {}) {
    const incomingSpawn = input && typeof input.spawnEvents === 'object' && input.spawnEvents
        ? input.spawnEvents
        : {};
    const spawnEvents = {};
    for (const eventType of SPAWN_EVENT_TYPES) {
        spawnEvents[eventType] = typeof incomingSpawn[eventType] === 'boolean'
            ? incomingSpawn[eventType]
            : DEFAULT_SPAWN_EVENTS[eventType];
    }

    const obsInput = input && typeof input.obs === 'object' && input.obs ? input.obs : {};
    const host = String(obsInput.host || '127.0.0.1').trim().slice(0, 200) || '127.0.0.1';
    const port = clampInt(obsInput.port, 1, 65535, 4455);
    const password = String(obsInput.password || '').slice(0, 512);
    const autoConnect = obsInput.autoConnect !== false;

    const mediaInput = input && typeof input.media === 'object' && input.media ? input.media : {};
    const media = {
        musicVolume: clampFloat(mediaInput.musicVolume, 0, 1, 0.35),
        backgroundFile: String(mediaInput.backgroundFile || 'nenamphu.png').slice(0, 200),
        audioFile: String(mediaInput.audioFile || '').slice(0, 200)
    };

    return {
        spawnEvents,
        obs: { host, port, password, autoConnect },
        media,
        recentEventLimit: clampInt(input.recentEventLimit, 50, 500, 200)
    };
}

function shouldSpawnForEvent(config, eventType) {
    const normalized = sanitizeOperatorConfig(config);
    return SPAWN_EVENT_TYPES.includes(eventType) && normalized.spawnEvents[eventType] === true;
}

module.exports = {
    SPAWN_EVENT_TYPES,
    DEFAULT_SPAWN_EVENTS,
    sanitizeOperatorConfig,
    shouldSpawnForEvent
};
