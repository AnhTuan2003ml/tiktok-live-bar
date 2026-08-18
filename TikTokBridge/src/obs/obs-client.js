'use strict';

const crypto = require('node:crypto');
const WebSocket = require('ws');

function makeObsAuthentication(password, salt, challenge) {
    const secret = crypto.createHash('sha256')
        .update(`${password}${salt}`)
        .digest('base64');
    return crypto.createHash('sha256')
        .update(`${secret}${challenge}`)
        .digest('base64');
}


const OBS_EVENT_INPUT_VOLUME_METERS = 1 << 16;   // EventSubscription::InputVolumeMeters
const OBS_EVENT_BASE_SUBSCRIPTIONS = 197;        // General | Config | Scenes | Outputs

function obsInputKindForMode(mode) {
    const value = String(mode || 'game').trim().toLowerCase();
    if (value === 'game') return 'game_capture';
    if (value === 'window') return 'window_capture';
    if (value === 'display') return 'monitor_capture';
    throw new Error('Chế độ capture không hợp lệ');
}

const OBS_AUDIO_INPUT_KINDS = new Set([
    'wasapi_output_capture',          // Desktop Audio
    'wasapi_input_capture',           // Micro
    'wasapi_process_output_capture',  // Application Audio Capture
    'coreaudio_output_capture',
    'coreaudio_input_capture',
    'pulse_output_capture',
    'pulse_input_capture'
]);

function isObsAudioInputKind(kind) {
    const value = String(kind || '').trim().toLowerCase();
    if (!value) return false;
    if (OBS_AUDIO_INPUT_KINDS.has(value)) return true;
    return value.includes('audio_capture') || value.includes('output_capture') || value.includes('input_capture');
}

function sameObsInputKind(actual, expected) {
    const left = String(actual || '').trim().toLowerCase();
    const right = String(expected || '').trim().toLowerCase();
    return left === right || left.startsWith(`${right}_`);
}

function pickObsWindowPropertyItem(items, options = {}) {
    const title = String(options.windowTitle || '').trim().toLowerCase();
    const executable = String(options.executable || '').trim().toLowerCase();
    const list = Array.isArray(items) ? items : [];
    let best = null;
    let bestScore = -1;

    for (const item of list) {
        if (!item || item.itemEnabled === false) continue;
        const name = String(item.itemName ?? item.name ?? '').trim();
        const value = String(item.itemValue ?? item.value ?? '').trim();
        if (!value) continue;
        const haystack = `${name} ${value}`.toLowerCase();
        let score = 0;
        if (executable && haystack.includes(executable)) score += 8;
        if (title && haystack.includes(title)) score += 4;
        if (title && name.toLowerCase() === title) score += 2;
        if (score > bestScore) {
            best = value;
            bestScore = score;
        }
    }

    return bestScore > 0 ? best : '';
}

function nextObsSourceName(inputs, requestedName, inputKind) {
    const list = Array.isArray(inputs) ? inputs : [];
    const requested = String(requestedName || 'TISO Game').trim() || 'TISO Game';
    const exact = list.find(input => String(input.inputName || '') === requested);
    if (!exact || sameObsInputKind(exact.inputKind, inputKind)) return requested;

    const base = `${requested} [TISO Capture]`;
    let candidate = base;
    let index = 2;
    while (list.some(input => String(input.inputName || '') === candidate)) {
        candidate = `${base} ${index++}`;
    }
    return candidate;
}

function sanitizeObsEndpoint(input = {}) {
    const host = String(input.host || '127.0.0.1').trim().slice(0, 200) || '127.0.0.1';
    const parsedPort = Number.parseInt(input.port, 10);
    const port = Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 4455;
    return { host, port };
}

class ObsClient {
    constructor(onStatus = null) {
        this.socket = null;
        this.pending = new Map();
        this.requestSequence = 0;
        this.onStatus = typeof onStatus === 'function' ? onStatus : null;
        this.state = this.createState();
        this.identifyPromise = null;
        this.eventSubscriptions = OBS_EVENT_BASE_SUBSCRIPTIONS;
        this.meterCollector = null;   // chỉ khác null trong lúc đo mức âm thanh
    }

    createState() {
        return {
            state: 'disconnected',
            message: 'OBS chưa kết nối',
            host: '127.0.0.1',
            port: 4455,
            version: '',
            obsWebSocketVersion: '',
            currentScene: '',
            scenes: [],
            sources: [],
            streamActive: false,
            streamTimecode: '',
            updatedAt: Date.now()
        };
    }

    getStatus() {
        return JSON.parse(JSON.stringify(this.state));
    }

    emitStatus(patch = {}) {
        this.state = { ...this.state, ...patch, updatedAt: Date.now() };
        if (this.onStatus) this.onStatus(this.getStatus());
    }

    async connect(options = {}) {
        const { host, port } = sanitizeObsEndpoint(options);
        const password = String(options.password || '');
        await this.disconnect(false);
        this.emitStatus({
            state: 'connecting',
            message: `Đang kết nối OBS ${host}:${port}…`,
            host,
            port,
            version: '',
            obsWebSocketVersion: '',
            scenes: [],
            sources: []
        });

        const socket = new WebSocket(`ws://${host}:${port}`, {
            handshakeTimeout: 5000,
            perMessageDeflate: false
        });
        this.socket = socket;

        this.identifyPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('OBS handshake timeout')), 7000);
            const finishResolve = () => { clearTimeout(timeout); resolve(); };
            const finishReject = error => { clearTimeout(timeout); reject(error); };
            socket.once('error', finishReject);
            socket.once('open', () => {});
            socket.__obsIdentifyResolve = finishResolve;
            socket.__obsIdentifyReject = finishReject;
        });

        socket.on('message', raw => {
            try {
                this.handleMessage(socket, JSON.parse(raw.toString()), password);
            } catch (error) {
                this.emitStatus({ state: 'error', message: `OBS trả dữ liệu không hợp lệ: ${error.message}` });
            }
        });
        socket.on('close', (code, reason) => {
            const isCurrent = this.socket === socket;
            if (isCurrent && this.state.state === 'connecting') {
                socket.__obsIdentifyReject?.(new Error(`OBS closed during authentication (${code} ${reason || ''})`));
            }
            if (isCurrent) this.socket = null;
            if (isCurrent) {
                for (const { reject, timer } of this.pending.values()) {
                    clearTimeout(timer);
                    reject(new Error('OBS connection closed'));
                }
                this.pending.clear();
                if (this.state.state !== 'disconnected') {
                    this.emitStatus({ state: 'disconnected', message: 'OBS đã ngắt kết nối', sources: [] });
                }
            }
        });
        socket.on('error', error => {
            if (this.state.state === 'connecting') {
                this.emitStatus({ state: 'error', message: this.friendlyConnectionError(error) });
            }
        });

        try {
            await this.identifyPromise;
            await this.refresh();
            return this.getStatus();
        } catch (error) {
            try { socket.close(); } catch { }
            this.emitStatus({ state: 'error', message: this.friendlyConnectionError(error) });
            throw error;
        }
    }

    friendlyConnectionError(error) {
        const message = String(error?.message || error || 'Không thể kết nối OBS');
        if (/ECONNREFUSED|connect/i.test(message)) return 'Không thấy OBS. Hãy mở OBS và bật WebSocket Server.';
        if (/authentication|identified|4009|auth/i.test(message)) return 'Sai mật khẩu OBS WebSocket hoặc xác thực thất bại.';
        if (/timeout/i.test(message)) return 'OBS WebSocket không phản hồi kịp thời.';
        return `OBS: ${message}`;
    }

    handleMessage(socket, message, password) {
        const op = Number(message?.op);
        const data = message?.d || {};
        if (op === 0) {
            const identify = {
                rpcVersion: Math.min(1, Number(data.rpcVersion) || 1),
                eventSubscriptions: this.eventSubscriptions
            };
            if (data.authentication) {
                identify.authentication = makeObsAuthentication(
                    password,
                    String(data.authentication.salt || ''),
                    String(data.authentication.challenge || '')
                );
            }
            socket.send(JSON.stringify({ op: 1, d: identify }));
            return;
        }
        if (op === 2) {
            this.emitStatus({ state: 'connected', message: 'OBS đã kết nối' });
            socket.__obsIdentifyResolve?.();
            return;
        }
        if (op === 7) {
            const requestId = String(data.requestId || '');
            const pending = this.pending.get(requestId);
            if (!pending) return;
            this.pending.delete(requestId);
            clearTimeout(pending.timer);
            const requestStatus = data.requestStatus || {};
            if (requestStatus.result) pending.resolve(data.responseData || {});
            else pending.reject(new Error(requestStatus.comment || `OBS request failed (${requestStatus.code || '?'})`));
            return;
        }
        if (op === 5) {
            const eventType = String(data.eventType || '');
            if (eventType === 'InputVolumeMeters') {
                this.collectVolumeMeters(data.eventData?.inputs);
                return;
            }
            if (eventType === 'CurrentProgramSceneChanged') {
                this.emitStatus({ currentScene: String(data.eventData?.sceneName || '') });
            } else if (eventType === 'StreamStateChanged') {
                this.emitStatus({ streamActive: Boolean(data.eventData?.outputActive) });
            }
        }
    }

    async request(requestType, requestData = {}) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN || this.state.state !== 'connected') {
            throw new Error('OBS chưa kết nối');
        }
        const requestId = `tiso-${Date.now()}-${++this.requestSequence}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`OBS timeout: ${requestType}`));
            }, 5000);
            this.pending.set(requestId, { resolve, reject, timer });
            socket.send(JSON.stringify({
                op: 6,
                d: { requestType, requestId, requestData }
            }));
        });
    }

    async refresh() {
        const [version, sceneList, currentScene, stream] = await Promise.all([
            this.request('GetVersion'),
            this.request('GetSceneList'),
            this.request('GetCurrentProgramScene'),
            this.request('GetStreamStatus').catch(() => ({ outputActive: false, outputTimecode: '' }))
        ]);
        const scenes = Array.isArray(sceneList.scenes)
            ? sceneList.scenes.map(scene => String(scene.sceneName || '')).filter(Boolean)
            : [];
        const activeScene = String(currentScene.currentProgramSceneName || sceneList.currentProgramSceneName || '');
        this.emitStatus({
            state: 'connected',
            message: 'OBS đã kết nối',
            version: String(version.obsVersion || ''),
            obsWebSocketVersion: String(version.obsWebSocketVersion || ''),
            scenes,
            currentScene: activeScene,
            streamActive: Boolean(stream.outputActive),
            streamTimecode: String(stream.outputTimecode || '')
        });
        if (activeScene) await this.loadSources(activeScene).catch(() => {});
        return this.getStatus();
    }

    async loadSources(sceneName) {
        const name = String(sceneName || this.state.currentScene || '').trim();
        if (!name) throw new Error('Chưa chọn scene OBS');
        const response = await this.request('GetSceneItemList', { sceneName: name });
        const sources = (response.sceneItems || []).map(item => ({
            sceneItemId: Number(item.sceneItemId),
            sourceName: String(item.sourceName || ''),
            inputKind: String(item.inputKind || ''),
            enabled: item.sceneItemEnabled !== false
        }));
        this.emitStatus({ sources, currentScene: name });
        return sources;
    }

    async setCurrentScene(sceneName) {
        const name = String(sceneName || '').trim();
        if (!name) throw new Error('Scene OBS không hợp lệ');
        await this.request('SetCurrentProgramScene', { sceneName: name });
        this.emitStatus({ currentScene: name });
        await this.loadSources(name).catch(() => {});
    }

    async setSourceVisibility(sceneName, sceneItemId, enabled) {
        const name = String(sceneName || this.state.currentScene || '').trim();
        const id = Number(sceneItemId);
        if (!name || !Number.isInteger(id)) throw new Error('Source OBS không hợp lệ');
        await this.request('SetSceneItemEnabled', {
            sceneName: name,
            sceneItemId: id,
            sceneItemEnabled: Boolean(enabled)
        });
        await this.loadSources(name);
    }

    async ensureGameSource(options = {}) {
        const sceneName = String(options.sceneName || this.state.currentScene || '').trim();
        if (!sceneName) throw new Error('Chưa chọn scene OBS');

        const mode = String(options.mode || 'game').trim().toLowerCase();
        const inputKind = obsInputKindForMode(mode);
        const requestedSourceName = String(options.sourceName || 'TISO Game').trim() || 'TISO Game';
        const windowTitle = String(options.windowTitle || 'TISO').trim() || 'TISO';
        const executable = String(options.executable || 'TISO.exe').trim() || 'TISO.exe';

        const inputListResponse = await this.request('GetInputList').catch(() => ({ inputs: [] }));
        const inputs = Array.isArray(inputListResponse.inputs) ? inputListResponse.inputs : [];
        const sourceName = nextObsSourceName(inputs, requestedSourceName, inputKind);
        let existing = inputs.find(input => String(input.inputName || '') === sourceName && sameObsInputKind(input.inputKind, inputKind));
        let sceneItemId = null;
        let createdInput = false;

        const initialSettings = mode === 'game'
            ? { capture_mode: 'window', capture_cursor: false, allow_transparency: false }
            : mode === 'window'
                ? { cursor: false, client_area: true }
                : { capture_cursor: false, monitor: 0 };

        if (!existing) {
            const created = await this.request('CreateInput', {
                sceneName,
                inputName: sourceName,
                inputKind,
                inputSettings: initialSettings,
                sceneItemEnabled: true
            });
            createdInput = true;
            sceneItemId = Number(created.sceneItemId);
            existing = { inputName: sourceName, inputKind };
        } else {
            const sceneItems = await this.request('GetSceneItemList', { sceneName }).catch(() => ({ sceneItems: [] }));
            const sceneItem = (sceneItems.sceneItems || []).find(item => String(item.sourceName || '') === sourceName);
            if (sceneItem) {
                sceneItemId = Number(sceneItem.sceneItemId);
                if (sceneItem.sceneItemEnabled === false) {
                    await this.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: true });
                }
            } else {
                const added = await this.request('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled: true });
                sceneItemId = Number(added.sceneItemId);
            }
        }

        let selectedWindow = '';
        if (mode === 'game' || mode === 'window') {
            try {
                const propertyResponse = await this.request('GetInputPropertiesListPropertyItems', {
                    inputName: sourceName,
                    propertyName: 'window'
                });
                selectedWindow = pickObsWindowPropertyItem(propertyResponse.propertyItems, { windowTitle, executable });
            } catch {
                // Older/limited OBS builds may refuse dynamic property enumeration. Use a safe fallback.
            }

            // OBS stores window selectors as title:class:executable. Never put the exe in the class slot.
            if (!selectedWindow) selectedWindow = `${windowTitle}::${executable}`;

            const captureSettings = mode === 'game'
                ? {
                    capture_mode: 'window',
                    window: selectedWindow,
                    capture_cursor: false,
                    allow_transparency: false
                }
                : {
                    window: selectedWindow,
                    cursor: false,
                    client_area: true
                };
            await this.request('SetInputSettings', {
                inputName: sourceName,
                inputSettings: captureSettings,
                overlay: true
            });
        }

        // Khớp nguồn với canvas OBS bằng SCALE_INNER: luôn thấy trọn khung hình game.
        // Khi game bật fullscreen, tỉ lệ game trùng tỉ lệ canvas nên hình lấp đầy, không viền đen.
        // Khi game trở về cửa sổ dọc, hình thu gọn trong khung (viền hai bên) thay vì bị phóng
        // to cắt mất chiều cao — đó là hành vi cũ mà người vận hành quen dùng.
        let fitted = false;
        let layout = null;
        if (sceneItemId !== null && Number.isFinite(sceneItemId)) {
            try {
                const video = await this.request('GetVideoSettings');
                const canvasWidth = Number(video.baseWidth) || 1920;
                const canvasHeight = Number(video.baseHeight) || 1080;
                await this.request('SetSceneItemTransform', {
                    sceneName,
                    sceneItemId,
                    sceneItemTransform: {
                        positionX: 0,
                        positionY: 0,
                        alignment: 5,                            // OBS_ALIGN_TOP | OBS_ALIGN_LEFT
                        boundsType: 'OBS_BOUNDS_SCALE_INNER',
                        boundsAlignment: 0,                      // căn giữa trong khung
                        boundsWidth: canvasWidth,
                        boundsHeight: canvasHeight,
                        cropLeft: 0,
                        cropRight: 0,
                        cropTop: 0,
                        cropBottom: 0
                    }
                });
                fitted = true;
                const applied = await this.request('GetSceneItemTransform', { sceneName, sceneItemId })
                    .catch(() => ({ sceneItemTransform: {} }));
                const transform = applied.sceneItemTransform || {};
                layout = {
                    canvasWidth,
                    canvasHeight,
                    sourceWidth: Number(transform.sourceWidth) || 0,
                    sourceHeight: Number(transform.sourceHeight) || 0,
                    boundsType: String(transform.boundsType || '')
                };
            } catch {
                // OBS cũ có thể từ chối một vài trường transform; giữ nguyên bố cục hiện có.
            }
        }

        await this.loadSources(sceneName).catch(() => {});
        return {
            mode,
            sceneName,
            sourceName,
            fitted,
            layout,
            inputKind,
            sceneItemId,
            createdInput,
            selectedWindow,
            renamedBecauseOfKindConflict: sourceName !== requestedSourceName
        };
    }

    collectVolumeMeters(inputs) {
        if (!this.meterCollector || !Array.isArray(inputs)) return;
        for (const input of inputs) {
            const name = String(input?.inputName || '');
            if (!name) continue;
            // inputLevelsMul: [[magnitude, peak, inputPeak], ...] cho từng kênh, đơn vị nhân.
            const channels = Array.isArray(input?.inputLevelsMul) ? input.inputLevelsMul : [];
            let peak = 0;
            for (const channel of channels) {
                if (!Array.isArray(channel)) continue;
                for (const value of channel) {
                    const level = Number(value);
                    if (Number.isFinite(level) && level > peak) peak = level;
                }
            }
            const seen = this.meterCollector.has(name);
            const current = this.meterCollector.get(name) || 0;
            if (!seen || peak > current) this.meterCollector.set(name, peak);
        }
    }

    setEventSubscriptions(mask) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ op: 3, d: { eventSubscriptions: mask } }));
    }

    // Kiểm tra âm thanh thực sự đi vào OBS: nguồn nào đang mở tiếng, track nào lên sóng,
    // và trong khoảng đo có tín hiệu hay không.
    async audioCheck(options = {}) {
        const durationMs = Math.max(1000, Math.min(8000, Number(options.durationMs) || 3000));
        const inputListResponse = await this.request('GetInputList');
        const inputs = (Array.isArray(inputListResponse.inputs) ? inputListResponse.inputs : [])
            .filter(input => isObsAudioInputKind(input?.inputKind));

        const details = [];
        for (const input of inputs) {
            const inputName = String(input.inputName || '');
            const [mute, volume, tracks, monitor] = await Promise.all([
                this.request('GetInputMute', { inputName }).catch(() => ({ inputMuted: null })),
                this.request('GetInputVolume', { inputName }).catch(() => ({ inputVolumeDb: null })),
                this.request('GetInputAudioTracks', { inputName }).catch(() => ({ inputAudioTracks: null })),
                this.request('GetInputAudioMonitorType', { inputName }).catch(() => ({ monitorType: '' }))
            ]);
            const audioTracks = tracks.inputAudioTracks || null;
            details.push({
                inputName,
                inputKind: String(input.inputKind || ''),
                muted: mute.inputMuted === null ? null : Boolean(mute.inputMuted),
                volumeDb: Number.isFinite(Number(volume.inputVolumeDb)) ? Number(volume.inputVolumeDb) : null,
                track1: audioTracks ? audioTracks['1'] !== false : null,
                monitorType: String(monitor.monitorType || ''),
                peak: 0,
                peakDb: null
            });
        }

        // Bật tạm event đo mức (high volume) rồi trả lại mức đăng ký cũ.
        this.meterCollector = new Map();
        this.setEventSubscriptions(this.eventSubscriptions | OBS_EVENT_INPUT_VOLUME_METERS);
        await new Promise(resolve => setTimeout(resolve, durationMs));
        this.setEventSubscriptions(this.eventSubscriptions);
        const measured = this.meterCollector;
        this.meterCollector = null;

        for (const item of details) {
            const peak = Number(measured.get(item.inputName) || 0);
            item.peak = peak;
            item.peakDb = peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : null;
        }

        const stream = await this.request('GetStreamStatus').catch(() => ({ outputActive: false }));
        const record = await this.request('GetRecordStatus').catch(() => ({ outputActive: false }));

        // Nguồn được coi là "đang đẩy tiếng lên sóng" khi: không mute, track 1 bật,
        // volume không bị kéo về câm và có tín hiệu đo được.
        const live = details.filter(item => item.muted === false && item.track1 !== false && item.peak > 0.0005);

        return {
            durationMs,
            streamActive: Boolean(stream.outputActive),
            recordActive: Boolean(record.outputActive),
            inputs: details,
            audibleInputs: live.map(item => item.inputName),
            hasAudio: live.length > 0
        };
    }

    async disconnect(emit = true) {
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try { socket.close(1000, 'TISO disconnect'); } catch { }
        }
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('OBS disconnected'));
        }
        this.pending.clear();
        if (emit) this.emitStatus({ ...this.createState(), host: this.state.host, port: this.state.port });
    }
}

module.exports = {
    ObsClient,
    isObsAudioInputKind,
    makeObsAuthentication,
    sanitizeObsEndpoint,
    obsInputKindForMode,
    sameObsInputKind,
    pickObsWindowPropertyItem,
    nextObsSourceName
};
