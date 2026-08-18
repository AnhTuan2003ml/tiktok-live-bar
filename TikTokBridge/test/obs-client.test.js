'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ObsClient,
    makeObsAuthentication,
    sanitizeObsEndpoint,
    obsInputKindForMode,
    pickObsWindowPropertyItem,
    nextObsSourceName,
    isObsAudioInputKind
} = require('../src/obs/obs-client');

test('OBS authentication follows the protocol SHA-256/base64 challenge flow', () => {
    const auth = makeObsAuthentication('password', 'salt', 'challenge');
    assert.equal(auth, 'zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA=');
});

test('OBS endpoint falls back to local websocket defaults', () => {
    assert.deepEqual(sanitizeObsEndpoint({}), { host: '127.0.0.1', port: 4455 });
    assert.deepEqual(sanitizeObsEndpoint({ host: ' localhost ', port: '4456' }), { host: 'localhost', port: 4456 });
    assert.deepEqual(sanitizeObsEndpoint({ host: '', port: 99999 }), { host: '127.0.0.1', port: 4455 });
});


test('OBS capture mode maps to real Windows OBS input kinds', () => {
    assert.equal(obsInputKindForMode('game'), 'game_capture');
    assert.equal(obsInputKindForMode('window'), 'window_capture');
    assert.equal(obsInputKindForMode('display'), 'monitor_capture');
});

test('OBS window picker prefers the real TISO executable/window value', () => {
    const selected = pickObsWindowPropertyItem([
        { itemName: 'Chrome', itemValue: 'ChatGPT:Chrome_WidgetWin_1:chrome.exe', itemEnabled: true },
        { itemName: 'TISO', itemValue: 'TISO:UnityWndClass:TISO.exe', itemEnabled: true }
    ], { windowTitle: 'TISO', executable: 'TISO.exe' });
    assert.equal(selected, 'TISO:UnityWndClass:TISO.exe');
});

test('OBS source name does not reuse a browser source as a game capture', () => {
    const name = nextObsSourceName([
        { inputName: 'TISO Game', inputKind: 'browser_source' }
    ], 'TISO Game', 'game_capture');
    assert.equal(name, 'TISO Game [TISO Capture]');
});

test('ensureGameSource creates a real game_capture and selects TISO from OBS window list', async () => {
    const client = new ObsClient();
    client.state = { ...client.createState(), state: 'connected', currentScene: 'Scene' };
    const calls = [];
    client.request = async (requestType, requestData = {}) => {
        calls.push({ requestType, requestData });
        if (requestType === 'GetInputList') return { inputs: [] };
        if (requestType === 'CreateInput') return { sceneItemId: 7 };
        if (requestType === 'GetInputPropertiesListPropertyItems') {
            return {
                propertyItems: [
                    { itemName: 'TISO', itemValue: 'TISO:UnityWndClass:TISO.exe', itemEnabled: true }
                ]
            };
        }
        if (requestType === 'SetInputSettings') return {};
        if (requestType === 'GetSceneItemList') return { sceneItems: [] };
        return {};
    };
    client.loadSources = async () => [];

    const result = await client.ensureGameSource({
        sceneName: 'Scene',
        sourceName: 'TISO Game',
        mode: 'game',
        windowTitle: 'TISO',
        executable: 'TISO.exe'
    });

    const create = calls.find(call => call.requestType === 'CreateInput');
    const update = calls.find(call => call.requestType === 'SetInputSettings');
    assert.equal(create.requestData.inputKind, 'game_capture');
    assert.equal(update.requestData.inputSettings.window, 'TISO:UnityWndClass:TISO.exe');
    assert.equal(result.sourceName, 'TISO Game');
});


test('OBS audio input kinds cover desktop, mic and per-application capture', () => {
    assert.equal(isObsAudioInputKind('wasapi_output_capture'), true);
    assert.equal(isObsAudioInputKind('wasapi_input_capture'), true);
    assert.equal(isObsAudioInputKind('wasapi_process_output_capture'), true);
    assert.equal(isObsAudioInputKind('game_capture'), false);
    assert.equal(isObsAudioInputKind('monitor_capture'), false);
    assert.equal(isObsAudioInputKind(''), false);
});

test('OBS volume meter collector keeps the loudest peak per input', () => {
    const client = new ObsClient();
    client.meterCollector = new Map();
    client.collectVolumeMeters([
        { inputName: 'Desktop Audio', inputLevelsMul: [[0.1, 0.2, 0.2], [0.05, 0.09, 0.09]] },
        { inputName: 'Mic/Aux', inputLevelsMul: [[0, 0, 0]] }
    ]);
    client.collectVolumeMeters([
        { inputName: 'Desktop Audio', inputLevelsMul: [[0.3, 0.55, 0.55]] }
    ]);
    assert.equal(client.meterCollector.get('Desktop Audio'), 0.55);
    assert.equal(client.meterCollector.get('Mic/Aux'), 0);
});

test('OBS volume meters are ignored when no audio check is running', () => {
    const client = new ObsClient();
    client.collectVolumeMeters([{ inputName: 'Desktop Audio', inputLevelsMul: [[0.9, 0.9, 0.9]] }]);
    assert.equal(client.meterCollector, null);
});
