const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeMasterConfig, resolveMasterRule, applyRule, applyBuiltInChatCommand } = require('../src/master/rules');

const master = sanitizeMasterConfig({
    joinMode: 'keyword_only',
    giftAlwaysJoins: true,
    rules: [
        { id: 'hey', source: 'chat', trigger: 'hey', action: 'join' },
        { id: 'rose', source: 'gift', trigger: 'Rose, Hoa hồng', action: 'camera', durationMs: 4000 },
        { id: 'rosa', source: 'gift', giftId: '777', trigger: 'Rosa', action: 'medal', label: 'CÁNH VIP' }
    ]
});

test('matches Vietnamese aliases without accents or case sensitivity', () => {
    const rule = resolveMasterRule(master, { type: 'gift', giftName: 'HOA HỒNG' });
    assert.equal(rule.id, 'rose');
    const event = applyRule({ type: 'gift', giftName: 'HOA HỒNG' }, rule);
    assert.equal(event.action, 'camera');
    assert.equal(event.durationMs, 4000);
});

test('gift id wins even when localized gift name changes', () => {
    const rule = resolveMasterRule(master, { type: 'gift', giftId: '777', giftName: 'Localized name' });
    assert.equal(rule.id, 'rosa');
    assert.equal(applyRule({ type: 'gift' }, rule).label, 'CÁNH VIP');
});

test('gift id rule wins over an earlier matching name rule', () => {
    const config = sanitizeMasterConfig({
        rules: [
            { id: 'generic-name', source: 'gift', trigger: 'Rose', action: 'dance' },
            { id: 'learned-id', source: 'gift', trigger: 'Rose', giftId: '5655', action: 'camera' }
        ]
    });
    assert.equal(resolveMasterRule(config, { type: 'gift', giftId: '5655', giftName: 'Rose' }).id, 'learned-id');
});

test('chat hey maps to join', () => {
    const rule = resolveMasterRule(master, { type: 'chat', comment: 'hey' });
    assert.equal(rule.action, 'join');
});

test('jump and nhảy comments trigger a short built-in jump without a gift rule', () => {
    assert.equal(applyBuiltInChatCommand({ type: 'chat', comment: 'jump' }).action, 'jump');
    const event = applyBuiltInChatCommand({ type: 'chat', comment: 'NHẢY' });
    assert.equal(event.action, 'jump');
    assert.equal(event.durationMs, 950);
    assert.equal(applyBuiltInChatCommand({ type: 'gift', giftName: 'Jump' }).action, undefined);
});

test('explicit any-chat rule matches without using an empty trigger as a wildcard', () => {
    const anyConfig = sanitizeMasterConfig({
        rules: [
            { id: 'empty-exact', source: 'chat', trigger: '', match: 'exact', action: 'dance' },
            { id: 'any-chat', source: 'chat', trigger: '', match: 'any', action: 'walk' }
        ]
    });
    const rule = resolveMasterRule(anyConfig, { type: 'chat', comment: 'xin chào mọi người' });
    assert.equal(rule.id, 'any-chat');
    assert.equal(applyRule({ type: 'chat' }, rule).action, 'walk');
});

test('jump is accepted as a configurable master action', () => {
    const config = sanitizeMasterConfig({ rules: [{ id: 'jump-rule', source: 'chat', trigger: 'bay', action: 'jump' }] });
    const rule = resolveMasterRule(config, { type: 'chat', comment: 'bay' });
    assert.equal(applyRule({ type: 'chat' }, rule).action, 'jump');
});


test('decoration condition defaults to always and preserves top-only mode', () => {
    const config = sanitizeMasterConfig({
        rules: [
            { id: 'wing-always', source: 'chat', trigger: 'hey', action: 'medal' },
            { id: 'wing-top', source: 'chat', trigger: 'vip', action: 'medal', decorationCondition: 'top_only' }
        ]
    });
    assert.equal(config.rules[0].decorationCondition, 'always');
    assert.equal(config.rules[1].decorationCondition, 'top_only');
    const rule = resolveMasterRule(config, { type: 'chat', comment: 'vip' });
    assert.equal(applyRule({ type: 'chat' }, rule).decorationCondition, 'top_only');
});
