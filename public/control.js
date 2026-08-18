'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
    socket: null,
    reconnectTimer: null,
    live: { state: 'idle', username: null, message: 'Chưa kết nối' },
    metrics: { source: 'idle', events: 0, chats: 0, gifts: 0, diamonds: 0, likes: 0, players: 0, eventsPerSecond: 0 },
    master: { joinMode: 'keyword_only', giftAlwaysJoins: true, rules: [] },
    operator: { spawnEvents: { chat: true, gift: true, like: false, follow: true, share: true, member: false }, obs: { host: '127.0.0.1', port: 4455, password: '', autoConnect: true }, media: { musicVolume: .35, backgroundFile: 'nenamphu.png', audioFile: '' }, recentEventLimit: 200 },
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
    const validTabs = new Set(['main', 'obs', 'advanced']);
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
    setText('#overview-live', live.state === 'connected' ? 'Đang LIVE' : live.state === 'demo' ? 'DEMO' : titleMap[live.state] || 'Chưa kết nối');
    setText('#overview-live-sub', live.username ? `@${live.username}` : (live.message || 'Dán link để bắt đầu'));
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
    setText('#overview-events', formatNumber(m.events));
    setText('#overview-players', formatNumber(m.players));
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
    setText('#overview-unity', online ? 'Online' : 'Offline');
    setText('#overview-unity-sub', online ? `${state.system.overlayClients || 0} client đang nối` : 'Chưa thấy game');
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

function isDecorationAction(action) {
    return ['medal', 'vip', 'topdj'].includes(action);
}

let activeGiftRuleRow = null;

function actionDisplayName(action) {
    const key = String(action || '').trim();
    const preset = ACTIONS.find(([value]) => value === key);
    return preset?.[1] || key || 'Chưa cấu hình';
}

function hiddenRuleField(field, value = '') {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.dataset.field = field;
    input.value = value == null ? '' : String(value);
    return input;
}

function giftObservedMeta(rule) {
    const giftId = String(rule.giftId || '');
    return [...state.gifts.values()].find(gift => String(gift.giftId || '') === giftId) || null;
}

function syncGiftRuleSummary(row) {
    const get = field => row.querySelector(`[data-field="${field}"]`);
    const action = get('action')?.value?.trim() || '';
    const seconds = Number(get('durationSeconds')?.value) || 0;
    const label = get('label')?.value?.trim() || '';
    const title = row.querySelector('.gift-action-summary b');
    const meta = row.querySelector('.gift-action-summary small');
    if (title) title.textContent = actionDisplayName(action);
    if (meta) {
        const parts = [];
        if (seconds > 0) parts.push(`${seconds}s`);
        if (label) parts.push(label);
        meta.textContent = parts.length ? parts.join(' · ') : 'Bấm Cấu hình để chỉnh';
    }
}

function openGiftActionEditor(row) {
    if (!row) return;
    activeGiftRuleRow = row;
    const get = field => row.querySelector(`[data-field="${field}"]`);
    const giftName = get('trigger')?.value?.trim() || 'Gift';
    const giftId = get('giftId')?.value?.trim() || '—';
    setText('#gift-action-title', `${giftName} → hành động`);
    setText('#gift-action-meta', `Gift ID ${giftId} · nhập action key mà game của bạn hỗ trợ.`);
    $('#gift-action-trigger').value = get('trigger')?.value || '';
    $('#gift-action-id').value = get('giftId')?.value || '';
    $('#gift-action-key').value = get('action')?.value || '';
    $('#gift-action-duration').value = get('durationSeconds')?.value || '0';
    $('#gift-action-label').value = get('label')?.value || '';
    $('#gift-action-decoration').value = get('decorationCondition')?.value || 'always';
    const dialog = $('#gift-action-dialog');
    if (dialog?.showModal) dialog.showModal();
    setTimeout(() => $('#gift-action-key')?.focus(), 0);
}

function saveGiftActionEditor() {
    const row = activeGiftRuleRow;
    if (!row) return;
    const action = $('#gift-action-key').value.trim();
    if (!action) {
        toast('Nhập action trước khi lưu.', 'error');
        $('#gift-action-key').focus();
        return;
    }
    const set = (field, value) => {
        const input = row.querySelector(`[data-field="${field}"]`);
        if (input) input.value = value;
    };
    set('trigger', $('#gift-action-trigger').value.trim());
    set('giftId', $('#gift-action-id').value.trim());
    set('action', action);
    set('durationSeconds', String(Math.max(0, Number($('#gift-action-duration').value) || 0)));
    set('label', $('#gift-action-label').value.trim());
    set('decorationCondition', $('#gift-action-decoration').value || 'always');
    const name = row.querySelector('.gift-rule-identity b');
    const meta = row.querySelector('.gift-rule-identity small');
    const trigger = row.querySelector('[data-field="trigger"]')?.value?.trim() || 'Gift chưa đặt tên';
    const giftId = row.querySelector('[data-field="giftId"]')?.value?.trim();
    if (name) name.textContent = trigger;
    if (meta) meta.textContent = giftId ? `ID ${giftId}` : 'Chưa có Gift ID';
    syncGiftRuleSummary(row);
    $('#gift-action-dialog')?.close();
    activeGiftRuleRow = null;
    toast('Đã cập nhật hành động cho Gift.', 'ok');
}

function createGiftRuleRow(rule) {
    const row = document.createElement('div');
    row.className = 'rule-row gift gift-rule-compact';
    row.dataset.ruleId = rule.id || makeRuleId();
    row._originalRule = { ...rule };

    const enabledWrap = document.createElement('label');
    enabledWrap.className = 'gift-rule-toggle';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'rule-enable';
    enabled.dataset.field = 'enabled';
    enabled.checked = rule.enabled !== false;
    const enabledText = document.createElement('span');
    enabledText.textContent = 'Bật';
    enabledWrap.append(enabled, enabledText);

    const observed = giftObservedMeta(rule);
    const identity = document.createElement('div');
    identity.className = 'gift-rule-identity';
    const visual = document.createElement('div');
    visual.className = 'gift-rule-visual';
    if (observed?.giftPictureUrl) {
        const image = document.createElement('img');
        image.src = observed.giftPictureUrl;
        image.alt = '';
        image.loading = 'lazy';
        visual.append(image);
    } else {
        visual.textContent = '🎁';
    }
    const identityText = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = rule.trigger || observed?.giftName || 'Gift chưa đặt tên';
    const giftMeta = document.createElement('small');
    const idText = rule.giftId ? `ID ${rule.giftId}` : 'Chưa có Gift ID';
    const diamondText = Number(rule.displayDiamonds) > 0 ? ` · ${formatNumber(rule.displayDiamonds)}💎` : '';
    giftMeta.textContent = `${idText}${diamondText}`;
    identityText.append(name, giftMeta);
    identity.append(visual, identityText);

    const summary = document.createElement('div');
    summary.className = 'gift-action-summary';
    const summaryLabel = document.createElement('span');
    summaryLabel.textContent = 'Hành động';
    const summaryTitle = document.createElement('b');
    const summaryMeta = document.createElement('small');
    summary.append(summaryLabel, summaryTitle, summaryMeta);

    const actions = document.createElement('div');
    actions.className = 'gift-rule-actions';
    const configureButton = document.createElement('button');
    configureButton.type = 'button';
    configureButton.className = 'btn small primary';
    configureButton.textContent = 'Cấu hình';
    configureButton.addEventListener('click', () => openGiftActionEditor(row));
    const testButton = document.createElement('button');
    testButton.type = 'button';
    testButton.className = 'btn small';
    testButton.textContent = 'Test';
    testButton.addEventListener('click', () => {
        saveRules(false);
        send({ type: 'master_test', ruleId: row.dataset.ruleId, diamonds: Math.max(1, Number(rule.displayDiamonds) || 100) });
    });
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn small danger ghost icon-only';
    deleteButton.title = 'Xóa rule';
    deleteButton.setAttribute('aria-label', 'Xóa rule');
    deleteButton.textContent = '×';
    deleteButton.addEventListener('click', () => row.remove());
    actions.append(configureButton, testButton, deleteButton);

    row.append(
        enabledWrap,
        identity,
        summary,
        actions,
        hiddenRuleField('trigger', rule.trigger || ''),
        hiddenRuleField('giftId', rule.giftId || ''),
        hiddenRuleField('action', rule.action || ''),
        hiddenRuleField('decorationCondition', rule.decorationCondition || 'always'),
        hiddenRuleField('durationSeconds', String((Number(rule.durationMs) || 0) / 1000)),
        hiddenRuleField('label', rule.label || '')
    );
    syncGiftRuleSummary(row);
    return row;
}

function createRuleRow(rule) {
    if (rule.source === 'gift') return createGiftRuleRow(rule);

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

    const action = actionSelect(rule.action);
    row.append(createField('Hành động', action));

    const decorationCondition = decorationConditionSelect(rule.decorationCondition);
    const decorationConditionField = createField('Điều kiện cánh', decorationCondition);
    decorationConditionField.classList.add('decoration-condition-field');
    row.append(decorationConditionField);

    const syncDecorationCondition = () => {
        const visible = isDecorationAction(action.value);
        decorationConditionField.hidden = !visible;
        row.classList.toggle('has-decoration-condition', visible);
    };
    action.addEventListener('change', syncDecorationCondition);
    syncDecorationCondition();

    const duration = document.createElement('input');
    duration.type = 'number'; duration.min = '0'; duration.max = '300'; duration.step = '.5';
    duration.dataset.field = 'durationSeconds'; duration.value = String((Number(rule.durationMs) || 0) / 1000);
    row.append(createField('Giây', duration));

    const label = document.createElement('input');
    label.dataset.field = 'label'; label.value = rule.label || ''; label.placeholder = 'Nhãn';
    row.append(createField('Nhãn', label));

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
            action: get('action')?.value?.trim() || (source === 'gift' ? '' : 'dance'),
            decorationCondition: get('decorationCondition')?.value || original.decorationCondition || 'always',
            durationMs: Math.round((Number(get('durationSeconds')?.value) || 0) * 1000),
            label: get('label')?.value?.trim() || ''
        };
        if (source === 'chat' && result.match !== 'any' && !result.trigger) result.enabled = false;
        if (source === 'gift' && (!result.action || (!result.giftId && !result.trigger))) result.enabled = false;
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
        action: '',
        label: ''
    }) : emptyRule('gift', { action: '', label: '' });
    const row = createRuleRow(rule);
    containerGift.append(row);
    $('#gift-rule-dialog')?.close();
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    requestAnimationFrame(() => openGiftActionEditor(row));
    toast(gift
        ? `Đã chọn ${gift.giftName || 'Gift'}. Cấu hình action cho Gift này.`
        : 'Đã thêm Gift rule thủ công. Có thể cấu hình action ngay.');
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

$$('[data-action-suggestion]').forEach(button => button.addEventListener('click', () => {
    $('#gift-action-key').value = button.dataset.actionSuggestion || '';
    $('#gift-action-key').focus();
}));
$('#gift-action-save')?.addEventListener('click', saveGiftActionEditor);
$('#gift-action-cancel')?.addEventListener('click', () => {
    $('#gift-action-dialog')?.close();
    activeGiftRuleRow = null;
});
$('#gift-action-dialog')?.addEventListener('close', () => { activeGiftRuleRow = null; });
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
