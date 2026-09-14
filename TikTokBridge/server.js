/* ═══════════════════════════════════════════════════════════
   TISO — TikTok Live Bridge Server
   © 2025 TISO
   Phát hành theo giấy phép MIT. Xem file ../LICENSE.
═══════════════════════════════════════════════════════════ */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const WebSocket = require('ws');
const { TikTokLiveConnection, UserOfflineError, InvalidUniqueIdError } = require('tiktok-live-connector');
const { getServerSettings, loadEnvironmentFile } = require('./src/config/environment');
const { normalizeProvider } = require('./src/config/provider');
const { sanitizeOperatorConfig, shouldSpawnForEvent } = require('./src/config/operator');
const { ObsClient, sanitizeObsEndpoint } = require('./src/obs/obs-client');
const tts = require('./src/media/tts');
const { normalizeTikTokUsername } = require('./public/js/normalize-username');

require('./src/license/secure-env').loadSecureEnvironment();

const { normalizeTikFinityMessage } = require('./src/tiktok/normalize-tikfinity-event');
const {
    normalizeChat,
    normalizeMember,
    normalizeGift,
    normalizeLike,
    normalizeSocial,
    isPendingGiftStreak
} = require('./src/tiktok/normalize-event');

const gameConfig = require('./config/game.json');
const giftConfig = require('./config/gifts.json');
const initialMasterConfig = require('./config/master.json');

// operator.json và observed-gifts.json mang dữ liệu riêng của từng máy (mật khẩu OBS,
// gift đã gặp trong phiên) nên không nằm trong repo. Lần chạy đầu tiên sẽ dựng lại
// từ file .example.json đi kèm.
function loadLocalConfig(fileName) {
    const target = require('node:path').join(__dirname, 'config', fileName);
    const template = target.replace(/\.json$/, '.example.json');
    const fsSync = require('node:fs');
    if (!fsSync.existsSync(target)) {
        if (!fsSync.existsSync(template)) throw new Error(`Thiếu ${fileName} và cả file mẫu tương ứng.`);
        fsSync.copyFileSync(template, target);
        console.log(`[CONFIG] Đã tạo ${fileName} từ file mẫu.`);
    }
    return JSON.parse(fsSync.readFileSync(target, 'utf8'));
}

const initialObservedGifts = loadLocalConfig('observed-gifts.json');
const initialOperatorConfig = loadLocalConfig('operator.json');
const { normalizeText, sanitizeMasterConfig, resolveMasterRule, applyRule, applyBuiltInChatCommand } = require('./src/master/rules');
const licenseCore = require('./src/license/license');
const licenseMailer = require('./src/license/mailer');
const updater = require('./src/update/updater');
const {
    sanitizeGameEvent,
    isLoopbackAddress,
    isAllowedHost,
    isAllowedOrigin,
    consumeRateLimit
} = require('./src/security');

const app = express();
const server = http.createServer(app);

const { port: PORT, host: HOST, allowLan: ALLOW_LAN } = getServerSettings();
const wss = new WebSocket.Server({
    noServer: true,
    maxPayload: 32 * 1024,
    perMessageDeflate: false,
    clientTracking: true
});
const publicDir = path.join(__dirname, 'public');
const assetsDir = path.join(__dirname, 'assets');
const gifsDir = path.join(assetsDir, 'gifs');
const masterConfigPath = path.join(__dirname, 'config', 'master.json');
const observedGiftsPath = path.join(__dirname, 'config', 'observed-gifts.json');
const operatorConfigPath = path.join(__dirname, 'config', 'operator.json');
const liveAssetsDir = path.join(__dirname, '..', 'LiveAssets');
const liveBackgroundPath = path.join(liveAssetsDir, 'nenamphu.png');
const liveBackgroundBackupPath = path.join(liveAssetsDir, 'nenamphu.original.png');
const djMusicDir = path.join(__dirname, '..', 'DJ_MUSIC');
const musicSelectedPath = path.join(djMusicDir, 'SELECTED.txt');
const musicVolumePath = path.join(djMusicDir, 'VOLUME.txt');
const djSfxDir = path.join(__dirname, '..', 'DJ_SFX');
const djLogoDir = path.join(__dirname, '..', 'DJ_LOGO');
const welcomeSelectedPath = path.join(djSfxDir, 'SELECTED_WELCOME.txt');
const ttsCacheDir = path.join(djSfxDir, 'tts_cache');
tts.configure(ttsCacheDir);

// Engine PirateTok (Python): nối thẳng TikTok, không EulerStream, không key.
const { spawn } = require('node:child_process');
const fsSync = require('node:fs');
// Ưu tiên Python nhúng sẵn trong gói (pyengine) để máy khách khỏi cài Python.
const bundledPython = path.join(__dirname, 'pyengine', 'python.exe');
const PYTHON_BIN = process.env.PYTHON_BIN
    || (fsSync.existsSync(bundledPython) ? bundledPython : (process.platform === 'win32' ? 'python' : 'python3'));
const pirateBridgePath = path.join(__dirname, 'piratetok_bridge.py');
const PIRATE_CONNECT_TIMEOUT_MS = 25000;

// Nhãn hiển thị đẹp cho các âm thanh báo có sẵn; file lạ thì lấy theo tên.
const WELCOME_SOUND_LABELS = {
    'welcome.wav': 'Chuông ngân (mặc định)',
    'ting.wav': 'Ting (ngắn)',
    'chuong-doi.wav': 'Chuông đôi',
    'nhac-vui.wav': 'Nhạc chào vui',
    'boong.wav': 'Boong (trầm)'
};
// Danh sách giọng đọc tên miễn phí (Google TTS theo ngôn ngữ). Tiếng Việt hợp nhất cho tên Việt.
const WELCOME_VOICES = [
    { value: 'vi', label: 'Tiếng Việt (nữ)' },
    { value: 'en', label: 'Tiếng Anh - Mỹ' },
    { value: 'fr', label: 'Tiếng Pháp' },
    { value: 'ja', label: 'Tiếng Nhật' },
    { value: 'ko', label: 'Tiếng Hàn' },
    { value: 'zh-CN', label: 'Tiếng Trung' }
];
function welcomeSoundLabel(file) {
    if (WELCOME_SOUND_LABELS[file]) return WELCOME_SOUND_LABELS[file];
    return file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || file;
}
const LIVE_PROVIDER = normalizeProvider(process.env.LIVE_PROVIDER || gameConfig.liveProvider || 'auto');
const TIKFINITY_WS_URL = String(process.env.TIKFINITY_WS_URL || gameConfig.tikfinityWsUrl || 'ws://127.0.0.1:21213/');
const DIRECT_CONNECT_TIMEOUT_MS = 12000;
const TIKFINITY_CONNECT_TIMEOUT_MS = 5000;

let liveConnection = null;
let connectionAttempt = 0;
let desiredUsername = null;
let desiredProvider = LIVE_PROVIDER;
let reconnectTimer = null;
let reconnectFailures = 0;
let demoTimer = null;
const demoTimeouts = new Set();
let connectionStatus = {
    state: 'idle',
    username: null,
    message: 'Chưa kết nối'
};
let metrics = createMetrics();
let masterConfig = sanitizeMasterConfig(initialMasterConfig);
let operatorConfig = sanitizeOperatorConfig(initialOperatorConfig);
const recentEventIds = new Map();
const sessionPlayers = new Map();
// Moc kich hoat luat cuoi cung theo tung tai khoan: key = `${ruleId}|${userId}`.
const ruleCooldowns = new Map();
const sessionVipScores = new Map();
const observedGifts = new Map((Array.isArray(initialObservedGifts) ? initialObservedGifts : [])
    .map(gift => [String(gift.giftId || gift.giftName || ''), gift])
    .filter(([key]) => key));
let observedGiftSaveTimer = null;
const recentEvents = [];
const eventRateTimestamps = [];
let gameTelemetry = { fps: 0, queueCount: 0, playerCount: 0, droppedMessages: 0, chroma: false, hud: false, feed: false, controls: false, fullscreen: false, updatedAt: 0 };
const obsClient = new ObsClient(status => broadcastRole('control', { type: 'obs_status', ...status }));

if (!ALLOW_LAN && !isLoopbackAddress(HOST) && HOST.toLowerCase() !== 'localhost') {
    throw new Error('Từ chối mở Node ra mạng LAN. Chỉ đặt ALLOW_LAN=1 khi đã có lớp xác thực bên ngoài.');
}

function createMetrics() {
    return {
        source: 'idle',
        events: 0,
        members: 0,
        chats: 0,
        gifts: 0,
        diamonds: 0,
        likes: 0,
        startedAt: null
    };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host, PORT, ALLOW_LAN)) {
        return res.status(403).type('text/plain').send('Forbidden');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob:",
        `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}`
    ].join('; '));
    if (req.path.startsWith('/api/') || req.path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});

const staticOptions = { dotfiles: 'deny', fallthrough: true, etag: true, index: ['index.html'] };

// Cổng bản quyền đặt TRƯỚC static: máy chưa kích hoạt không tải nổi giao diện vận hành,
// nên không thể lách bằng cách xoá lớp phủ trong DevTools.
const LICENSED_PAGES = new Set(['/control.html', '/control.js']);

app.get('/', (_req, res) => {
    res.redirect(licenseCore.licenseStatus().active ? '/control.html' : '/activate.html');
});

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = req.path;
    const licensed = licenseCore.licenseStatus().active;

    if (LICENSED_PAGES.has(pathname) && !licensed) {
        return res.redirect('/activate.html');
    }
    // Đã kích hoạt rồi thì không cần ở lại trang kích hoạt nữa.
    if (pathname === '/activate.html' && licensed) {
        return res.redirect('/control.html');
    }
    return next();
});

app.use(express.static(publicDir, staticOptions));
app.use('/assets', express.static(assetsDir, staticOptions));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build'), staticOptions));

// Phát lại đúng file nhạc nền đang được chọn, phục vụ nút "Nghe thử" trên Control Panel.
app.get('/api/music/current', async (_req, res) => {
    try {
        const fileName = String(operatorConfig.media?.audioFile || '').trim();
        if (!fileName) return res.status(404).json({ ok: false, message: 'Chưa chọn file âm thanh nào.' });
        const safeName = path.basename(fileName);
        const filePath = path.join(djMusicDir, safeName);
        await fs.access(filePath);
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(filePath);
    } catch {
        return res.status(404).json({ ok: false, message: 'Không tìm thấy file âm thanh trong thư mục DJ_MUSIC.' });
    }
});

// Danh sách âm thanh báo có sẵn + danh sách giọng đọc, cho combobox trên Control Panel.
app.get('/api/welcome-sounds', async (_req, res) => {
    try {
        const selected = path.basename(String(operatorConfig.media?.welcomeFile || 'welcome.wav'));
        let files = [];
        try {
            files = (await fs.readdir(djSfxDir))
                .filter(name => ['.wav', '.mp3', '.ogg'].includes(path.extname(name).toLowerCase()))
                .sort((a, b) => (a === 'welcome.wav' ? -1 : b === 'welcome.wav' ? 1 : a.localeCompare(b)));
        } catch { files = []; }
        const sounds = files.map(file => ({ file, label: welcomeSoundLabel(file), selected: file === selected }));
        return res.json({ sounds, voices: WELCOME_VOICES, selectedVoice: operatorConfig.media?.welcomeLang || 'vi' });
    } catch (error) {
        return res.status(500).json({ ok: false, message: `Không đọc được danh sách âm thanh: ${error.message}` });
    }
});

// Nghe thử một âm thanh báo (mặc định là âm thanh đang chọn, hoặc ?file= để thử file khác).
app.get('/api/welcome-sound/current', async (req, res) => {
    try {
        const requested = req.query.file ? path.basename(String(req.query.file)) : '';
        const fileName = requested || path.basename(String(operatorConfig.media?.welcomeFile || 'welcome.wav')) || 'welcome.wav';
        const ext = path.extname(fileName).toLowerCase();
        if (!['.wav', '.mp3', '.ogg'].includes(ext)) return res.status(400).json({ ok: false, message: 'File không hợp lệ.' });
        const filePath = path.join(djSfxDir, fileName);
        await fs.access(filePath);
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(filePath);
    } catch {
        return res.status(404).json({ ok: false, message: 'Không tìm thấy âm thanh chào trong thư mục DJ_SFX.' });
    }
});

// Xem trước logo đang dùng (video hoặc ảnh).
app.get('/api/logo/current', async (_req, res) => {
    try {
        const fileName = String(operatorConfig.media?.logoFile || '').trim();
        if (!fileName) return res.status(404).json({ ok: false, message: 'Chưa chọn logo nào.' });
        const safeName = path.basename(fileName);
        const filePath = path.join(djLogoDir, safeName);
        await fs.access(filePath);
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(filePath);
    } catch {
        return res.status(404).json({ ok: false, message: 'Không tìm thấy logo trong thư mục DJ_LOGO.' });
    }
});

// Tổng hợp giọng đọc chào khách theo tên. Game gọi endpoint này rồi phát MP3.
app.get('/api/tts', async (req, res) => {
    try {
        const text = tts.sanitizeText(req.query.text || req.query.q || '');
        if (!text) return res.status(400).json({ ok: false, message: 'Thiếu nội dung đọc.' });
        const lang = tts.normalizeLang(req.query.lang || operatorConfig.media?.welcomeLang || 'vi');
        const buffer = await tts.synthesize(text, lang);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.end(buffer);
    } catch (error) {
        return res.status(502).json({ ok: false, message: `Không tạo được giọng đọc: ${error.message}` });
    }
});

// ---------- Bản quyền ----------

app.get('/api/license/status', (_req, res) => {
    res.json(licenseCore.licenseStatus());
});

app.get('/api/license/options', (_req, res) => {
    res.json({
        durations: licenseCore.durationOptions(),
        receivers: licenseMailer.receivers().map(licenseMailer.maskEmail),
        mac: licenseCore.machineMac(),
        device: licenseCore.deviceName(),
        machine_tag: licenseCore.machineTag(),
        valid_minutes: licenseCore.otpValidMinutes()
    });
});

app.post('/api/license/request', express.json({ limit: '8kb' }), async (req, res) => {
    try {
        // Mã OTP đi thẳng sang tầng gửi mail, không lọt vào response hay log.
        const { otp, label } = licenseCore.createActivationRequest(req.body?.duration_code);
        const sent = await licenseMailer.sendActivationCode({
            otp,
            label,
            mac: licenseCore.machineMac(),
            device: licenseCore.deviceName()
        });
        return res.json({
            ok: true,
            label,
            sent_to: sent.map(licenseMailer.maskEmail),
            valid_minutes: licenseCore.otpValidMinutes()
        });
    } catch (error) {
        console.error('[LICENSE] Gửi mã thất bại:', error.message);
        return res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/license/activate', express.json({ limit: '8kb' }), (req, res) => {
    const result = licenseCore.activate(req.body?.key);
    if (result.ok === false) return res.status(400).json(result);
    return res.json(result);
});

// ---------- Cập nhật ----------

app.get('/api/update/check', async (req, res) => {
    const force = String(req.query.force || '') === '1';
    res.json(await updater.checkForUpdate({ force }));
});

app.post('/api/update/apply', express.json({ limit: '4kb' }), (_req, res) => {
    try {
        return res.json(updater.startUpdate());
    } catch (error) {
        return res.status(400).json({ ok: false, error: error.message });
    }
});

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', appId: 'tiso-bridge', version: updater.currentVersion() });
});

app.post('/api/background', express.raw({ type: 'image/png', limit: '20mb' }), async (req, res) => {
    try {
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const pngMagic = buffer.length >= 8
            && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
            && buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A;
        if (!pngMagic) return res.status(400).json({ ok: false, message: 'Ảnh nền phải là PNG hợp lệ.' });
        if (buffer.length > 20 * 1024 * 1024) return res.status(413).json({ ok: false, message: 'Ảnh nền vượt quá 20 MB.' });

        await fs.mkdir(liveAssetsDir, { recursive: true });
        try {
            await fs.access(liveBackgroundBackupPath);
        } catch {
            try { await fs.copyFile(liveBackgroundPath, liveBackgroundBackupPath); } catch { }
        }
        const tempPath = `${liveBackgroundPath}.tmp`;
        await fs.writeFile(tempPath, buffer);
        await fs.rename(tempPath, liveBackgroundPath);

        operatorConfig = sanitizeOperatorConfig({
            ...operatorConfig,
            media: { ...operatorConfig.media, backgroundFile: 'nenamphu.png' }
        });
        await writeJsonAtomic(operatorConfigPath, operatorConfig);
        broadcastRole('control', { type: 'operator_config', operator: publicOperatorConfig() });
        broadcastRole('overlay', { type: 'game_control', command: 'background_reload', boolValue: true });
        broadcastRole('control', { type: 'background_updated', file: 'LiveAssets/nenamphu.png', bytes: buffer.length });
        return res.json({ ok: true, message: 'Đã cập nhật nền và gửi lệnh reload cho game.', bytes: buffer.length });
    } catch (error) {
        console.error('[BACKGROUND] Upload failed:', error);
        return res.status(500).json({ ok: false, message: `Không thể lưu nền: ${error.message}` });
    }
});

app.post('/api/music', express.raw({ type: 'application/octet-stream', limit: '80mb' }), async (req, res) => {
    try {
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!buffer.length) return res.status(400).json({ ok: false, message: 'File âm thanh rỗng.' });
        if (buffer.length > 80 * 1024 * 1024) return res.status(413).json({ ok: false, message: 'File âm thanh vượt quá 80 MB.' });
        const originalName = String(req.headers['x-file-name'] || 'background.mp3').slice(0, 240);
        const ext = path.extname(originalName).toLowerCase();
        if (!['.mp3', '.wav', '.ogg'].includes(ext)) {
            return res.status(400).json({ ok: false, message: 'Chỉ hỗ trợ MP3, WAV hoặc OGG.' });
        }
        await fs.mkdir(djMusicDir, { recursive: true });
        const fileName = `00-tiso-background${ext}`;
        for (const candidateExt of ['.mp3', '.wav', '.ogg']) {
            if (candidateExt === ext) continue;
            await fs.unlink(path.join(djMusicDir, `00-tiso-background${candidateExt}`)).catch(() => {});
        }
        const targetPath = path.join(djMusicDir, fileName);
        const tempPath = `${targetPath}.tmp`;
        await fs.writeFile(tempPath, buffer);
        await fs.rename(tempPath, targetPath);
        await fs.writeFile(musicSelectedPath, fileName, 'utf8');

        operatorConfig = sanitizeOperatorConfig({
            ...operatorConfig,
            media: { ...operatorConfig.media, audioFile: fileName }
        });
        await writeJsonAtomic(operatorConfigPath, operatorConfig);
        broadcastRole('control', { type: 'operator_config', operator: publicOperatorConfig() });
        broadcastRole('overlay', { type: 'game_control', command: 'music_reload', boolValue: true });
        return res.json({ ok: true, file: fileName, bytes: buffer.length, message: 'Đã cập nhật âm thanh nền.' });
    } catch (error) {
        console.error('[MUSIC] Upload failed:', error);
        return res.status(500).json({ ok: false, message: `Không thể lưu âm thanh: ${error.message}` });
    }
});

// Tải lên âm thanh chào tuỳ chọn (thay cho welcome.wav mặc định).
app.post('/api/welcome-sound', express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
    try {
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!buffer.length) return res.status(400).json({ ok: false, message: 'File âm thanh rỗng.' });
        if (buffer.length > 20 * 1024 * 1024) return res.status(413).json({ ok: false, message: 'File âm thanh chào vượt quá 20 MB.' });
        const originalName = String(req.headers['x-file-name'] || 'welcome.wav').slice(0, 240);
        const ext = path.extname(originalName).toLowerCase();
        if (!['.wav', '.mp3', '.ogg'].includes(ext)) {
            return res.status(400).json({ ok: false, message: 'Chỉ hỗ trợ WAV, MP3 hoặc OGG.' });
        }
        await fs.mkdir(djSfxDir, { recursive: true });
        const fileName = `welcome${ext}`;
        for (const candidateExt of ['.wav', '.mp3', '.ogg']) {
            if (candidateExt === ext) continue;
            await fs.unlink(path.join(djSfxDir, `welcome${candidateExt}`)).catch(() => {});
        }
        const targetPath = path.join(djSfxDir, fileName);
        const tempPath = `${targetPath}.tmp`;
        await fs.writeFile(tempPath, buffer);
        await fs.rename(tempPath, targetPath);

        operatorConfig = sanitizeOperatorConfig({
            ...operatorConfig,
            media: { ...operatorConfig.media, welcomeFile: fileName }
        });
        await writeJsonAtomic(operatorConfigPath, operatorConfig);
        broadcastRole('control', { type: 'operator_config', operator: publicOperatorConfig() });
        broadcastRole('overlay', { type: 'game_control', command: 'welcome_reload', boolValue: true });
        return res.json({ ok: true, file: fileName, bytes: buffer.length, message: 'Đã cập nhật âm thanh chào.' });
    } catch (error) {
        console.error('[WELCOME] Upload failed:', error);
        return res.status(500).json({ ok: false, message: `Không thể lưu âm thanh chào: ${error.message}` });
    }
});

// Tải lên video/ảnh logo góc dưới phải.
app.post('/api/logo-video', express.raw({ type: 'application/octet-stream', limit: '80mb' }), async (req, res) => {
    try {
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!buffer.length) return res.status(400).json({ ok: false, message: 'File logo rỗng.' });
        if (buffer.length > 80 * 1024 * 1024) return res.status(413).json({ ok: false, message: 'File logo vượt quá 80 MB.' });
        const originalName = String(req.headers['x-file-name'] || 'logo.mp4').slice(0, 240);
        const ext = path.extname(originalName).toLowerCase();
        const videoExts = ['.mp4', '.mov', '.m4v', '.webm'];
        const imageExts = ['.png', '.jpg', '.jpeg'];
        if (![...videoExts, ...imageExts].includes(ext)) {
            return res.status(400).json({ ok: false, message: 'Chỉ hỗ trợ MP4, MOV, WEBM hoặc PNG/JPG.' });
        }
        await fs.mkdir(djLogoDir, { recursive: true });
        // Chỉ giữ một logo: xoá các file logo cũ trước khi ghi file mới.
        for (const candidateExt of [...videoExts, ...imageExts]) {
            await fs.unlink(path.join(djLogoDir, `logo${candidateExt}`)).catch(() => {});
        }
        const fileName = `logo${ext}`;
        const targetPath = path.join(djLogoDir, fileName);
        const tempPath = `${targetPath}.tmp`;
        await fs.writeFile(tempPath, buffer);
        await fs.rename(tempPath, targetPath);

        operatorConfig = sanitizeOperatorConfig({
            ...operatorConfig,
            media: { ...operatorConfig.media, logoFile: fileName }
        });
        await writeJsonAtomic(operatorConfigPath, operatorConfig);
        broadcastRole('control', { type: 'operator_config', operator: publicOperatorConfig() });
        broadcastRole('overlay', { type: 'game_control', command: 'logo_reload', boolValue: true });
        return res.json({ ok: true, file: fileName, bytes: buffer.length, message: 'Đã cập nhật logo góc dưới phải.' });
    } catch (error) {
        console.error('[LOGO] Upload failed:', error);
        return res.status(500).json({ ok: false, message: `Không thể lưu logo: ${error.message}` });
    }
});

app.get('/api/config', (_req, res) => {
    res.json({ game: gameConfig, gifts: giftConfig, master: masterConfig, operator: publicOperatorConfig(), observedGifts: [...observedGifts.values()] });
});

app.get('/api/gifs', async (_req, res) => {
    try {
        const files = await fs.readdir(gifsDir);
        res.json(files.filter(file => file.toLowerCase().endsWith('.gif')));
    } catch (error) {
        if (error.code === 'ENOENT') return res.json([]);
        console.error('Không thể đọc thư mục GIF:', error);
        res.status(500).json({ error: 'Không thể đọc danh sách GIF' });
    }
});

app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

function broadcast(data) {
    const payload = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (client.bufferedAmount > 512 * 1024) {
            client.terminate();
            continue;
        }
        client.send(payload);
    }
}

// Mật khẩu OBS không được rời khỏi máy chủ: Control Panel có ô nhập riêng,
// còn ô Operator.json chỉ nên thấy chuỗi rỗng.
function publicOperatorConfig(config = operatorConfig) {
    // Không gửi key/mật khẩu thật ra giao diện; chỉ báo đã có hay chưa.
    return {
        ...config,
        obs: { ...(config.obs || {}), password: '' },
        eulerApiKey: '',
        eulerApiKeySet: Boolean(config.eulerApiKey)
    };
}

function broadcastRole(role, data) {
    const payload = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN || !client.registered || client.role !== role) continue;
        if (client.bufferedAmount > 512 * 1024) {
            client.terminate();
            continue;
        }
        client.send(payload);
    }
}

function getOverlayCount() {
    let count = 0;
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && client.registered && client.role === 'overlay') count += 1;
    }
    return count;
}

function systemStatusMessage() {
    return {
        type: 'system_status',
        bridge: 'connected',
        overlayClients: getOverlayCount(),
        gameTelemetry,
        obs: obsClient.getStatus()
    };
}

function broadcastSystemStatus() {
    broadcastRole('control', systemStatusMessage());
}

function send(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512 * 1024) return ws.terminate();
    ws.send(JSON.stringify(data));
}

function setStatus(state, username, message) {
    connectionStatus = { state, username, message };
    broadcast({ type: 'status', ...connectionStatus });
}

function currentEventRate(now = Date.now()) {
    const cutoff = now - 1000;
    while (eventRateTimestamps.length && eventRateTimestamps[0] < cutoff) eventRateTimestamps.shift();
    return eventRateTimestamps.length;
}

function broadcastMetrics() {
    broadcast({
        type: 'metrics',
        ...metrics,
        players: sessionPlayers.size,
        eventsPerSecond: currentEventRate()
    });
}

async function writeJsonAtomic(filePath, value) {
    const temporary = `${filePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
}

function summarizeLiveEvent(event) {
    const timestamp = Date.now();
    const summary = {
        id: String(event.eventId || `${timestamp}-${Math.random().toString(36).slice(2, 8)}`),
        timestamp,
        type: event.type,
        userId: event.userId || '',
        username: event.uniqueId || '',
        nickname: event.nickname || event.uniqueId || 'TikTok user',
        comment: event.comment || '',
        giftId: event.giftId || '',
        giftName: event.giftName || '',
        giftPictureUrl: event.giftPictureUrl || '',
        diamondCount: Number(event.diamondCount) || 0,
        likeCount: Number(event.likeCount) || 0,
        action: event.action || '',
        label: event.label || '',
        spectatorOnly: Boolean(event.spectatorOnly),
        joinedNow: Boolean(event.joinedNow)
    };
    recentEvents.push(summary);
    const limit = Math.max(50, Number(operatorConfig.recentEventLimit) || 200);
    while (recentEvents.length > limit) recentEvents.shift();
    eventRateTimestamps.push(timestamp);
    currentEventRate(timestamp);
    broadcastRole('control', { type: 'live_event', event: summary });
}

function giftCatalogMessage() {
    return {
        type: 'gift_catalog',
        gifts: [...observedGifts.values()].sort((a, b) =>
            (Number(a.diamondCount) || 0) - (Number(b.diamondCount) || 0) ||
            String(a.giftName || '').localeCompare(String(b.giftName || '')))
    };
}

function viewerGuideMessage() {
    const joinRule = (masterConfig.rules || []).find(rule => rule.enabled && rule.source === 'chat' && rule.action === 'join');
    const giftRules = (masterConfig.rules || [])
        .filter(rule => rule.enabled && rule.source === 'gift' &&
            (Number(rule.displayDiamonds) > 0 || (rule.giftId && observedGifts.has(String(rule.giftId)))));
    const actionOrder = new Map([['walk', 0], ['medal', 1], ['fireworks', 2], ['grow', 3], ['topdj', 4]]);
    const items = giftRules
        .filter(rule => actionOrder.has(rule.action))
        .sort((a, b) => actionOrder.get(a.action) - actionOrder.get(b.action))
        .slice(0, 5)
        .map(rule => {
            const learned = rule.giftId ? observedGifts.get(String(rule.giftId)) : null;
            return {
                giftId: rule.giftId || learned?.giftId || '',
                giftName: learned?.giftName || String(rule.trigger || '').split(',')[0].trim() || 'Gift',
                diamondCount: Number(learned?.diamondCount) || Number(rule.displayDiamonds) || 0,
                giftPictureUrl: learned?.giftPictureUrl || '',
                label: rule.label || rule.action.toUpperCase()
            };
        });
    const zoomRule = giftRules.find(rule => rule.action === 'camera');
    const zoomLearned = zoomRule?.giftId ? observedGifts.get(String(zoomRule.giftId)) : null;
    return {
        type: 'viewer_guide',
        joinCommand: joinRule ? String(joinRule.trigger || '').split(',')[0].trim() : '',
        zoomGiftName: zoomLearned?.giftName || (zoomRule ? String(zoomRule.trigger || '').split(',')[0].trim() : ''),
        guideItems: items
    };
}

function scheduleObservedGiftSave() {
    clearTimeout(observedGiftSaveTimer);
    observedGiftSaveTimer = setTimeout(() => {
        observedGiftSaveTimer = null;
        fs.writeFile(observedGiftsPath, `${JSON.stringify([...observedGifts.values()], null, 2)}\n`, 'utf8')
            .catch(error => console.error('Không thể lưu thư viện gift:', error));
    }, 250);
}

function learnObservedGift(event) {
    const giftId = String(event.giftId || '').trim();
    const giftName = String(event.giftName || 'Gift').trim();
    const key = giftId || giftName.toLocaleLowerCase('vi');
    if (!key) return;
    const previous = observedGifts.get(key) || {};
    const repeats = Math.max(1, Number(event.repeatCount) || 1);
    const unitDiamonds = Math.max(0,
        Number(event.unitDiamondCount) || Math.round((Number(event.diamondCount) || 0) / repeats));
    const learnedGift = {
        ...previous,
        giftId,
        giftName,
        diamondCount: unitDiamonds || Number(previous.diamondCount) || 0,
        giftPictureUrl: nonEmpty(event.giftPictureUrl, previous.giftPictureUrl || ''),
        lastSeenAt: Date.now()
    };
    observedGifts.set(key, learnedGift);
    if (observedGifts.size > 500) {
        const oldest = [...observedGifts.entries()]
            .sort((a, b) => (Number(a[1].lastSeenAt) || 0) - (Number(b[1].lastSeenAt) || 0));
        for (let index = 0; index < oldest.length - 500; index += 1) observedGifts.delete(oldest[index][0]);
    }
    let masterChanged = false;
    for (const rule of masterConfig.rules || []) {
        if (!giftId) break;
        if (rule.source !== 'gift' || rule.giftId) continue;
        const aliases = String(rule.trigger || '').split(',').map(normalizeText).filter(Boolean);
        if (!aliases.includes(normalizeText(giftName))) continue;
        rule.giftId = giftId;
        rule.displayDiamonds = unitDiamonds || rule.displayDiamonds || 0;
        masterChanged = true;
        break;
    }
    if (masterChanged) {
        fs.writeFile(masterConfigPath, `${JSON.stringify(masterConfig, null, 2)}\n`, 'utf8')
            .catch(error => console.error('Không thể tự gắn Gift ID vào Master:', error));
        broadcast({ type: 'master_config', master: masterConfig });
    }
    scheduleObservedGiftSave();
    broadcast(giftCatalogMessage());
    broadcast(viewerGuideMessage());
}

function isRealObservedGift(event) {
    const giftId = String(event.giftId || '');
    return event.userId !== 'master-test' && !giftId.startsWith('demo-') && !giftId.startsWith('master-');
}

function resetSessionState(source = metrics.source) {
    metrics = { ...createMetrics(), source, startedAt: source === 'idle' ? null : Date.now() };
    sessionPlayers.clear();
    sessionVipScores.clear();
    recentEventIds.clear();
    ruleCooldowns.clear();
}

function createSnapshot() {
    pruneSessionPlayers();
    return {
        type: 'snapshot',
        players: [...sessionPlayers.values()],
        vipScores: [...sessionVipScores.values()]
    };
}

function pruneSessionPlayers(now = Date.now()) {
    const cutoff = now - Math.max(1000, Number(gameConfig.playerTtlMs) || 600000);
    for (const [userId, player] of sessionPlayers) {
        if ((Number(player.lastActive) || 0) < cutoff) sessionPlayers.delete(userId);
    }
    const maximum = Math.max(1, Number(gameConfig.maxPlayers) || 200);
    if (sessionPlayers.size <= maximum) return;
    const oldest = [...sessionPlayers.values()]
        .sort((a, b) => (Number(a.lastActive) || 0) - (Number(b.lastActive) || 0));
    for (let index = 0; index < oldest.length - maximum; index += 1) {
        sessionPlayers.delete(oldest[index].userId);
    }
}

function normalizeUsername(value) {
    return normalizeTikTokUsername(value);
}

function nonEmpty(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function dedupeKey(event) {
    if (event.eventId) return `id:${event.eventId}`;
    return `fallback:${[
        event.type,
        event.userId,
        event.giftId,
        event.giftName,
        event.repeatCount,
        event.diamondCount,
        event.likeCount,
        event.comment
    ].map(value => String(value ?? '')).join('|')}`;
}

function isDuplicate(event) {
    const now = Date.now();
    const key = dedupeKey(event);
    const previous = recentEventIds.get(key);
    const retentionMs = event.eventId ? 10 * 60 * 1000 : 2500;
    if (previous && now - previous < retentionMs) return true;
    recentEventIds.set(key, now);
    if (recentEventIds.size > 2000) {
        for (const [id, timestamp] of recentEventIds) {
            if (now - timestamp > 10 * 60 * 1000) recentEventIds.delete(id);
        }
        while (recentEventIds.size > 2000) recentEventIds.delete(recentEventIds.keys().next().value);
    }
    return false;
}

function resolveGiftRule(event) {
    const exact = giftConfig.byGiftId[String(event.giftId)];
    if (exact) return exact;
    const giftName = normalizeGiftName(event.giftName);
    const named = (giftConfig.byGiftName || []).find(rule =>
        (rule.aliases || []).some(alias => normalizeGiftName(alias) === giftName)
    );
    if (named) return named;
    const value = Number(event.diamondCount) || 0;
    return [...giftConfig.diamondBands]
        .sort((a, b) => b.minimum - a.minimum)
        .find(rule => value >= rule.minimum);
}

function normalizeGiftName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLocaleLowerCase('vi');
}

function emitGameEvent(event) {
    if (isDuplicate(event)) return;
    const now = Date.now();
    let giftRule = null;
    if (event.type === 'gift') {
        giftRule = event.masterRuleId ? null : resolveGiftRule(event);
        if (giftRule) {
            event.action = giftRule.action;
            event.durationMs = giftRule.durationMs;
            event.label = giftRule.label;
            event.decorationCondition = giftRule.decorationCondition;
            event.variant = giftRule.variant;
            event.fireworkBursts = giftRule.fireworkBursts;
        }
    }
    if (event.userId && !event.spectatorOnly) {
        const previous = sessionPlayers.get(event.userId) || {};
        const playerState = {
            ...previous,
            userId: event.userId,
            uniqueId: nonEmpty(event.uniqueId, previous.uniqueId || event.userId),
            nickname: nonEmpty(event.nickname, previous.nickname || event.uniqueId || 'TikTok user'),
            avatar: nonEmpty(event.avatar, previous.avatar || ''),
            lastActive: now
        };
        if (event.type === 'gift') {
            playerState.giftPower =
                Math.max(0, Number(previous.giftPower) || 0) +
                Math.max(0, Number(event.diamondCount) || 0);
            if (event.action === 'medal') {
                playerState.titleLabel = event.label;
                playerState.titleVariant = event.variant || 'fire';
                playerState.titleExpiresAt = now + Math.max(3000, Number(event.durationMs) || 60000);
            }
        }
        sessionPlayers.set(event.userId, playerState);
        pruneSessionPlayers(now);
    }
    metrics.events += 1;
    if (event.type === 'member') metrics.members += 1;
    if (event.type === 'chat') metrics.chats += 1;
    if (event.type === 'gift') {
        metrics.gifts += 1;
        metrics.diamonds += event.diamondCount;
        const vip = sessionVipScores.get(event.userId) || {
            userId: event.userId,
            nickname: event.nickname,
            avatar: event.avatar,
            score: 0
        };
        vip.nickname = nonEmpty(event.nickname, vip.nickname || 'TikTok user');
        vip.avatar = nonEmpty(event.avatar, vip.avatar || '');
        vip.score += event.diamondCount;
        sessionVipScores.set(event.userId, vip);
    }
    if (event.type === 'like') metrics.likes += event.likeCount;
    summarizeLiveEvent(event);
    broadcast(event);
    broadcastMetrics();
}

// Trong khoang cooldown cua luat, cung mot tai khoan chi kich hoat hanh dong mot lan.
// Tra true neu duoc phep chay (va ghi lai moc); false neu dang trong cooldown.
function passesRuleCooldown(rule, event) {
    if (!rule || !event.userId) return true;
    const seconds = Number(rule.cooldownSeconds) || 0;
    if (seconds <= 0) return true;

    const key = `${rule.id}|${event.userId}`;
    const now = Date.now();
    const last = ruleCooldowns.get(key) || 0;
    if (now - last < seconds * 1000) return false;
    ruleCooldowns.set(key, now);
    return true;
}

function processGameEvent(inputEvent) {
    const safeEvent = sanitizeGameEvent(inputEvent);
    if (!safeEvent) return;
    const matchedRule = resolveMasterRule(masterConfig, safeEvent);
    // Luat con trong cooldown cho tai khoan nay -> bo qua hanh dong (van tinh la su kien).
    const activeRule = passesRuleCooldown(matchedRule, safeEvent) ? matchedRule : null;
    const event = applyBuiltInChatCommand(applyRule(safeEvent, activeRule));
    const isKnownPlayer = Boolean(event.userId && sessionPlayers.has(event.userId));
    const explicitJoin = event.type === 'chat' && event.action === 'join';
    const spawnEnabled = shouldSpawnForEvent(operatorConfig, event.type);
    const shouldSpawn = metrics.source === 'demo' || explicitJoin || spawnEnabled;

    event.joinedNow = Boolean(event.userId && !isKnownPlayer && shouldSpawn);
    event.spectatorOnly = Boolean(event.userId && !isKnownPlayer && !shouldSpawn);

    if (event.type === 'gift') {
        if (isRealObservedGift(event)) {
            learnObservedGift(event);
            broadcast({
                type: 'gift_observed',
                giftId: event.giftId,
                giftName: event.giftName,
                diamondCount: event.unitDiamondCount || Math.round(event.diamondCount / Math.max(1, event.repeatCount || 1)),
                giftPictureUrl: event.giftPictureUrl || ''
            });
        }
    }
    emitGameEvent(event);
}

function stopDemo() {
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = null;
    for (const timeout of demoTimeouts) clearTimeout(timeout);
    demoTimeouts.clear();
}

function mockUser(index, manualName = null) {
    return {
        userId: manualName ? manualName : `demo-${index}`,
        uniqueId: manualName ? manualName : `dancer_${index}`,
        nickname: manualName ? manualName : `Dancer ${index}`,
        avatar: ''
    };
}

function emitDemoMember(index, manualName = null) {
    processGameEvent({
        type: 'member',
        action: 'join',
        joinedNow: true,
        eventId: `demo-join-${Date.now()}-${Math.random()}`,
        ...mockUser(index, manualName)
    });
}

function emitDemoAction(action, userIndex = 1, value = 1, giftName = '', manualName = null) {
    const user = mockUser(userIndex, manualName);
    const eventId = `demo-${action}-${Date.now()}-${Math.random()}`;
    if (action === 'member') return emitDemoMember(userIndex, manualName);
    if (action === 'dance') {
        return processGameEvent({ type: 'chat', eventId, ...user, comment: 'dance' });
    }
    if (action === 'jump') {
        return processGameEvent({ type: 'chat', eventId, ...user, comment: 'jump' });
    }
    if (action === 'walk') {
        return processGameEvent({ type: 'chat', eventId, ...user, comment: 'đi vòng' });
    }
    if (action === 'change') {
        return processGameEvent({ type: 'chat', eventId, ...user, comment: 'đổi nv' });
    }
    if (action === 'like') {
        return processGameEvent({ type: 'like', eventId, ...user, likeCount: value });
    }
    if (action === 'follow' || action === 'share') {
        return processGameEvent({ type: action, eventId, ...user });
    }
    if (action === 'gift') {
        const demoGiftNames = {
            1: 'Rose',
            5: 'Dance Pop',
            20: 'Camera Star',
            50: 'Fire Crown',
            100: 'VIP Gift',
            200: 'Super VIP',
            500: 'Firework Rain',
            1000: 'Party Universe'
        };
        return processGameEvent({
            type: 'gift',
            eventId,
            ...user,
            giftId: `demo-${value}`,
            giftName: giftName || demoGiftNames[value] || (value >= 100 ? 'Fireworks' : value >= 10 ? 'VIP Gift' : 'Rose'),
            repeatCount: 1,
            diamondCount: value
        });
    }
}

function startDemo(count) {
    stopDemo();
    resetSessionState('demo');
    setStatus('demo', null, `Chế độ demo: ${count} người`);
    broadcast({ type: 'reset' });

    for (let index = 1; index <= count; index += 1) {
        const timeout = setTimeout(() => {
            demoTimeouts.delete(timeout);
            emitDemoMember(index);
        }, index * 35);
        demoTimeouts.add(timeout);
    }

    demoTimer = setInterval(() => {
        const userIndex = 1 + Math.floor(Math.random() * count);
        const roll = Math.random();
        if (roll < 0.45) emitDemoAction('dance', userIndex);
        else if (roll < 0.65) emitDemoAction('walk', userIndex);
        else if (roll < 0.78) emitDemoAction('change', userIndex);
        else if (roll < 0.93) emitDemoAction('like', userIndex, 10);
        else emitDemoAction('gift', userIndex, Math.random() < 0.2 ? 100 : 10);
    }, 700);
}

async function disconnectCurrentConnection() {
    const previous = liveConnection;
    liveConnection = null;
    if (!previous) return;
    try {
        if (typeof previous.disconnect === 'function') await previous.disconnect();
        else if (typeof previous.close === 'function') previous.close();
    } catch (error) {
        console.warn('Không thể đóng kết nối TikTok cũ:', error.message);
    }
}

function cancelReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
}

class DirectTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`Không kết nối được TikTok trong ${timeoutMs} ms`);
        this.name = 'DirectTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

function connectWithTimeout(connection, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DirectTimeoutError(timeoutMs)), timeoutMs);
    });
    return Promise.race([connection.connect(), timeout]).finally(() => clearTimeout(timer));
}

function scheduleReconnect(username) {
    if (!username || desiredUsername !== username || reconnectTimer) return;
    const delayMs = Math.min(30000, 2000 * (2 ** Math.min(reconnectFailures, 4)));
    reconnectFailures += 1;
    const sourceHint = desiredProvider === 'tiktok'
        ? 'Mất kết nối TikTok trực tiếp'
        : desiredProvider === 'tikfinity'
            ? 'Chưa thấy TikFinity Desktop'
            : desiredProvider === 'piratetok'
                ? 'Mất kết nối PirateTok'
                : 'Mất kết nối TikTok LIVE';
    setStatus(
        'reconnecting',
        username,
        `${sourceHint}. Tự thử lại sau ${Math.ceil(delayMs / 1000)} giây...`
    );
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (desiredUsername === username) {
            void connectToLiveProvider(username, { resetSession: false, isReconnect: true });
        }
    }, delayMs);
}

function connectToLiveProvider(username, options = {}) {
    if (options.provider) desiredProvider = normalizeProvider(options.provider);
    switch (desiredProvider) {
        case 'piratetok':
            return connectToPirateTok(username, options);
        case 'tikfinity':
            return connectToTikFinity(username, options);
        case 'tiktok':
            return connectToTikTok(username, options);
        default:
            return connectAuto(username, options);
    }
}

async function connectAuto(username, options = {}) {
    const resetSession = options.resetSession !== false;
    const isReconnect = options.isReconnect === true;
    stopDemo();
    cancelReconnect();
    desiredUsername = username;
    await disconnectCurrentConnection();

    if (resetSession) {
        resetSessionState('tiktok');
        broadcast({ type: 'reset' });
        broadcastMetrics();
    }
    setStatus(
        isReconnect ? 'reconnecting' : 'connecting',
        username,
        isReconnect
            ? `Đang thử lại kết nối TikTok trực tiếp @${username}...`
            : `Đang thử kết nối TikTok trực tiếp @${username}...`
    );

    const direct = await connectToTikTok(username, { resetSession: false, isReconnect, isAutoProbe: true });
    if (direct.ok || direct.reason === 'superseded' || desiredUsername !== username) return;

    setStatus(
        isReconnect ? 'reconnecting' : 'connecting',
        username,
        direct.reason === 'offline'
            ? `@${username} chưa bật Live hoặc không tìm thấy. Đang thử TikFinity...`
            : 'TikTok Direct thất bại, đang thử TikFinity...'
    );

    const tikfinity = await connectToTikFinity(username, { resetSession: false, isReconnect });
    if (tikfinity.ok || tikfinity.reason === 'superseded' || desiredUsername !== username) return;

    setStatus(
        'error',
        username,
        direct.reason === 'offline'
            ? `Không tìm thấy phiên LIVE đang hoạt động của @${username}.`
            : 'Không thể kết nối LIVE bằng TikTok trực tiếp hoặc TikFinity.'
    );
}

async function connectToTikFinity(username, options = {}) {
    const resetSession = options.resetSession !== false;
    const isReconnect = options.isReconnect === true;
    stopDemo();
    cancelReconnect();
    desiredUsername = username;
    const attempt = ++connectionAttempt;
    await disconnectCurrentConnection();

    if (resetSession) {
        resetSessionState('tikfinity');
        broadcast({ type: 'reset' });
        broadcastMetrics();
    }
    setStatus(
        isReconnect ? 'reconnecting' : 'connecting',
        username,
        isReconnect ? 'Đang kết nối lại TikFinity Desktop...' : 'Đang kết nối TikFinity Desktop...'
    );

    const connection = new WebSocket(TIKFINITY_WS_URL);
    liveConnection = connection;
    const active = () => attempt === connectionAttempt && liveConnection === connection;

    return new Promise(resolve => {
        let settled = false;
        const settle = outcome => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            resolve(outcome);
        };
        const connectTimer = setTimeout(() => {
            if (!active()) return settle({ ok: false, attempt, reason: 'superseded' });
            console.warn(`Không thể kết nối TikFinity tại ${TIKFINITY_WS_URL} trong thời gian chờ.`);
            settle({ ok: false, attempt, reason: 'failed' });
        }, TIKFINITY_CONNECT_TIMEOUT_MS);
        connectTimer.unref();

        connection.on('open', () => {
            if (!active()) return settle({ ok: false, attempt, reason: 'superseded' });
            reconnectFailures = 0;
            cancelReconnect();
            metrics.source = 'tikfinity';
            setStatus('connected', username, `Đã kết nối TikFinity cho @${username}`);
            broadcastMetrics();
            console.log(`Đã kết nối TikFinity tại ${TIKFINITY_WS_URL}`);
            settle({ ok: true, attempt });
        });
        connection.on('message', payload => {
            if (!active()) return;
            for (const event of normalizeTikFinityMessage(payload)) processGameEvent(event);
        });
        connection.on('error', error => {
            console.warn(`TikFinity WebSocket: ${error.message}`);
        });
        connection.on('close', () => {
            if (!active()) return;
            liveConnection = null;
            settle({ ok: false, attempt, reason: 'closed' });
            scheduleReconnect(username);
        });
    });
}

async function connectToPirateTok(username, options = {}) {
    const resetSession = options.resetSession !== false;
    const isReconnect = options.isReconnect === true;
    stopDemo();
    cancelReconnect();
    desiredUsername = username;
    const attempt = ++connectionAttempt;
    await disconnectCurrentConnection();

    if (resetSession) {
        resetSessionState('piratetok');
        broadcast({ type: 'reset' });
        broadcastMetrics();
    }
    setStatus(
        isReconnect ? 'reconnecting' : 'connecting',
        username,
        isReconnect ? `Đang kết nối lại @${username} (PirateTok)...` : `Đang kết nối @${username} (PirateTok, miễn phí)...`
    );

    let child;
    try {
        child = spawn(PYTHON_BIN, [pirateBridgePath, username], { windowsHide: true });
    } catch (error) {
        setStatus('error', username, `Không chạy được PirateTok (thiếu Python?): ${error.message}`);
        return { ok: false, attempt, reason: 'failed' };
    }
    // Bọc child thành đối tượng có disconnect() để disconnectCurrentConnection đóng được.
    const wrapper = { disconnect() { try { child.kill(); } catch { /* bỏ qua */ } } };
    liveConnection = wrapper;
    const active = () => attempt === connectionAttempt && liveConnection === wrapper;

    return new Promise(resolve => {
        let settled = false;
        const settle = outcome => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            resolve(outcome);
        };
        const connectTimer = setTimeout(() => {
            if (!active()) return settle({ ok: false, attempt, reason: 'superseded' });
            console.warn('PirateTok không kết nối được trong thời gian chờ.');
            try { child.kill(); } catch { /* bỏ qua */ }
            settle({ ok: false, attempt, reason: 'failed' });
        }, PIRATE_CONNECT_TIMEOUT_MS);
        connectTimer.unref();

        let buffer = '';
        const handleLine = line => {
            const text = line.trim();
            if (!text) return;
            let msg;
            try { msg = JSON.parse(text); } catch { return; }
            if (msg.__status__ === 'connected') {
                if (!active()) return;
                reconnectFailures = 0;
                cancelReconnect();
                metrics.source = 'piratetok';
                setStatus('connected', username, `Đã kết nối @${username} (PirateTok)`);
                broadcastMetrics();
                console.log(`Đã kết nối PirateTok cho @${username}`);
                settle({ ok: true, attempt });
                return;
            }
            if (msg.__error__) {
                console.warn('PirateTok lỗi:', String(msg.__error__).slice(0, 200));
                if (!active()) return;
                setStatus('error', username, `PirateTok: ${String(msg.__error__).slice(0, 160)}`);
                settle({ ok: false, attempt, reason: 'failed' });
                return;
            }
            if (msg.__status__ === 'ended') {
                if (!active()) return;
                liveConnection = null;
                desiredUsername = null;
                cancelReconnect();
                setStatus('ended', username, `Live @${username} đã kết thúc`);
                return;
            }
            if (msg.__status__) return; // trạng thái khác: bỏ qua
            if (!active()) return;
            switch (msg.type) {
                case 'chat': processGameEvent(normalizeChat(msg)); break;
                case 'member': processGameEvent(normalizeMember(msg)); break;
                case 'like': processGameEvent(normalizeLike(msg)); break;
                case 'follow': processGameEvent(normalizeSocial('follow', msg)); break;
                case 'share': processGameEvent(normalizeSocial('share', msg)); break;
                case 'gift': {
                    const event = normalizeGift(msg);
                    if (!isPendingGiftStreak(event)) processGameEvent(event);
                    break;
                }
                default: break;
            }
        };
        child.stdout.on('data', chunk => {
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                handleLine(buffer.slice(0, idx));
                buffer = buffer.slice(idx + 1);
            }
        });
        child.stderr.on('data', chunk => {
            const t = chunk.toString('utf8').trim();
            if (t) console.warn('PirateTok stderr:', t.slice(0, 200));
        });
        child.on('error', error => {
            console.warn('PirateTok spawn error:', error.message);
            if (!active()) return;
            setStatus('error', username, `Không chạy được PirateTok: ${error.message}`);
            settle({ ok: false, attempt, reason: 'failed' });
        });
        child.on('close', code => {
            if (!active()) return settle({ ok: false, attempt, reason: 'superseded' });
            liveConnection = null;
            settle({ ok: false, attempt, reason: 'closed' });
            console.warn(`PirateTok thoát (mã ${code}), sẽ thử kết nối lại.`);
            scheduleReconnect(username);
        });
    });
}

function attachTikTokEvents(connection) {
    const active = () => liveConnection === connection;
    // EventEmitter treats an unhandled `error` event as fatal. Keep the bridge
    // alive and let connect/reconnect report the connection state instead.
    connection.on('error', error => {
        console.warn('TikTok connection error:', error?.message || error);
    });
    connection.on('member', data => active() && processGameEvent(normalizeMember(data)));
    connection.on('chat', data => active() && processGameEvent(normalizeChat(data)));
    connection.on('like', data => active() && processGameEvent(normalizeLike(data)));
    connection.on('follow', data => active() && processGameEvent(normalizeSocial('follow', data)));
    connection.on('share', data => active() && processGameEvent(normalizeSocial('share', data)));
    connection.on('gift', data => {
        if (!active()) return;
        const event = normalizeGift(data);
        if (!isPendingGiftStreak(event)) processGameEvent(event);
    });
}

async function connectToTikTok(username, options = {}) {
    const resetSession = options.resetSession !== false;
    const isReconnect = options.isReconnect === true;
    const isAutoProbe = options.isAutoProbe === true;
    stopDemo();
    cancelReconnect();
    desiredUsername = username;
    const attempt = ++connectionAttempt;
    await disconnectCurrentConnection();

    if (resetSession) {
        resetSessionState('tiktok');
        broadcast({ type: 'reset' });
        broadcastMetrics();
    }
    setStatus(
        isReconnect ? 'reconnecting' : 'connecting',
        username,
        isReconnect ? `Đang kết nối lại @${username}...` : `Đang kết nối @${username}...`
    );
    let connection;
    try {
        connection = new TikTokLiveConnection(username, {
            // Khoá ký lấy từ cấu hình (ô EulerStream key trên Control Panel), không đọc .env.
            signApiKey: operatorConfig.eulerApiKey || undefined,
            processInitialData: false,
            enableExtendedGiftInfo: false
        });
    } catch (error) {
        liveConnection = null;
        console.error(`Không thể tạo kết nối @${username}:`, error.message);
        if (isAutoProbe) return { ok: false, attempt, reason: 'invalid' };
        setStatus('error', username, `Không thể khởi tạo kết nối TikTok: ${error.message}`);
        return { ok: false, attempt, reason: 'invalid' };
    }
    liveConnection = connection;
    attachTikTokEvents(connection);

    connection.on('connected', () => {
        if (liveConnection !== connection) {
            void connection.disconnect().catch(() => {});
        }
    });
    connection.on('streamEnd', () => {
        if (liveConnection !== connection) return;
        liveConnection = null;
        desiredUsername = null;
        cancelReconnect();
        setStatus('ended', username, `Live @${username} đã kết thúc`);
    });
    connection.on('disconnected', () => {
        if (liveConnection !== connection) return;
        liveConnection = null;
        scheduleReconnect(username);
    });

    const previousWsTimeout = process.env.WS_CONNECT_TIMEOUT_MS;
    process.env.WS_CONNECT_TIMEOUT_MS = String(Math.max(3000, DIRECT_CONNECT_TIMEOUT_MS - 2000));
    try {
        const state = await connectWithTimeout(connection, DIRECT_CONNECT_TIMEOUT_MS + 2000);
        if (attempt !== connectionAttempt || liveConnection !== connection) {
            await connection.disconnect().catch(() => {});
            return { ok: false, attempt, reason: 'superseded' };
        }
        reconnectFailures = 0;
        metrics.source = 'tiktok';
        setStatus('connected', username, `Đã kết nối trực tiếp @${username}`);
        broadcastMetrics();
        console.log(`Đã kết nối trực tiếp @${username}, room ${state.roomId}`);
        return { ok: true, attempt };
    } catch (error) {
        if (attempt !== connectionAttempt) return { ok: false, attempt, reason: 'superseded' };
        liveConnection = null;
        console.error(`Không thể kết nối @${username}:`, error.message);
        const reason = error instanceof UserOfflineError ? 'offline'
            : error instanceof InvalidUniqueIdError ? 'invalid'
                : 'failed';
        if (!isAutoProbe) {
            if (desiredUsername === username) scheduleReconnect(username);
        }
        return { ok: false, attempt, reason };
    } finally {
        if (previousWsTimeout === undefined) delete process.env.WS_CONNECT_TIMEOUT_MS;
        else process.env.WS_CONNECT_TIMEOUT_MS = previousWsTimeout;
    }
}

async function handleClientMessage(ws, message) {
    if (message.type === 'ping') {
        return send(ws, { type: 'pong', timestamp: Date.now() });
    }

    if (message.type === 'register') {
        if (ws.registered) return send(ws, { type: 'error', message: 'Client đã đăng ký quyền.' });
        if (message.role !== 'control' && message.role !== 'overlay') {
            return send(ws, { type: 'error', message: 'Vai trò client không hợp lệ.' });
        }
        ws.role = message.role;
        ws.registered = true;
        send(ws, { type: 'config', game: gameConfig, gifts: giftConfig });
        send(ws, { type: 'status', ...connectionStatus });
        send(ws, { type: 'metrics', ...metrics, players: sessionPlayers.size, eventsPerSecond: currentEventRate() });
        if (ws.role === 'control') {
            send(ws, { type: 'master_config', master: masterConfig });
            send(ws, { type: 'operator_config', operator: publicOperatorConfig() });
            send(ws, giftCatalogMessage());
            send(ws, { type: 'recent_events', events: recentEvents });
            send(ws, { type: 'obs_status', ...obsClient.getStatus() });
            send(ws, systemStatusMessage());
        }
        if (ws.role === 'overlay') {
            send(ws, createSnapshot());
            send(ws, viewerGuideMessage());
            // Đồng bộ cài đặt media để game áp đúng ngay khi mở, không phải đợi thao tác.
            const media = operatorConfig.media || {};
            send(ws, { type: 'game_control', command: 'welcome_enabled', boolValue: media.welcomeEnabled !== false });
            send(ws, { type: 'game_control', command: 'welcome_volume', floatValue: Number(media.welcomeVolume ?? 0.6) });
            send(ws, { type: 'game_control', command: 'welcome_greeting', stringValue: String(media.welcomeGreeting ?? 'Chào mừng {ten}') });
            send(ws, { type: 'game_control', command: 'welcome_interval', floatValue: Number(media.welcomeInterval ?? 4) });
            send(ws, { type: 'game_control', command: 'welcome_lang', stringValue: String(media.welcomeLang ?? 'vi') });
            send(ws, { type: 'game_control', command: 'logo_enabled', boolValue: media.logoEnabled !== false });
            send(ws, { type: 'game_control', command: 'logo_scale', floatValue: Number(media.logoScale ?? 0.18) });
            send(ws, { type: 'game_control', command: 'logo_opacity', floatValue: Number(media.logoOpacity ?? 1) });
            broadcastSystemStatus();
        }
        return;
    }

    if (!ws.registered) return send(ws, { type: 'error', message: 'Client chưa đăng ký quyền.' });

    const controlOnly = new Set([
        'master_save', 'master_test', 'operator_save', 'media_settings', 'game_control',
        'euler_key_save',
        'obs_connect', 'obs_disconnect', 'obs_refresh', 'obs_set_scene',
        'obs_get_sources', 'obs_set_source_visibility', 'obs_capture_game', 'obs_audio_check'
    ]).has(message.type);
    const operatorOnly = new Set([
        'set_username', 'disconnect_tiktok', 'demo_start', 'demo_stop', 'demo_event', 'reset_game'
    ]).has(message.type);
    if (controlOnly && ws.role !== 'control') {
        return send(ws, { type: 'error', message: 'Lệnh này chỉ dành cho Control Panel.' });
    }

    // Mọi lệnh vận hành đều là chức năng tính phí. Kiểm tra ở server, không tin giao diện.
    if ((controlOnly || operatorOnly) && !licenseCore.licenseStatus().active) {
        return send(ws, {
            type: 'license_required',
            message: 'Cần kích hoạt bản quyền để dùng chức năng này. Hãy gửi mã và liên hệ người bán.'
        });
    }
    if (operatorOnly && ws.role !== 'control' && !ws.nativeClient) {
        return send(ws, { type: 'error', message: 'Client không có quyền điều khiển.' });
    }

    if (message.type === 'master_save') {
        masterConfig = sanitizeMasterConfig(message.master);
        await writeJsonAtomic(masterConfigPath, masterConfig);
        broadcast({ type: 'master_config', master: masterConfig });
        broadcast(viewerGuideMessage());
        return send(ws, { type: 'master_saved', message: 'Đã lưu và áp dụng Master.' });
    }


    if (message.type === 'operator_save') {
        // Ô Operator.json không hiển thị mật khẩu/khoá, nên gửi lên rỗng nghĩa là "giữ nguyên".
        const incoming = message.operator || {};
        const keepPassword = !String(incoming.obs?.password || '').trim();
        const keepEuler = !String(incoming.eulerApiKey || '').trim();
        operatorConfig = sanitizeOperatorConfig({
            ...incoming,
            eulerApiKey: keepEuler ? (operatorConfig.eulerApiKey || '') : incoming.eulerApiKey,
            obs: {
                ...(incoming.obs || {}),
                password: keepPassword ? (operatorConfig.obs?.password || '') : incoming.obs.password
            }
        });
        await writeJsonAtomic(operatorConfigPath, operatorConfig);
        broadcastRole('control', { type: 'operator_config', operator: publicOperatorConfig() });
        broadcastMetrics();
        return send(ws, { type: 'operator_saved', message: 'Đã lưu cấu hình vận hành.' });
    }

    // Lưu/xoá khoá ký EulerStream (dán key từ Control Panel). Rỗng + clear=true để xoá.
    if (message.type === 'euler_key_save') {
        const incoming = String(message.eulerApiKey || '').trim();
        const nextKey = message.clear === true ? '' : (incoming || operatorConfig.eulerApiKey || '');
        operatorConfig = sanitizeOperatorConfig({ ...operatorConfig, eulerApiKey: nextKey });
        await writeJsonAtomic(operatorConfigPath, operatorConfig);
        broadcastRole('control', { type: 'operator_config', operator: publicOperatorConfig() });
        return send(ws, {
            type: 'operator_saved',
            message: nextKey ? 'Đã lưu EulerStream key.' : 'Đã xoá EulerStream key.'
        });
    }

    if (message.type === 'media_settings') {
        const media = { ...operatorConfig.media };
        const overlayCommands = [];
        let message_text = 'Đã lưu cài đặt media.';

        if (message.musicVolume !== undefined) {
            const volume = Math.max(0, Math.min(1, Number(message.musicVolume)));
            media.musicVolume = Number.isFinite(volume) ? volume : 0.35;
            await fs.mkdir(djMusicDir, { recursive: true });
            await fs.writeFile(musicVolumePath, String(media.musicVolume), 'utf8');
            overlayCommands.push({ command: 'music_volume', floatValue: media.musicVolume });
            message_text = 'Đã lưu âm lượng nền.';
        }
        if (message.welcomeEnabled !== undefined) {
            media.welcomeEnabled = Boolean(message.welcomeEnabled);
            overlayCommands.push({ command: 'welcome_enabled', boolValue: media.welcomeEnabled });
            message_text = 'Đã lưu cài đặt âm thanh chào.';
        }
        if (message.welcomeVolume !== undefined) {
            const wv = Math.max(0, Math.min(1, Number(message.welcomeVolume)));
            media.welcomeVolume = Number.isFinite(wv) ? wv : 0.6;
            overlayCommands.push({ command: 'welcome_volume', floatValue: media.welcomeVolume });
            message_text = 'Đã lưu cài đặt âm thanh chào.';
        }
        if (message.welcomeFile !== undefined) {
            const requested = path.basename(String(message.welcomeFile || '')).trim();
            let ok = false;
            if (requested && ['.wav', '.mp3', '.ogg'].includes(path.extname(requested).toLowerCase())) {
                try { await fs.access(path.join(djSfxDir, requested)); ok = true; } catch { ok = false; }
            }
            if (ok) {
                media.welcomeFile = requested;
                await fs.mkdir(djSfxDir, { recursive: true });
                await fs.writeFile(welcomeSelectedPath, requested, 'utf8');
                overlayCommands.push({ command: 'welcome_reload', boolValue: true });
                message_text = 'Đã áp dụng âm thanh chào.';
            }
        }
        if (message.welcomeLang !== undefined) {
            const lang = String(message.welcomeLang || 'vi').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 8) || 'vi';
            media.welcomeLang = lang;
            overlayCommands.push({ command: 'welcome_lang', stringValue: lang });
            message_text = 'Đã áp dụng âm thanh chào.';
        }
        if (message.welcomeGreeting !== undefined) {
            media.welcomeGreeting = String(message.welcomeGreeting).slice(0, 120) || 'Chào mừng {ten}';
            overlayCommands.push({ command: 'welcome_greeting', stringValue: media.welcomeGreeting });
            message_text = 'Đã lưu cài đặt âm thanh chào.';
        }
        if (message.welcomeInterval !== undefined) {
            const iv = Math.max(1, Math.min(30, Number(message.welcomeInterval)));
            media.welcomeInterval = Number.isFinite(iv) ? iv : 4;
            overlayCommands.push({ command: 'welcome_interval', floatValue: media.welcomeInterval });
            message_text = 'Đã lưu cài đặt âm thanh chào.';
        }
        if (message.logoEnabled !== undefined) {
            media.logoEnabled = Boolean(message.logoEnabled);
            overlayCommands.push({ command: 'logo_enabled', boolValue: media.logoEnabled });
            message_text = 'Đã lưu cài đặt logo.';
        }
        if (message.logoScale !== undefined) {
            const ls = Math.max(0.05, Math.min(0.6, Number(message.logoScale)));
            media.logoScale = Number.isFinite(ls) ? ls : 0.18;
            overlayCommands.push({ command: 'logo_scale', floatValue: media.logoScale });
            message_text = 'Đã lưu cài đặt logo.';
        }
        if (message.logoOpacity !== undefined) {
            const lo = Math.max(0, Math.min(1, Number(message.logoOpacity)));
            media.logoOpacity = Number.isFinite(lo) ? lo : 1;
            overlayCommands.push({ command: 'logo_opacity', floatValue: media.logoOpacity });
            message_text = 'Đã lưu cài đặt logo.';
        }

        operatorConfig = sanitizeOperatorConfig({ ...operatorConfig, media });
        await writeJsonAtomic(operatorConfigPath, operatorConfig);
        broadcastRole('control', { type: 'operator_config', operator: publicOperatorConfig() });
        for (const cmd of overlayCommands) {
            broadcastRole('overlay', { type: 'game_control', ...cmd });
        }
        return send(ws, { type: 'operator_saved', message: message_text });
    }

    if (message.type === 'game_control') {
        const allowedCommands = new Set(['chroma', 'hud', 'feed', 'controls', 'fullscreen', 'background_reload', 'music_reload', 'music_volume', 'welcome_reload', 'welcome_enabled', 'welcome_volume', 'welcome_greeting', 'welcome_interval', 'welcome_lang', 'logo_reload', 'logo_enabled', 'logo_scale', 'logo_opacity', 'reset']);
        const command = String(message.command || '');
        if (!allowedCommands.has(command)) {
            return send(ws, { type: 'error', message: 'Lệnh điều khiển game không hợp lệ.' });
        }
        if (command === 'reset') {
            const source = metrics.source;
            const startedAt = metrics.startedAt;
            resetSessionState(source);
            metrics.startedAt = startedAt;
            broadcast({ type: 'reset' });
            broadcastMetrics();
            return send(ws, { type: 'game_control_ack', command });
        }
        broadcastRole('overlay', {
            type: 'game_control',
            command,
            boolValue: Boolean(message.value),
            floatValue: Number.isFinite(Number(message.value)) ? Number(message.value) : 0
        });
        return send(ws, { type: 'game_control_ack', command, value: message.value });
    }

    if (message.type === 'game_telemetry') {
        if (ws.role !== 'overlay') return send(ws, { type: 'error', message: 'Telemetry chỉ nhận từ Unity.' });
        gameTelemetry = {
            fps: Math.max(0, Math.min(500, Number(message.fps) || 0)),
            queueCount: Math.max(0, Math.min(100000, Number(message.queueCount) || 0)),
            playerCount: Math.max(0, Math.min(10000, Number(message.playerCount) || 0)),
            droppedMessages: Math.max(0, Math.min(1000000, Number(message.droppedMessages) || 0)),
            chroma: Boolean(message.chroma),
            hud: Boolean(message.hud),
            feed: Boolean(message.feed),
            controls: Boolean(message.controls),
            fullscreen: Boolean(message.fullscreen),
            updatedAt: Date.now()
        };
        broadcastRole('control', { type: 'game_telemetry', ...gameTelemetry });
        return;
    }

    if (message.type === 'obs_connect') {
        const endpoint = sanitizeObsEndpoint({ host: message.host, port: message.port });
        const password = String(message.password ?? operatorConfig.obs?.password ?? '');
        const autoConnect = message.autoConnect !== false;
        operatorConfig = sanitizeOperatorConfig({ ...operatorConfig, obs: { ...endpoint, password, autoConnect } });
        await writeJsonAtomic(operatorConfigPath, operatorConfig);
        broadcastRole('control', { type: 'operator_config', operator: publicOperatorConfig() });
        try {
            await obsClient.connect({ ...endpoint, password });
            return send(ws, { type: 'obs_action', ok: true, message: 'Đã kết nối OBS.' });
        } catch (error) {
            return send(ws, { type: 'obs_action', ok: false, message: obsClient.getStatus().message || error.message });
        }
    }

    if (message.type === 'obs_disconnect') {
        await obsClient.disconnect();
        return send(ws, { type: 'obs_action', ok: true, message: 'Đã ngắt OBS.' });
    }

    if (message.type === 'obs_refresh') {
        try {
            await obsClient.refresh();
            return send(ws, { type: 'obs_action', ok: true, message: 'Đã làm mới OBS.' });
        } catch (error) {
            return send(ws, { type: 'obs_action', ok: false, message: error.message });
        }
    }

    if (message.type === 'obs_set_scene') {
        try {
            await obsClient.setCurrentScene(message.sceneName);
            return send(ws, { type: 'obs_action', ok: true, message: `Đã chuyển scene ${message.sceneName}.` });
        } catch (error) {
            return send(ws, { type: 'obs_action', ok: false, message: error.message });
        }
    }

    if (message.type === 'obs_get_sources') {
        try {
            await obsClient.loadSources(message.sceneName);
            return send(ws, { type: 'obs_action', ok: true, message: 'Đã tải danh sách source.' });
        } catch (error) {
            return send(ws, { type: 'obs_action', ok: false, message: error.message });
        }
    }

    if (message.type === 'obs_set_source_visibility') {
        try {
            await obsClient.setSourceVisibility(message.sceneName, Number(message.sceneItemId), Boolean(message.enabled));
            return send(ws, { type: 'obs_action', ok: true, message: 'Đã cập nhật source OBS.' });
        } catch (error) {
            return send(ws, { type: 'obs_action', ok: false, message: error.message });
        }
    }

    if (message.type === 'obs_audio_check') {
        try {
            const report = await obsClient.audioCheck({ durationMs: message.durationMs });
            return send(ws, { type: 'obs_audio_report', ok: true, report });
        } catch (error) {
            return send(ws, { type: 'obs_audio_report', ok: false, message: error.message });
        }
    }

    if (message.type === 'obs_capture_game') {
        try {
            const result = await obsClient.ensureGameSource({
                sceneName: message.sceneName,
                sourceName: message.sourceName,
                windowTitle: message.windowTitle,
                executable: message.executable,
                mode: message.mode
            });
            const layout = result.layout;
            const fitNote = layout
                ? ` · khớp khung ${layout.canvasWidth}×${layout.canvasHeight}`
                    + (layout.sourceWidth ? ` (nguồn ${layout.sourceWidth}×${layout.sourceHeight})` : '')
                : '';
            return send(ws, {
                type: 'obs_action',
                ok: true,
                message: `Đã đưa TISO vào OBS (${result.mode}) · scene ${result.sceneName}${fitNote}.`,
                layout
            });
        } catch (error) {
            return send(ws, { type: 'obs_action', ok: false, message: `Không tạo được nguồn hình TISO: ${error.message}` });
        }
    }

    if (message.type === 'master_test') {
        const rule = masterConfig.rules.find(item => item.id === message.ruleId && item.enabled);
        if (!rule) return send(ws, { type: 'error', message: 'Không tìm thấy luật Master để test.' });
        const user = { userId: 'master-test', uniqueId: 'master_test', nickname: 'Master Test', avatar: '' };
        if (rule.source === 'chat') {
            return processGameEvent({
                type: 'chat',
                eventId: `master-test-${Date.now()}`,
                ...user,
                comment: rule.trigger.split(',')[0].trim()
            });
        }
        return processGameEvent({
            type: 'gift',
            eventId: `master-test-${Date.now()}`,
            ...user,
            giftId: rule.giftId || `master-${rule.id}`,
            giftName: rule.trigger.split(',')[0].trim() || 'Master Gift',
            repeatCount: 1,
            diamondCount: Math.max(1, Number(message.diamonds) || 1)
        });
    }

    if (message.type === 'set_username') {
        const username = normalizeUsername(message.username);
        if (!username) {
            return send(ws, {
                type: 'error',
                message: 'Username không hợp lệ hoặc link không phải TikTok LIVE.'
            });
        }
        return connectToLiveProvider(username, { provider: message.provider });
    }

    if (message.type === 'disconnect_tiktok') {
        desiredUsername = null;
        reconnectFailures = 0;
        cancelReconnect();
        connectionAttempt += 1;
        await disconnectCurrentConnection();
        setStatus('idle', null, 'Đã ngắt kết nối');
        return;
    }

    if (message.type === 'demo_start') {
        desiredUsername = null;
        reconnectFailures = 0;
        cancelReconnect();
        connectionAttempt += 1;
        await disconnectCurrentConnection();
        const count = Math.min(gameConfig.maxPlayers, Math.max(1, Number(message.count) || 20));
        return startDemo(count);
    }
    if (message.type === 'demo_stop') {
        stopDemo();
        setStatus('idle', null, 'Đã dừng demo');
        return;
    }
    if (message.type === 'demo_event') {
        return emitDemoAction(
            String(message.action || 'dance'),
            Math.max(1, Number(message.userIndex) || 1),
            Math.max(1, Number(message.value) || 1),
            String(message.giftName || ''),
            message.manualUsername || null
        );
    }
    if (message.type === 'reset_game') {
        const source = metrics.source;
        const startedAt = metrics.startedAt;
        resetSessionState(source);
        metrics.startedAt = startedAt;
        broadcast({ type: 'reset' });
        broadcastMetrics();
        return;
    }

    send(ws, { type: 'error', message: 'Lệnh không được hỗ trợ.' });
}

function rejectUpgrade(socket, status = '403 Forbidden') {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

server.on('upgrade', (request, socket, head) => {
    const remoteAddress = request.socket.remoteAddress;
    const origin = request.headers.origin || '';
    if ((!ALLOW_LAN && !isLoopbackAddress(remoteAddress)) ||
        !isAllowedHost(request.headers.host, PORT, ALLOW_LAN) ||
        !isAllowedOrigin(origin, PORT)) {
        return rejectUpgrade(socket);
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});

wss.on('connection', (ws, request) => {
    ws.registered = false;
    ws.role = null;
    ws.nativeClient = !request.headers.origin && isLoopbackAddress(request.socket.remoteAddress);
    ws.rateLimit = { windowStartedAt: Date.now(), count: 0 };
    ws.invalidMessages = 0;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, { type: 'status', ...connectionStatus });
    ws.on('message', (rawMessage, isBinary) => {
        if (isBinary) return ws.close(1003, 'Text messages only');
        if (!consumeRateLimit(ws.rateLimit)) return ws.close(1008, 'Rate limit exceeded');
        let message;
        try {
            message = JSON.parse(rawMessage.toString());
        } catch {
            ws.invalidMessages += 1;
            if (ws.invalidMessages >= 3) return ws.close(1008, 'Invalid messages');
            return send(ws, { type: 'error', message: 'Dữ liệu không hợp lệ' });
        }
        if (!message || typeof message !== 'object' || Array.isArray(message) ||
            typeof message.type !== 'string' || message.type.length > 40) {
            return send(ws, { type: 'error', message: 'Cấu trúc lệnh không hợp lệ.' });
        }
        void handleClientMessage(ws, message).catch(error => {
            console.error('Không thể xử lý lệnh WebSocket:', error?.message || error);
            send(ws, { type: 'error', message: 'Không thể xử lý lệnh.' });
        });
    });
    ws.on('error', error => console.warn('WebSocket client error:', error.message));
    ws.on('close', () => {
        if (ws.role === 'overlay') broadcastSystemStatus();
    });
});

const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);
heartbeatTimer.unref();

const dashboardTimer = setInterval(() => {
    broadcastMetrics();
    broadcastSystemStatus();
}, 1000);
dashboardTimer.unref();

server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 64;

server.listen(PORT, HOST, () => {
    console.log(`TikTok Live Game: http://${HOST}:${PORT}`);
    console.log(`Bảng điều khiển: http://${HOST}:${PORT}/control.html`);
    fs.mkdir(djMusicDir, { recursive: true })
        .then(() => fs.writeFile(musicVolumePath, String(operatorConfig.media?.musicVolume ?? 0.35), 'utf8'))
        .catch(error => console.warn(`[MUSIC] Không thể đồng bộ volume: ${error.message}`));
    if (operatorConfig.obs?.autoConnect) {
        setTimeout(() => {
            const endpoint = sanitizeObsEndpoint(operatorConfig.obs || {});
            obsClient.connect({ ...endpoint, password: String(operatorConfig.obs?.password || '') })
                .catch(error => console.warn(`[OBS] Auto-connect: ${error.message}`));
        }, 1200).unref?.();
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Lỗi: Cổng ${PORT} đang bị chương trình khác chiếm.`);
        console.error(`   Có thể bạn đã chạy server trước đó mà chưa tắt.\n`);
        console.error(`   Cách khắc phục:`);
        console.error(`   1. Tắt cửa sổ cmd/terminal cũ đang chạy server`);
        console.error(`   2. Hoặc chạy lệnh: npx kill-port ${PORT}`);
        console.error(`   3. Nếu chỉ dùng Control Panel, có thể đổi PORT trong file .env.`);
        console.error(`      Bản game đọc PORT tự động khi chạy qua run.bat.\n`);
        process.exit(1);
    } else {
        console.error('Lỗi server:', err);
        process.exit(1);
    }
});

async function shutdown() {
    stopDemo();
    clearInterval(heartbeatTimer);
    desiredUsername = null;
    cancelReconnect();
    connectionAttempt += 1;
    await disconnectCurrentConnection();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
