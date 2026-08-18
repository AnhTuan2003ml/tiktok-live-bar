'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeOperatorConfig, shouldSpawnForEvent } = require('../src/config/operator');

test('operator defaults spawn chat/gift/follow/share but not like/member', () => {
    const config = sanitizeOperatorConfig({});
    assert.equal(config.spawnEvents.chat, true);
    assert.equal(config.spawnEvents.gift, true);
    assert.equal(config.spawnEvents.follow, true);
    assert.equal(config.spawnEvents.share, true);
    assert.equal(config.spawnEvents.like, false);
    assert.equal(config.spawnEvents.member, false);
});

test('spawn policy is independent for each live event type', () => {
    const config = sanitizeOperatorConfig({ spawnEvents: { chat: false, gift: true, like: true, follow: false, share: false, member: true } });
    assert.equal(shouldSpawnForEvent(config, 'chat'), false);
    assert.equal(shouldSpawnForEvent(config, 'gift'), true);
    assert.equal(shouldSpawnForEvent(config, 'like'), true);
    assert.equal(shouldSpawnForEvent(config, 'member'), true);
});

test('OBS endpoint and local credentials are sanitized and persisted', () => {
    const config = sanitizeOperatorConfig({ obs: { host: ' 127.0.0.1 ', port: 4455, password: 'secret', autoConnect: true } });
    assert.deepEqual(config.obs, { host: '127.0.0.1', port: 4455, password: 'secret', autoConnect: true });
});

test('media config clamps music volume and keeps selected filenames', () => {
    const config = sanitizeOperatorConfig({ media: { musicVolume: 2, backgroundFile: 'nenamphu.png', audioFile: '00-tiso-background.mp3' } });
    assert.equal(config.media.musicVolume, 1);
    assert.equal(config.media.backgroundFile, 'nenamphu.png');
    assert.equal(config.media.audioFile, '00-tiso-background.mp3');
});
