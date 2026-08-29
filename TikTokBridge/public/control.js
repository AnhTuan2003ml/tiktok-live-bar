'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
    socket: null,
    reconnectTimer: null,
    live: { state: 'idle', username: null, message: 'Chưa kết nối' },
    metrics: { source: 'idle', events: 0, chats: 0, gifts: 0, diamonds: 0, likes: 0, players: 0, eventsPerSecond: 0 },
    master: { joinMode: 'keyword_only', giftAlwaysJoins: true, rules: [] },
    operator: { spawnEvents: { chat: true, gift: true, like: false, follow: true, share: true, member: false }, obs: { host: '127.0.0.1', port: 4455, password: '', autoConnect: true }, media: { musicVolume: .35, backgroundFile: 'nenamphu.png', audioFile: '', welcomeEnabled: true, welcomeVolume: .6, welcomeFile: 'welcome.wav', welcomeGreeting: 'Chào mừng {ten}', welcomeInterval: 4, welcomeLang: 'vi', logoEnabled: true, logoFile: '', logoScale: .18, logoOpacity: 1 }, recentEventLimit: 200 },
    gifts: new Map(),
    recentEvents: [],
    eventFilter: 'all',
    telemetry: { fps: 0, queueCount: 0, playerCount: 0, droppedMessages: 0, chroma: false, hud: false, feed: false, controls: false, fullscreen: false, updatedAt: 0 },
    system: { overlayClients: 0 },
    obs: { state: 'disconnected', host: '127.0.0.1', port: 4455, scenes: [], sources: [], currentScene: '', streamActive: false }
};

const ACTIONS = [
    ['dance', 'Nhảy'], ['jump', 'Nhảy cao'], ['walk', 'Đi vòng'], ['camera', 'Zoom camera'],
    ['change', 'Đổi nhân vật'], ['grow', 'Phóng to'], ['medal', 'Cánh / huy hiệu'],
    ['vip', 'VIP'], ['topdj', 'Top DJ'], ['fireworks', 'Pháo hoa'], ['join', 'Vào sàn']
];

const PROVIDER_HELP = {
    auto: 'Tự động thử TikTok Direct trước. Nếu thất bại mới fallback sang TikFinity.',
    tiktok: 'TikTok Direct: chỉ cần username hoặc link LIVE, không cần mở TikFinity.',
    tikfinity: 'TikFinity: phải mở TikFinity Desktop và WebSocket cổng 21213.'
};

function toast(message, type = '') {
    const stack = $('#toast-stack');
    const item = document.createElement('div');
    item.className = `toast ${type}`.trim();
    item.textContent = message;
    stack.append(item);
    setTimeout(() => item.remove(), 3600);
}

function send(message) {
    if (state.socket?.readyState !== WebSocket.OPEN) {
        toast('Bridge chưa kết nối.', 'error');
        return false;
    }
    state.socket.send(JSON.stringify(message));
    return true;
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('vi-VN');
}

function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value;
}

function setBadge(element, label, mode = '') {
    if (!element) return;
    element.textContent = label;
    element.className = `state-badge ${mode}`.trim();
}

function liveStateMode(value) {
    if (value === 'connected' || value === 'demo') return 'ok';
    if (value === 'connecting' || value === 'reconnecting') return 'warn';
    if (value === 'error' || value === 'disconnected' || value === 'ended') return 'bad';
    return '';
}

function goTab(name, updateHash = true) {
    const validTabs = new Set(['main', 'demo', 'obs', 'advanced']);
    const target = validTabs.has(name) ? name : 'main';
    $$('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.tab === target));
    $$('.panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${target}`));
    if (updateHash && history.replaceState) history.replaceState(null, '', target === 'main' ? location.pathname + location.search : `#${target}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('.nav-btn').forEach(button => button.addEventListener('click', () => goTab(button.dataset.tab)));
$$('[data-go-tab]').forEach(button => button.addEventListener('click', () => goTab(button.dataset.goTab)));

function parseTikTokUsername(raw) {
    const api = window.TikTokUsername;
    if (!api?.normalizeTikTokUsername) return { username: null, looksLikeUrl: false };
    return { username: api.normalizeTikTokUsername(raw), looksLikeUrl: api.looksLikeUrl(raw) };
}

function updateUsernameHint() {
    const input = $('#username');
    const hint = $('#username-hint');
    const { username, looksLikeUrl } = parseTikTokUsername(input.value);
    if (username) {
        hint.textContent = `Đã nhận diện: @${username}`;
        hint.className = 'ok';
    } else if (looksLikeUrl && input.value.trim()) {
        hint.textContent = 'Không tìm thấy username trong link TikTok.';
        hint.className = 'err';
    } else {
        hint.textContent = '';
        hint.className = '';
    }
}

function renderLiveStatus() {
    const live = state.live;
    const mode = liveStateMode(live.state);
    const labelMap = {
        idle: 'SẴN SÀNG', connecting: 'CONNECTING', reconnecting: 'RECONNECTING', connected: 'LIVE',
        demo: 'DEMO', disconnected: 'OFFLINE', ended: 'ENDED', error: 'ERROR'
    };
    const titleMap = {
        idle: 'Sẵn sàng', connecting: 'Đang kết nối…', reconnecting: 'Đang thử kết nối lại…',
        connected: 'Đã kết nối LIVE', demo: 'Đang chạy DEMO', disconnected: 'Mất kết nối', ended: 'LIVE đã kết thúc', error: 'Lỗi kết nối'
    };
    setBadge($('#live-state-badge'), labelMap[live.state] || String(live.state || 'IDLE').toUpperCase(), mode);
    setBadge($('#dash-live-badge'), labelMap[live.state] || 'IDLE', mode);
    setText('#live-status-title', titleMap[live.state] || live.state || 'Sẵn sàng');
    setText('#live-status-message', live.message || '');
    setText('#live-detail-user', live.username ? `@${live.username}` : '@—');
    setText('#dash-live-user', live.username ? `@${live.username}` : '@—');
    setText('#current-user', live.username ? `@${live.username}` : '@—');
    const provider = state.metrics.source === 'tiktok' ? 'TikTok Direct' : state.metrics.source === 'tikfinity' ? 'TikFinity' : state.metrics.source === 'demo' ? 'Demo' : '—';
    setText('#live-detail-provider', provider);
    setText('#dash-live-provider', live.message || provider);
    const dot = $('#live-status-dot');
    dot.className = `big-dot ${mode}`.trim();
    const pill = $('#live-pill');
    if (pill) {
        pill.classList.toggle('live', live.state === 'connected');
        const pillDot = pill.querySelector('.dot');
        if (pillDot) pillDot.className = `dot ${mode}`.trim();
    }
    setText('#live-pill-text', live.state === 'connected' ? 'LIVE' : live.state === 'demo' ? 'DEMO' : titleMap[live.state] || 'Chưa LIVE');
}

function renderMetrics() {
    const m = state.metrics;
    setText('#metric-players', formatNumber(m.players));
    setText('#metric-chats', formatNumber(m.chats));
    setText('#metric-gifts', formatNumber(m.gifts));
    setText('#metric-diamonds', formatNumber(m.diamonds));
    setText('#metric-rate', formatNumber(m.eventsPerSecond));
    setText('#live-detail-events', formatNumber(m.events));
    setText('#live-detail-players', formatNumber(m.players));
    renderLiveStatus();
}

function renderSystem() {
    const online = Number(state.system.overlayClients || 0) > 0;
    setBadge($('#dash-unity-badge'), online ? 'ONLINE' : 'OFFLINE', online ? 'ok' : 'bad');
    setBadge($('#game-state-badge'), online ? 'ONLINE' : 'OFFLINE', online ? 'ok' : 'bad');
    setText('#dash-unity-count', String(state.system.overlayClients || 0));
    setText('#dash-unity-detail', online ? 'TISO.exe đang nối Bridge' : 'Chưa thấy TISO.exe');
    $('#unity-dot').className = `dot ${online ? 'ok' : 'bad'}`;
    setText('#unity-mini', online ? 'Online' : 'Offline');
}

function renderTelemetry() {
    const t = state.telemetry;
    const online = Number(state.system.overlayClients || 0) > 0;
    const fps = online && t.updatedAt ? Math.round(t.fps || 0) : '—';
    const queue = online && t.updatedAt ? t.queueCount : '—';
    setText('#metric-fps', fps);
    setText('#metric-queue', queue);
    setText('#metric-dropped', formatNumber(t.droppedMessages));
    setText('#game-fps', fps);
    setText('#game-queue', queue);
    setText('#game-players', online && t.updatedAt ? formatNumber(t.playerCount) : '—');
    setText('#game-dropped', online && t.updatedAt ? formatNumber(t.droppedMessages) : '—');

    const current = { chroma: !!t.chroma, hud: !!t.hud, feed: !!t.feed, controls: !!t.controls, fullscreen: !!t.fullscreen };
    $$('[data-game-toggle]').forEach(button => {
        const on = current[button.dataset.gameToggle];
        button.classList.toggle('on', on);
        button.querySelector('b').textContent = on ? 'ON' : 'OFF';
    });

    const warning = $('#performance-warning');
    if (online && ((Number(t.fps) > 0 && Number(t.fps) < 25) || Number(t.queueCount) > 100)) {
        warning.classList.remove('hidden');
        warning.textContent = `Cảnh báo hiệu năng: FPS ${Math.round(t.fps || 0)} · Queue ${t.queueCount || 0}. Hãy tắt spawn Like/Member hoặc giảm tải sự kiện.`;
    } else warning.classList.add('hidden');
}

function addRecentEvent(event, prepend = true) {
    if (!event || !event.type) return;
    if (prepend) state.recentEvents.unshift(event);
    else state.recentEvents.push(event);
    if (state.recentEvents.length > 200) state.recentEvents.length = 200;
    renderRecentEvents();
}

function eventContent(event) {
    if (event.type === 'chat') return event.comment || '(chat trống)';
    if (event.type === 'gift') return `${event.giftName || 'Gift'} ×${event.repeatCount || 1} · ${formatNumber(event.diamondCount)}💎${event.action ? ` → ${event.action}` : ''}`;
    if (event.type === 'like') return `Like +${formatNumber(event.likeCount)}`;
    if (event.type === 'follow') return 'Follow';
    if (event.type === 'share') return 'Share LIVE';
    if (event.type === 'member') return 'Vào LIVE';
    return event.action || event.type;
}

function renderRecentEvents() {
    const container = $('#recent-events');
    const events = state.recentEvents
        .filter(event => state.eventFilter === 'all' || event.type === state.eventFilter)
        .slice(0, 100);
    if (!events.length) {
        container.innerHTML = '<div class="empty">Chưa có sự kiện phù hợp.</div>';
        return;
    }
    container.replaceChildren(...events.map(event => {
        const row = document.createElement('div');
        row.className = 'event-item';
        const type = document.createElement('span');
        type.className = `event-type ${event.type}`;
        type.textContent = String(event.type || '').toUpperCase();
        const user = document.createElement('span');
        user.className = 'event-user';
        user.textContent = event.nickname || event.username || 'TikTok user';
        const content = document.createElement('span');
        content.className = 'event-content';
        content.textContent = eventContent(event);
        const time = document.createElement('span');
        time.className = 'event-time';
        time.textContent = new Date(Number(event.timestamp) || Date.now()).toLocaleTimeString('vi-VN', { hour12: false });
        row.append(type, user, content, time);
        return row;
    }));
}

$$('#event-filters .filter-btn').forEach(button => button.addEventListener('click', () => {
    state.eventFilter = button.dataset.filter;
    $$('#event-filters .filter-btn').forEach(item => item.classList.toggle('active', item === button));
    renderRecentEvents();
}));

function makeRuleId() {
    return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyRule(source, overrides = {}) {
    return {
        id: makeRuleId(), enabled: true, source, trigger: '', giftId: '', match: 'exact', action: 'dance',
        displayDiamonds: 0, durationMs: 3000, label: '', variant: '', fireworkBursts: 0, ...overrides
    };
}

function createField(label, control) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    wrapper.append(labelElement, control);
    return wrapper;
}

function actionSelect(value) {
    const select = document.createElement('select');
    select.dataset.field = 'action';
    for (const [key, label] of ACTIONS) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = label;
        select.append(option);
    }
    select.value = value || 'dance';
    return select;
}

function decorationConditionSelect(value = 'always') {
    const select = document.createElement('select');
    select.dataset.field = 'decorationCondition';
    [
        ['always', 'Không cần Top'],
        ['top_only', 'Chỉ khi đang Top 1–3']
    ].forEach(([key, label]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = label;
        select.append(option);
    });
    select.value = value === 'top_only' ? 'top_only' : 'always';
    return select;
}

function createRuleRow(rule) {
    const row = document.createElement('div');
    row.className = `rule-row ${rule.source}`;
    row.dataset.ruleId = rule.id || makeRuleId();
    row._originalRule = { ...rule };

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'rule-enable';
    enabled.dataset.field = 'enabled';
    enabled.checked = rule.enabled !== false;
    row.append(enabled);

    if (rule.source === 'gift') {
        const trigger = document.createElement('input');
        trigger.dataset.field = 'trigger';
        trigger.value = rule.trigger || '';
        trigger.placeholder = 'Rose / Hoa hồng';
        row.append(createField('Gift / alias', trigger));

        const giftId = document.createElement('input');
        giftId.dataset.field = 'giftId';
        giftId.value = rule.giftId || '';
        giftId.placeholder = '5655';
        row.append(createField('Gift ID', giftId));
    } else {
        const trigger = document.createElement('input');
        trigger.dataset.field = 'trigger';
        trigger.value = rule.trigger || '';
        trigger.placeholder = 'dance, nhảy';
        row.append(createField('Từ khóa / alias', trigger));

        const match = document.createElement('select');
        match.dataset.field = 'match';
        [['exact', 'Đúng chính xác'], ['contains', 'Có chứa'], ['any', 'Bất kỳ chat']].forEach(([key, label]) => {
            const option = document.createElement('option'); option.value = key; option.textContent = label; match.append(option);
        });
        match.value = rule.match || 'exact';
        row.append(createField('Khớp', match));
    }

    const action = actionSelect(rule.action);
    row.append(createField('Hành động', action));

    // Điều kiện cảnh áp cho mọi hành động, nên ô này luôn hiển thị.
    const decorationCondition = decorationConditionSelect(rule.decorationCondition);
    const decorationConditionField = createField('Điều kiện', decorationCondition);
    decorationConditionField.classList.add('decoration-condition-field');
    row.append(decorationConditionField);

    const duration = document.createElement('input');
    duration.type = 'number'; duration.min = '0'; duration.max = '300'; duration.step = '.5';
    duration.dataset.field = 'durationSeconds'; duration.value = String((Number(rule.durationMs) || 0) / 1000);
    row.append(createField('Giây', duration));

    const label = document.createElement('input');
    label.dataset.field = 'label'; label.value = rule.label || ''; label.placeholder = 'Nhãn';
    row.append(createField('Nhãn', label));

    const cooldown = document.createElement('input');
    cooldown.type = 'number'; cooldown.min = '0'; cooldown.max = '3600'; cooldown.step = '1';
    cooldown.dataset.field = 'cooldownSeconds';
    cooldown.value = String(Number(rule.cooldownSeconds) || 0);
    cooldown.title = 'Mỗi tài khoản chỉ kích hoạt luật này một lần trong khoảng giây này (0 = không giới hạn).';
    row.append(createField('Giới hạn', cooldown));

    const actions = document.createElement('div');
    actions.className = 'rule-actions';
    const testButton = document.createElement('button');
    testButton.className = 'btn small'; testButton.textContent = 'Test';
    testButton.addEventListener('click', () => {
        saveRules(false);
        send({ type: 'master_test', ruleId: row.dataset.ruleId, diamonds: Math.max(1, Number(rule.displayDiamonds) || 100) });
    });
    const deleteButton = document.createElement('button');
    deleteButton.className = 'btn small danger ghost'; deleteButton.textContent = 'Xóa';
    deleteButton.addEventListener('click', () => row.remove());
    actions.append(testButton, deleteButton);
    row.append(actions);
    return row;
}

function renderRules() {
    const chat = state.master.rules.filter(rule => rule.source === 'chat');
    const gift = state.master.rules.filter(rule => rule.source === 'gift');
    const chatContainer = $('#chat-rules');
    const giftContainer = $('#gift-rules');
    chatContainer.replaceChildren(...chat.map(createRuleRow));
    giftContainer.replaceChildren(...gift.map(createRuleRow));
    if (!chat.length) chatContainer.innerHTML = '<div class="empty">Chưa có luật Chat. Chat vẫn tạo nhân vật nếu Spawn Policy bật.</div>';
    if (!gift.length) giftContainer.innerHTML = '<div class="empty">Chưa có luật Gift.</div>';
    $('#master-json').value = JSON.stringify(state.master, null, 2);
}

function readRuleRows() {
    const rows = $$('.rule-row');
    return rows.map(row => {
        const original = row._originalRule || {};
        const source = row.classList.contains('gift') ? 'gift' : 'chat';
        const get = field => row.querySelector(`[data-field="${field}"]`);
        const result = {
            ...original,
            id: row.dataset.ruleId,
            source,
            enabled: get('enabled')?.checked !== false,
            trigger: get('trigger')?.value?.trim() || '',
            giftId: source === 'gift' ? get('giftId')?.value?.trim() || '' : '',
            match: source === 'chat' ? get('match')?.value || 'exact' : original.match || 'exact',
            action: get('action')?.value || 'dance',
            decorationCondition: get('decorationCondition')?.value || original.decorationCondition || 'always',
            durationMs: Math.round((Number(get('durationSeconds')?.value) || 0) * 1000),
            cooldownSeconds: Math.max(0, Math.min(3600, Number(get('cooldownSeconds')?.value) || 0)),
            label: get('label')?.value?.trim() || ''
        };
        if (source === 'chat' && result.match !== 'any' && !result.trigger) result.enabled = false;
        return result;
    });
}

function renderOperator() {
    for (const checkbox of $$('[data-spawn]')) checkbox.checked = state.operator.spawnEvents?.[checkbox.dataset.spawn] === true;
    $('#obs-host').value = state.operator.obs?.host || '127.0.0.1';
    $('#obs-port').value = state.operator.obs?.port || 4455;
    $('#obs-password').value = state.operator.obs?.password || '';
    $('#obs-auto-connect').checked = state.operator.obs?.autoConnect !== false;
    const volume = Math.round(Math.max(0, Math.min(1, Number(state.operator.media?.musicVolume ?? .35))) * 100);
    $('#music-volume').value = String(volume);
    $('#music-volume-value').textContent = `${volume}%`;
    const audioFile = state.operator.media?.audioFile || '';
    $('#music-current-file').textContent = audioFile ? `Đang dùng: DJ_MUSIC/${audioFile}` : 'Chưa có file được chọn từ giao diện.';
    setBadge($('#music-file-status'), audioFile ? 'ĐÃ CHỌN' : 'CHƯA CHỌN', audioFile ? 'ok' : '');

    // Âm thanh chào khách
    const media = state.operator.media || {};
    const welcomeEnabled = media.welcomeEnabled !== false;
    if ($('#welcome-enabled')) $('#welcome-enabled').checked = welcomeEnabled;
    setBadge($('#welcome-status'), welcomeEnabled ? 'BẬT' : 'TẮT', welcomeEnabled ? 'ok' : '');
    const welcomeVol = Math.round(Math.max(0, Math.min(1, Number(media.welcomeVolume ?? 0.6))) * 100);
    if ($('#welcome-volume')) $('#welcome-volume').value = String(welcomeVol);
    if ($('#welcome-volume-value')) $('#welcome-volume-value').textContent = `${welcomeVol}%`;
    if (typeof syncWelcomeSelects === 'function') syncWelcomeSelects();

    // Video logo góc dưới phải
    const logoEnabled = media.logoEnabled !== false;
    if ($('#logo-enabled')) $('#logo-enabled').checked = logoEnabled;
    const logoFile = media.logoFile || '';
    setBadge($('#logo-status'), logoFile ? (logoEnabled ? 'ĐANG BẬT' : 'ĐÃ CHỌN') : 'CHƯA CHỌN', logoFile ? 'ok' : '');
    if ($('#logo-current-file')) $('#logo-current-file').textContent = logoFile ? `Đang dùng: DJ_LOGO/${logoFile}` : 'Chưa có logo được chọn.';
    const logoScale = Math.round(Math.max(0.05, Math.min(0.6, Number(media.logoScale ?? 0.18))) * 100);
    if ($('#logo-scale')) $('#logo-scale').value = String(logoScale);
    if ($('#logo-scale-value')) $('#logo-scale-value').textContent = `${logoScale}%`;
    const logoOpacity = Math.round(Math.max(0, Math.min(1, Number(media.logoOpacity ?? 1))) * 100);
    if ($('#logo-opacity')) $('#logo-opacity').value = String(logoOpacity);
    if ($('#logo-opacity-value')) $('#logo-opacity-value').textContent = `${logoOpacity}%`;

    $('#operator-json').value = JSON.stringify(state.operator, null, 2);
}

function readOperatorFromUi() {
    const spawnEvents = {};
    for (const checkbox of $$('[data-spawn]')) spawnEvents[checkbox.dataset.spawn] = checkbox.checked;
    return {
        ...state.operator,
        spawnEvents,
        obs: {
            host: $('#obs-host').value.trim() || '127.0.0.1',
            port: Number($('#obs-port').value) || 4455,
            password: $('#obs-password').value || '',
            autoConnect: $('#obs-auto-connect').checked
        },
        media: {
            ...(state.operator.media || {}),
            musicVolume: Math.max(0, Math.min(1, (Number($('#music-volume').value) || 0) / 100))
        }
    };
}

function saveRules(showToast = true) {
    const master = { ...state.master, rules: readRuleRows() };
    const operator = readOperatorFromUi();
    send({ type: 'master_save', master });
    send({ type: 'operator_save', operator });
    if (showToast) toast('Đang lưu cấu hình Chat / Gift…');
}

function appendGiftRule(gift = null) {
    const containerGift = $('#gift-rules');
    if (containerGift.querySelector('.empty')) containerGift.replaceChildren();
    const rule = gift ? emptyRule('gift', {
        trigger: gift.giftName || '',
        giftId: String(gift.giftId || ''),
        displayDiamonds: Number(gift.diamondCount) || 0,
        action: 'dance',
        label: gift.giftName || ''
    }) : emptyRule('gift', { action: 'dance' });
    const row = createRuleRow(rule);
    containerGift.append(row);
    $('#gift-rule-dialog')?.close();
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const action = row.querySelector('[data-field="action"]');
    if (action) action.focus({ preventScroll: true });
    toast(gift
        ? `Đã chọn ${gift.giftName || 'Gift'}. Hãy chọn hành động tương ứng rồi bấm Lưu & áp dụng.`
        : 'Đã thêm Gift rule thủ công. Nhập Gift / alias, Gift ID và chọn hành động.');
}

function renderGiftCatalog() {
    const container = $('#gift-catalog');
    if (!container) return;
    const gifts = [...state.gifts.values()].sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0)).slice(0, 120);
    if (!gifts.length) {
        container.innerHTML = '<div class="empty">Chưa nhận Gift thật từ LIVE. Kết nối LIVE để TISO học Gift, hoặc dùng “Gift thủ công” bên dưới.</div>';
        return;
    }
    container.replaceChildren(...gifts.map(gift => {
        const button = document.createElement('button');
        button.className = 'gift-card';
        button.type = 'button';
        button.title = `Chọn ${gift.giftName || 'Gift'} cho rule mới`;
        const image = document.createElement('img');
        image.src = gift.giftPictureUrl || '/favicon.svg'; image.alt = ''; image.loading = 'lazy';
        const text = document.createElement('span');
        const name = document.createElement('b'); name.textContent = gift.giftName || 'Gift';
        const meta = document.createElement('small'); meta.textContent = `ID ${gift.giftId || '?'} · ${formatNumber(gift.diamondCount)}💎`;
        text.append(name, meta); button.append(image, text);
        button.addEventListener('click', () => appendGiftRule(gift));
        return button;
    }));
}

function observeGift(gift) {
    const key = String(gift.giftId || gift.giftName || `gift-${Date.now()}`);
    state.gifts.set(key, { ...state.gifts.get(key), ...gift });
    renderGiftCatalog();
}

function renderObs() {
    const obs = state.obs;
    const connected = obs.state === 'connected';
    const mode = connected ? 'ok' : obs.state === 'connecting' ? 'warn' : obs.state === 'error' ? 'bad' : 'bad';
    setBadge($('#obs-state-badge'), connected ? 'ONLINE' : obs.state === 'connecting' ? 'CONNECTING' : obs.state === 'error' ? 'ERROR' : 'OFFLINE', mode);
    setBadge($('#dash-obs-badge'), connected ? 'ONLINE' : obs.state === 'error' ? 'ERROR' : 'OFFLINE', mode);
    $('#obs-dot').className = `dot ${connected ? 'ok' : 'bad'}`;
    setText('#obs-mini', connected ? 'Online' : 'Offline');
    setText('#obs-status-title', obs.message || (connected ? 'OBS đã kết nối' : 'OBS chưa kết nối'));
    setText('#obs-version', obs.version || '—');
    setText('#obs-ws-version', obs.obsWebSocketVersion || '—');
    setText('#obs-streaming', connected ? (obs.streamActive ? `Đang LIVE ${obs.streamTimecode || ''}` : 'Không stream') : '—');
    setText('#obs-current-scene', obs.currentScene || '—');
    setText('#dash-obs-scene', obs.currentScene || '—');
    setText('#dash-obs-stream', connected ? (obs.streamActive ? 'OBS đang Streaming' : 'OBS Online · chưa Stream') : obs.message || 'Chưa kết nối OBS');

    const sceneSelect = $('#obs-scene');
    const previous = sceneSelect.value;
    sceneSelect.replaceChildren();
    const scenes = Array.isArray(obs.scenes) ? obs.scenes : [];
    if (!scenes.length) {
        const option = document.createElement('option'); option.value = ''; option.textContent = '— Chưa có scene —'; sceneSelect.append(option);
    } else {
        for (const sceneName of scenes) {
            const option = document.createElement('option'); option.value = sceneName; option.textContent = sceneName; sceneSelect.append(option);
        }
        sceneSelect.value = scenes.includes(previous) ? previous : obs.currentScene || scenes[0];
    }

    const sources = $('#obs-sources');
    if (!connected || !Array.isArray(obs.sources) || !obs.sources.length) {
        sources.innerHTML = `<div class="empty">${connected ? 'Scene chưa có source hoặc chưa tải danh sách.' : 'Kết nối OBS để xem sources.'}</div>`;
    } else {
        sources.replaceChildren(...obs.sources.map(source => {
            const row = document.createElement('div'); row.className = 'source-row';
            const info = document.createElement('div');
            const name = document.createElement('strong'); name.textContent = source.sourceName || 'Source';
            const kind = document.createElement('small'); kind.textContent = source.inputKind || `Scene Item #${source.sceneItemId}`;
            info.append(name, kind);
            const button = document.createElement('button');
            button.className = `btn small source-toggle ${source.enabled ? 'primary' : ''}`.trim();
            button.textContent = source.enabled ? 'Đang hiện' : 'Đang ẩn';
            button.addEventListener('click', () => send({
                type: 'obs_set_source_visibility', sceneName: obs.currentScene || sceneSelect.value,
                sceneItemId: source.sceneItemId, enabled: !source.enabled
            }));
            row.append(info, button); return row;
        }));
    }
}

function handleSocketMessage(data) {
    switch (data.type) {
        case 'status': state.live = { ...state.live, ...data }; renderLiveStatus(); break;
        case 'metrics': state.metrics = { ...state.metrics, ...data }; renderMetrics(); break;
        case 'master_config': state.master = data.master || state.master; renderRules(); break;
        case 'operator_config': state.operator = data.operator || state.operator; renderOperator(); break;
        case 'gift_catalog':
            state.gifts.clear();
            for (const gift of data.gifts || []) state.gifts.set(String(gift.giftId || gift.giftName || `gift-${state.gifts.size}`), gift);
            renderGiftCatalog();
            break;
        case 'gift_observed': observeGift(data); break;
        case 'recent_events': state.recentEvents = [...(data.events || [])].reverse(); renderRecentEvents(); break;
        case 'live_event': addRecentEvent(data.event, true); break;
        case 'system_status':
            state.system = { ...state.system, ...data };
            if (data.gameTelemetry) state.telemetry = { ...state.telemetry, ...data.gameTelemetry };
            if (data.obs) state.obs = { ...state.obs, ...data.obs };
            renderSystem(); renderTelemetry(); renderObs(); break;
        case 'game_telemetry': state.telemetry = { ...state.telemetry, ...data }; renderTelemetry(); break;
        case 'obs_status': state.obs = { ...state.obs, ...data }; renderObs(); break;
        case 'master_saved': toast(data.message || 'Đã lưu Master.', 'ok'); break;
        case 'operator_saved': toast(data.message || 'Đã lưu cấu hình.', 'ok'); break;
        case 'background_updated': toast('Đã cập nhật nền game.', 'ok'); break;
        case 'game_control_ack': toast(`Game: đã gửi lệnh ${data.command}.`, 'ok'); break;
        case 'obs_action': toast(data.message || 'OBS action', data.ok ? 'ok' : 'error'); break;
        case 'obs_audio_report': renderAudioReport(data); break;
        case 'license_required':
            toast(data.message || 'Cần kích hoạt bản quyền.', 'error');
            window.TisoLicense?.refresh();
            break;
        case 'error': toast(data.message || 'Có lỗi.', 'error'); break;
    }
}

function connectSocket() {
    clearTimeout(state.reconnectTimer);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}`);
    state.socket = socket;
    setText('#bridge-port', location.port || (location.protocol === 'https:' ? '443' : '80'));
    setText('#dash-bridge', location.host);

    socket.addEventListener('open', () => {
        $('#bridge-dot').className = 'dot ok';
        setBadge($('#dash-bridge-badge'), 'ONLINE', 'ok');
        send({ type: 'register', role: 'control' });
    });
    socket.addEventListener('message', event => {
        try { handleSocketMessage(JSON.parse(event.data)); } catch (error) { console.warn('Control message ignored:', error); }
    });
    socket.addEventListener('close', () => {
        $('#bridge-dot').className = 'dot bad';
        setBadge($('#dash-bridge-badge'), 'OFFLINE', 'bad');
        state.system.overlayClients = 0; renderSystem();
        state.reconnectTimer = setTimeout(connectSocket, 1800);
    });
    socket.addEventListener('error', () => socket.close());
}

$('#live-provider').addEventListener('change', () => setText('#provider-help', PROVIDER_HELP[$('#live-provider').value] || PROVIDER_HELP.auto));
$('#username').addEventListener('input', updateUsernameHint);
$('#username').addEventListener('keydown', event => { if (event.key === 'Enter') $('#connect-live').click(); });
async function fileToPngBlob(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Không đọc được ảnh.'));
            image.src = objectUrl;
        });
        const maxSide = 4096;
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { alpha: false });
        context.fillStyle = '#05040a';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Không thể chuyển ảnh sang PNG.')), 'image/png'));
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function uploadGameBackground() {
    const input = $('#game-background-file');
    const file = input?.files?.[0];
    if (!file) return toast('Hãy chọn ảnh nền trước.', 'error');
    const button = $('#game-background-apply');
    button.disabled = true;
    button.textContent = 'Đang áp dụng…';
    try {
        const png = await fileToPngBlob(file);
        if (png.size > 20 * 1024 * 1024) throw new Error('Ảnh sau khi xử lý vẫn vượt quá 20 MB.');
        const response = await fetch('/api/background', {
            method: 'POST',
            headers: { 'Content-Type': 'image/png' },
            body: png
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok === false) throw new Error(result.message || `HTTP ${response.status}`);
        toast(result.message || 'Đã áp dụng nền mới.', 'success');
    } catch (error) {
        toast(error.message || 'Không thể áp dụng nền.', 'error');
    } finally {
        button.disabled = false;
        button.textContent = 'Áp dụng nền';
    }
}


$('#game-background-file')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    const preview = $('#game-background-preview');
    const empty = $('#game-background-empty');
    if (!file) {
        preview?.classList.add('hidden');
        if (empty) empty.textContent = 'Chưa chọn ảnh';
        return;
    }
    const url = URL.createObjectURL(file);
    preview.onload = () => URL.revokeObjectURL(url);
    preview.src = url;
    preview.classList.remove('hidden');
    if (empty) empty.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
});
$('#game-background-apply')?.addEventListener('click', uploadGameBackground);

async function uploadGameMusic() {
    const input = $('#game-music-file');
    const file = input?.files?.[0];
    if (!file) return toast('Hãy chọn file âm thanh trước.', 'error');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['mp3', 'wav', 'ogg'].includes(ext)) return toast('Chỉ hỗ trợ MP3, WAV hoặc OGG.', 'error');
    const button = $('#game-music-apply');
    button.disabled = true;
    button.textContent = 'Đang tải âm thanh…';
    try {
        const response = await fetch('/api/music', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
            body: file
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok === false) throw new Error(result.message || `HTTP ${response.status}`);
        toast(result.message || 'Đã áp dụng âm thanh nền.', 'ok');
        send({ type: 'media_settings', musicVolume: (Number($('#music-volume').value) || 0) / 100 });
    } catch (error) {
        toast(error.message || 'Không thể tải âm thanh.', 'error');
    } finally {
        button.disabled = false;
        button.textContent = 'Áp dụng âm thanh';
    }
}

$('#game-music-file')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file) return;
    $('#music-current-file').textContent = `Đã chọn: ${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    setBadge($('#music-file-status'), 'SẴN SÀNG', 'warn');
});
$('#game-music-apply')?.addEventListener('click', uploadGameMusic);
$('#music-volume')?.addEventListener('input', () => {
    $('#music-volume-value').textContent = `${$('#music-volume').value}%`;
});
function saveMusicVolume() {
    send({ type: 'media_settings', musicVolume: (Number($('#music-volume').value) || 0) / 100 });
}
$('#music-save-volume')?.addEventListener('click', saveMusicVolume);

// ----- Nghe thử nhạc nền ngay trên Control Panel -----
const musicPreview = new Audio();
musicPreview.preload = 'none';

function syncPreviewVolume() {
    musicPreview.volume = Math.max(0, Math.min(1, (Number($('#music-volume')?.value) || 0) / 100));
}

function stopMusicPreview() {
    musicPreview.pause();
    musicPreview.currentTime = 0;
    const button = $('#music-preview');
    if (button) button.textContent = '▶ Nghe thử';
}

$('#music-volume')?.addEventListener('input', syncPreviewVolume);
musicPreview.addEventListener('ended', stopMusicPreview);
musicPreview.addEventListener('error', () => {
    stopMusicPreview();
    toast('Không phát được file âm thanh. Hãy chọn và áp dụng file trước.', 'error');
});

$('#music-preview')?.addEventListener('click', async () => {
    const button = $('#music-preview');
    if (!musicPreview.paused) {
        musicPreview.pause();
        button.textContent = '▶ Tiếp tục';
        return;
    }
    try {
        if (!musicPreview.src) musicPreview.src = `/api/music/current?t=${Date.now()}`;
        syncPreviewVolume();
        await musicPreview.play();
        button.textContent = '⏸ Tạm dừng';
    } catch (error) {
        toast(`Không phát được: ${error.message}`, 'error');
    }
});
$('#music-preview-stop')?.addEventListener('click', stopMusicPreview);

// ----- Âm thanh chào khách -----
async function uploadBinary(url, file, buttonEl, busyText, doneText) {
    buttonEl.disabled = true;
    const original = buttonEl.textContent;
    buttonEl.textContent = busyText;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
            body: file
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok === false) throw new Error(result.message || `HTTP ${response.status}`);
        toast(result.message || doneText, 'success');
        return true;
    } catch (error) {
        toast(error.message || 'Không thể tải file.', 'error');
        return false;
    } finally {
        buttonEl.disabled = false;
        buttonEl.textContent = original;
    }
}

// Nạp danh sách âm thanh báo + giọng đọc cho combobox (gọi 1 lần khi mở trang).
let welcomeListLoaded = false;
async function loadWelcomeLists() {
    try {
        const data = await (await fetch('/api/welcome-sounds')).json();
        const soundSel = $('#welcome-sound');
        if (soundSel && Array.isArray(data.sounds)) {
            soundSel.innerHTML = '';
            for (const s of data.sounds) {
                const opt = document.createElement('option');
                opt.value = s.file; opt.textContent = s.label;
                soundSel.appendChild(opt);
            }
        }
        const voiceSel = $('#welcome-voice');
        if (voiceSel && Array.isArray(data.voices)) {
            voiceSel.innerHTML = '';
            for (const v of data.voices) {
                const opt = document.createElement('option');
                opt.value = v.value; opt.textContent = v.label;
                voiceSel.appendChild(opt);
            }
        }
        welcomeListLoaded = true;
        syncWelcomeSelects();
    } catch { /* để im, thử lại lần render sau */ }
}

// Đưa combobox về đúng lựa chọn đang lưu trong cấu hình.
function syncWelcomeSelects() {
    const media = state.operator.media || {};
    const soundSel = $('#welcome-sound');
    if (soundSel && media.welcomeFile && [...soundSel.options].some(o => o.value === media.welcomeFile)) {
        soundSel.value = media.welcomeFile;
    }
    const voiceSel = $('#welcome-voice');
    if (voiceSel && media.welcomeLang && [...voiceSel.options].some(o => o.value === media.welcomeLang)) {
        voiceSel.value = media.welcomeLang;
    }
}

$('#welcome-volume')?.addEventListener('input', () => {
    $('#welcome-volume-value').textContent = `${$('#welcome-volume').value}%`;
});
// Bật/tắt và âm lượng áp dụng ngay, không cần nút lưu.
$('#welcome-enabled')?.addEventListener('change', () => {
    send({ type: 'media_settings', welcomeEnabled: $('#welcome-enabled').checked });
});
$('#welcome-volume')?.addEventListener('change', () => {
    send({ type: 'media_settings', welcomeVolume: (Number($('#welcome-volume').value) || 0) / 100 });
});
$('#welcome-apply')?.addEventListener('click', () => {
    send({
        type: 'media_settings',
        welcomeFile: $('#welcome-sound')?.value || 'welcome.wav',
        welcomeLang: $('#welcome-voice')?.value || 'vi'
    });
    toast('Đã áp dụng âm thanh chào.', 'success');
});

// Nghe thử: phát âm thanh báo đang chọn, rồi đọc thử một tên mẫu bằng giọng đang chọn.
const welcomePreview = new Audio();
welcomePreview.preload = 'none';
let welcomePreviewStage = 0; // 0 = xong, 1 = đang phát chuông, 2 = đang đọc tên
function stopWelcomePreview() {
    welcomePreviewStage = 0;
    welcomePreview.pause();
    welcomePreview.currentTime = 0;
    const button = $('#welcome-preview');
    if (button) button.textContent = '▶ Nghe thử';
}
function welcomePreviewVolume() {
    welcomePreview.volume = Math.max(0, Math.min(1, (Number($('#welcome-volume')?.value) || 0) / 100));
}
welcomePreview.addEventListener('ended', async () => {
    if (welcomePreviewStage === 1) {
        // Xong chuông → đọc tên mẫu bằng giọng đang chọn.
        welcomePreviewStage = 2;
        const voice = $('#welcome-voice')?.value || 'vi';
        welcomePreview.src = `/api/tts?lang=${encodeURIComponent(voice)}&text=${encodeURIComponent('Chào mừng Anh Tuấn')}&t=${Date.now()}`;
        welcomePreviewVolume();
        try { await welcomePreview.play(); } catch { stopWelcomePreview(); }
    } else {
        stopWelcomePreview();
    }
});
welcomePreview.addEventListener('error', () => {
    // Nếu lỗi ở bước chuông thì vẫn thử đọc tên; lỗi ở bước tên thì dừng.
    if (welcomePreviewStage === 1) { welcomePreview.dispatchEvent(new Event('ended')); return; }
    stopWelcomePreview();
    toast('Không phát được. Kiểm tra mạng cho phần đọc tên.', 'error');
});
$('#welcome-preview')?.addEventListener('click', async () => {
    const button = $('#welcome-preview');
    if (welcomePreviewStage !== 0) { stopWelcomePreview(); return; }
    welcomePreviewStage = 1;
    const sound = $('#welcome-sound')?.value || 'welcome.wav';
    welcomePreview.src = `/api/welcome-sound/current?file=${encodeURIComponent(sound)}&t=${Date.now()}`;
    welcomePreviewVolume();
    try {
        await welcomePreview.play();
        button.textContent = '⏸ Dừng';
    } catch {
        // Không có chuông thì bỏ qua, đọc luôn tên.
        welcomePreview.dispatchEvent(new Event('ended'));
    }
});
loadWelcomeLists();

// ----- Video logo góc dưới phải -----
// Bật/tắt, kích thước, độ mờ đều lưu + áp dụng ngay khi chỉnh (không cần nút lưu).
$('#logo-scale')?.addEventListener('input', () => {
    $('#logo-scale-value').textContent = `${$('#logo-scale').value}%`;
});
$('#logo-opacity')?.addEventListener('input', () => {
    $('#logo-opacity-value').textContent = `${$('#logo-opacity').value}%`;
});
$('#logo-enabled')?.addEventListener('change', () => {
    send({ type: 'media_settings', logoEnabled: $('#logo-enabled').checked });
});
$('#logo-scale')?.addEventListener('change', () => {
    send({ type: 'media_settings', logoScale: (Number($('#logo-scale').value) || 18) / 100 });
});
$('#logo-opacity')?.addEventListener('change', () => {
    send({ type: 'media_settings', logoOpacity: (Number($('#logo-opacity').value) || 100) / 100 });
});
$('#logo-file')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file) return;
    $('#logo-current-file').textContent = `Đã chọn: ${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    setBadge($('#logo-status'), 'SẴN SÀNG', 'warn');
});
// "Áp dụng" = lưu + áp dụng luôn: tải logo mới (nếu có chọn) và áp mọi cài đặt.
$('#logo-apply-file')?.addEventListener('click', async () => {
    const file = $('#logo-file')?.files?.[0];
    if (file) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['mp4', 'mov', 'webm', 'png', 'jpg', 'jpeg'].includes(ext)) {
            return toast('Chỉ hỗ trợ MP4, MOV, WEBM hoặc PNG/JPG.', 'error');
        }
        await uploadBinary('/api/logo-video', file, $('#logo-apply-file'), 'Đang tải…', 'Đã cập nhật logo.');
    }
    send({
        type: 'media_settings',
        logoEnabled: $('#logo-enabled').checked,
        logoScale: (Number($('#logo-scale').value) || 18) / 100,
        logoOpacity: (Number($('#logo-opacity').value) || 100) / 100
    });
    if (!file) toast('Đã áp dụng cài đặt logo.', 'success');
});

// ----- Kiểm tra âm thanh có thật sự vào OBS không -----
function audioSourceLabel(kind) {
    const value = String(kind || '').toLowerCase();
    if (value.includes('process_output')) return 'Tiếng riêng của ứng dụng';
    if (value.includes('output_capture')) return 'Desktop Audio (toàn bộ tiếng máy)';
    if (value.includes('input_capture')) return 'Micro';
    return kind || 'Nguồn âm thanh';
}

function renderAudioReport(data) {
    const container = $('#obs-audio-result');
    const badge = $('#obs-audio-badge');
    const button = $('#obs-audio-check');
    if (button) { button.disabled = false; button.textContent = 'Kiểm tra âm thanh (3 giây)'; }
    if (!container) return;

    if (!data.ok) {
        setBadge(badge, 'LỖI', 'bad');
        container.replaceChildren();
        const row = document.createElement('div');
        row.className = 'empty';
        row.textContent = data.message || 'Không kiểm tra được âm thanh OBS.';
        container.append(row);
        return;
    }

    const report = data.report || {};
    const inputs = Array.isArray(report.inputs) ? report.inputs : [];
    setBadge(badge, report.hasAudio ? 'CÓ TIẾNG' : 'KHÔNG CÓ TIẾNG', report.hasAudio ? 'ok' : 'bad');

    const rows = inputs.map(item => {
        const row = document.createElement('div');
        const audible = item.muted === false && item.track1 !== false && item.peak > 0.0005;
        row.className = `audio-row ${audible ? 'live' : ''}`.trim();

        const head = document.createElement('div');
        head.className = 'audio-name';
        const name = document.createElement('b');
        name.textContent = item.inputName;
        const kind = document.createElement('small');
        kind.textContent = audioSourceLabel(item.inputKind);
        head.append(name, kind);

        const state = document.createElement('span');
        state.className = 'audio-state';
        if (item.muted) state.textContent = 'Đang tắt tiếng';
        else if (item.track1 === false) state.textContent = 'Không nằm trên track 1';
        else if (!audible) state.textContent = 'Không có tín hiệu';
        else state.textContent = `Đang lên sóng · đỉnh ${item.peakDb} dB`;

        row.append(head, state);
        return row;
    });

    const summary = document.createElement('div');
    summary.className = `audio-summary ${report.hasAudio ? 'ok' : 'warn'}`;
    if (!inputs.length) {
        summary.textContent = 'OBS chưa có nguồn âm thanh nào. Hãy bật Desktop Audio hoặc thêm Application Audio Capture cho TISO.exe.';
    } else if (report.hasAudio) {
        summary.textContent = `Âm thanh đang vào OBS qua: ${report.audibleInputs.join(', ')}.`
            + (report.streamActive ? ' Phiên LIVE đang phát nên người xem nghe được.' : ' OBS chưa bấm Start Streaming.');
    } else {
        summary.textContent = 'Không đo được tín hiệu nào trong 3 giây. Kiểm tra nhạc có đang phát, nguồn có bị tắt tiếng hoặc sai thiết bị phát không.';
    }

    container.replaceChildren(summary, ...rows);
}

$('#obs-audio-check')?.addEventListener('click', () => {
    const button = $('#obs-audio-check');
    if (button) { button.disabled = true; button.textContent = 'Đang đo tín hiệu…'; }
    setBadge($('#obs-audio-badge'), 'ĐANG ĐO', 'warn');
    send({ type: 'obs_audio_check', durationMs: 3000 });
});
$('#music-volume')?.addEventListener('change', saveMusicVolume);

$('#connect-live').addEventListener('click', () => {
    const { username } = parseTikTokUsername($('#username').value);
    if (!username) return toast('Nhập username hoặc link TikTok LIVE hợp lệ.', 'error');
    send({ type: 'set_username', username, provider: $('#live-provider').value || 'auto' });
});
$('#disconnect-live').addEventListener('click', () => send({ type: 'disconnect_tiktok' }));

$$('.rules-tab').forEach(button => button.addEventListener('click', () => {
    $$('.rules-tab').forEach(item => item.classList.toggle('active', item === button));
    $$('.rules-panel').forEach(panel => panel.classList.toggle('active', panel.id === `rules-${button.dataset.rulesTab}`));
}));

$('#add-chat-rule').addEventListener('click', () => {
    const container = $('#chat-rules'); if (container.querySelector('.empty')) container.replaceChildren();
    container.append(createRuleRow(emptyRule('chat', { action: 'dance', match: 'exact' })));
});
$('#add-gift-rule').addEventListener('click', () => {
    renderGiftCatalog();
    const dialog = $('#gift-rule-dialog');
    if (dialog?.showModal) dialog.showModal();
    else appendGiftRule();
});
$('#add-manual-gift-rule')?.addEventListener('click', () => appendGiftRule());
$('#save-events').addEventListener('click', () => saveRules(true));

$$('[data-game-toggle]').forEach(button => button.addEventListener('click', () => {
    if (!state.system.overlayClients) return toast('Unity game chưa kết nối Bridge.', 'error');
    const command = button.dataset.gameToggle;
    const current = Boolean(state.telemetry[command]);
    send({ type: 'game_control', command, value: !current });
}));
$('#reset-game').addEventListener('click', () => send({ type: 'game_control', command: 'reset' }));
$$('[data-demo]').forEach(button => button.addEventListener('click', () => send({ type: 'demo_start', count: Number(button.dataset.demo) || 30 })));
$('#stop-demo').addEventListener('click', () => send({ type: 'demo_stop' }));
$$('[data-demo-action]').forEach(button => button.addEventListener('click', () => send({
    type: 'demo_event', action: button.dataset.demoAction, value: Number(button.dataset.value) || 1,
    userIndex: Number($('#demo-user-index').value) || 1
})));

$('#obs-connect').addEventListener('click', () => send({
    type: 'obs_connect', host: $('#obs-host').value.trim() || '127.0.0.1', port: Number($('#obs-port').value) || 4455,
    password: $('#obs-password').value,
    autoConnect: $('#obs-auto-connect').checked
}));
$('#obs-disconnect').addEventListener('click', () => send({ type: 'obs_disconnect' }));
$('#obs-refresh').addEventListener('click', () => send({ type: 'obs_refresh' }));
$('#obs-set-scene').addEventListener('click', () => send({ type: 'obs_set_scene', sceneName: $('#obs-scene').value }));
$('#obs-load-sources').addEventListener('click', () => send({ type: 'obs_get_sources', sceneName: $('#obs-scene').value }));
$('#obs-capture-game').addEventListener('click', () => {
    if (state.obs.state !== 'connected') return toast('Hãy kết nối OBS trước.', 'error');
    const sceneName = $('#obs-scene').value || state.obs.currentScene;
    if (!sceneName) return toast('Hãy chọn scene OBS.', 'error');
    send({
        type: 'obs_capture_game',
        sceneName,
        mode: $('#obs-capture-mode').value,
        sourceName: $('#obs-source-name').value.trim() || 'TISO Game',
        windowTitle: $('#obs-window-title').value.trim() || 'TISO',
        executable: $('#obs-executable').value.trim() || 'TISO.exe'
    });
});

$('#save-master-json').addEventListener('click', () => {
    try { send({ type: 'master_save', master: JSON.parse($('#master-json').value) }); }
    catch { toast('JSON Master không hợp lệ.', 'error'); }
});
$('#save-operator-json').addEventListener('click', () => {
    try { send({ type: 'operator_save', operator: JSON.parse($('#operator-json').value) }); }
    catch { toast('JSON Operator không hợp lệ.', 'error'); }
});

setText('#provider-help', PROVIDER_HELP.auto);
updateUsernameHint();
renderLiveStatus();
renderMetrics();
renderOperator();
renderRules();
renderGiftCatalog();
renderObs();
renderSystem();
renderTelemetry();
const initialTab = location.hash.replace(/^#/, '') || 'main';
goTab(initialTab, false);
connectSocket();
