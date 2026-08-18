'use strict';

// ============================================================
//  Bản quyền TISO — mã kích hoạt 12 ký tự, gắn từng máy (HMAC).
//
//  Máy khách sinh OTP 12 ký tự (ngẫu nhiên), CHỈ lưu hash và gửi OTP tới hộp thư
//  người bán qua email — không hiển thị cho khách. Người bán thu tiền rồi đọc mã cho
//  khách. Mã chỉ hợp lệ trên đúng máy đã sinh ra nó và hết hạn sau vài phút.
//
//  Lưu ý bảo mật: khoá bí mật (SECRET_KEY) nằm trên máy khách (đã mã hoá + bytecode).
//  Đây là obfuscation, không tuyệt đối — người thạo dịch ngược vẫn có thể tự tạo mã.
// ============================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP_TAG = 'TISO';
const KEY_LEN = 12;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 ký tự, bỏ I O 0 1 cho khỏi đọc nhầm

const DURATIONS = new Map([
    [1, { label: '1 tháng', seconds: 30 * 86400 }],
    [2, { label: '3 tháng', seconds: 90 * 86400 }],
    [3, { label: '6 tháng', seconds: 180 * 86400 }],
    [4, { label: 'Vĩnh viễn', seconds: 0 }],
    [5, { label: '7 ngày', seconds: 7 * 86400 }],
    [6, { label: '2 tháng', seconds: 60 * 86400 }]
]);

if (String(process.env.LICENSE_TEST_DURATION || '') === '1') {
    DURATIONS.set(0, { label: '5 phút', seconds: 5 * 60 });
}

const storageDir = process.env.LICENSE_STORAGE_DIR
    ? path.resolve(process.env.LICENSE_STORAGE_DIR)
    : path.join(__dirname, '..', '..', 'config');
const LICENSE_FILE = path.join(storageDir, '.license.dat');
const CHALLENGE_FILE = path.join(storageDir, '.activation.dat');

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function secretKey() {
    return String(process.env.SECRET_KEY || process.env.LICENSE_SECRET || '').trim();
}

function otpValidMinutes() {
    const value = Number(process.env.OTP_VALID_MINUTES);
    return Number.isFinite(value) && value > 0 ? value : 5;
}

// ---------- Chuẩn hoá & định dạng mã ----------

function normalizeKey(raw) {
    const upper = String(raw || '').toUpperCase();
    let result = '';
    for (const char of upper) {
        if (!/[A-Z0-9]/.test(char)) continue;
        if (char === 'I' || char === '1') result += 'J';
        else if (char === 'O' || char === '0') result += 'P';
        else result += char;
    }
    return result;
}

function formatKey(key) {
    return (normalizeKey(key).match(/.{1,4}/g) || []).join('-');
}

// ---------- Định danh máy ----------

function machineMac() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) {
            if (entry.internal) continue;
            const mac = String(entry.mac || '').toUpperCase();
            if (mac && mac !== '00:00:00:00:00:00') return mac;
        }
    }
    return '00:00:00:00:00:00';
}

let cachedGuid = null;
function machineGuid() {
    if (cachedGuid !== null) return cachedGuid;
    cachedGuid = '';
    try {
        if (process.platform === 'win32') {
            const output = execFileSync('reg', [
                'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'
            ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            const match = output.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
            if (match) cachedGuid = match[1].trim();
        } else if (fs.existsSync('/etc/machine-id')) {
            cachedGuid = fs.readFileSync('/etc/machine-id', 'utf8').trim();
        }
    } catch {
        cachedGuid = '';
    }
    return cachedGuid;
}

function deviceName() {
    return String(process.env.COMPUTERNAME || os.hostname() || '').trim();
}

function machineId() {
    return `${machineMac()}|${machineGuid()}|${deviceName()}`;
}

// Mã máy để người bán phân biệt thiết bị (hiển thị, không bí mật).
function machineTag() {
    return crypto.createHash('sha256').update(`${APP_TAG}|${machineId()}`).digest('hex').slice(0, 16).toUpperCase();
}

// ---------- OTP ----------

function generateOtp() {
    let otp = '';
    for (let index = 0; index < KEY_LEN; index += 1) {
        otp += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    }
    return otp;
}

function otpHash(otp) {
    const material = `${normalizeKey(otp)}|${machineId()}`;
    return crypto.createHmac('sha256', secretKey()).update(material).digest('hex');
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ---------- File trạng thái có chữ ký, gắn máy ----------

function sign(body) {
    const material = `${JSON.stringify(body, Object.keys(body).sort())}|${machineId()}`;
    return crypto.createHmac('sha256', secretKey() || 'tiso-fallback').update(material).digest('hex');
}

function setFileAttributes(filePath, hidden) {
    if (process.platform !== 'win32') return;
    try {
        execFileSync('attrib', [hidden ? '+h' : '-h', hidden ? '+s' : '-s', filePath], {
            windowsHide: true, timeout: 5000, stdio: 'ignore'
        });
    } catch {
        // Không đặt được thuộc tính ẩn thì vẫn chạy — HMAC mới là lớp bảo vệ thật.
    }
}

function writeState(filePath, body) {
    const payload = { body, sig: sign(body) };
    const blob = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) setFileAttributes(filePath, false);
    fs.writeFileSync(filePath, blob, 'utf8');
    setFileAttributes(filePath, true);
}

function readState(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const payload = JSON.parse(Buffer.from(fs.readFileSync(filePath, 'utf8'), 'base64').toString('utf8'));
        if (!payload || typeof payload.body !== 'object' || typeof payload.sig !== 'string') return null;
        // Sai chữ ký = file bị sửa tay HOẶC bị chép từ máy khác sang.
        if (!safeEqual(payload.sig, sign(payload.body))) return null;
        return payload.body;
    } catch {
        return null;
    }
}

function removeState(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        setFileAttributes(filePath, false);
        fs.rmSync(filePath, { force: true });
    } catch {
        // Bỏ qua: lần đọc sau tự phát hiện.
    }
}

// ---------- Tạo yêu cầu kích hoạt ----------

function durationOptions() {
    const weight = seconds => (seconds === 0 ? Number.POSITIVE_INFINITY : seconds);
    return [...DURATIONS.entries()]
        .sort((left, right) => weight(left[1].seconds) - weight(right[1].seconds))
        .map(([code, item]) => ({ code, label: item.label, perpetual: item.seconds === 0 }));
}

// Sinh OTP cho gói đã chọn, lưu hash cục bộ. Trả OTP về CHỈ cho tầng gửi email.
function createActivationRequest(durationCode) {
    const code = Number(durationCode);
    if (!DURATIONS.has(code)) {
        throw new Error('Gói thời hạn không hợp lệ. Hãy chọn lại một gói trong danh sách.');
    }
    if (!secretKey()) {
        throw new Error('Chưa cấu hình SECRET_KEY. Hãy kiểm tra file .env của Bridge rồi chạy lại.');
    }

    const otp = generateOtp();
    const now = nowSeconds();
    writeState(CHALLENGE_FILE, {
        otp_hash: otpHash(otp),
        duration_code: code,
        created_at: now,
        otp_expires_at: now + otpValidMinutes() * 60
    });

    // Giá trị otp KHÔNG được lọt vào HTTP response, log hay UI của khách — chỉ đi thẳng sang email.
    return { otp: formatKey(otp), label: DURATIONS.get(code).label };
}

// ---------- Kích hoạt ----------

function activate(rawKey) {
    const challenge = readState(CHALLENGE_FILE);
    if (!challenge) {
        return { ok: false, error: 'Chưa có yêu cầu kích hoạt nào. Hãy chọn gói và bấm "Gửi mã" trước.' };
    }

    const now = nowSeconds();
    if (now >= Number(challenge.otp_expires_at || 0)) {
        removeState(CHALLENGE_FILE);
        return { ok: false, error: 'Mã đã hết hạn. Hãy bấm "Gửi mã" để lấy mã mới.' };
    }

    if (!safeEqual(otpHash(rawKey), String(challenge.otp_hash || ''))) {
        return { ok: false, error: 'Mã kích hoạt không đúng. Hãy kiểm tra lại từng ký tự rồi nhập lại.' };
    }

    const duration = DURATIONS.get(Number(challenge.duration_code));
    if (!duration) {
        removeState(CHALLENGE_FILE);
        return { ok: false, error: 'Gói thời hạn trong yêu cầu không còn hợp lệ. Hãy gửi mã lại.' };
    }

    const expiresAt = duration.seconds === 0 ? 0 : now + duration.seconds;
    writeState(LICENSE_FILE, {
        duration_code: Number(challenge.duration_code),
        activated_at: now,
        expires_at: expiresAt,
        last_seen: now
    });
    removeState(CHALLENGE_FILE); // OTP dùng một lần

    return licenseStatus();
}

// ---------- Trạng thái, chống lùi đồng hồ ----------

function formatMoment(unixSeconds) {
    const date = new Date(unixSeconds * 1000);
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function formatRemaining(seconds) {
    if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} phút`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ`;
    return `${Math.floor(seconds / 86400)} ngày`;
}

function licenseStatus() {
    const state = readState(LICENSE_FILE);
    if (!state) {
        return {
            active: false,
            reason: 'none',
            message: 'Chưa kích hoạt bản quyền. Hãy chọn gói, bấm "Gửi mã" rồi liên hệ người bán để nhận mã.'
        };
    }

    let now = nowSeconds();
    const lastSeen = Number(state.last_seen || 0);
    if (now < lastSeen) {
        now = lastSeen;                       // đồng hồ bị chỉnh lùi: mốc chỉ được tiến
    } else if (now > lastSeen) {
        state.last_seen = now;
        writeState(LICENSE_FILE, state);
    }

    const durationCode = Number(state.duration_code);
    const label = DURATIONS.get(durationCode)?.label || 'Không rõ';
    const expiresAt = Number(state.expires_at || 0);

    if (expiresAt === 0) {
        return { active: true, perpetual: true, duration_code: durationCode, label, message: 'Đã kích hoạt · Vĩnh viễn.' };
    }

    if (now >= expiresAt) {
        return {
            active: false,
            reason: 'expired',
            duration_code: durationCode,
            label,
            expires_at: expiresAt,
            message: `Bản quyền đã hết hạn lúc ${formatMoment(expiresAt)}. Hãy gửi mã để gia hạn.`
        };
    }

    const remaining = expiresAt - now;
    return {
        active: true,
        perpetual: false,
        duration_code: durationCode,
        label,
        expires_at: expiresAt,
        remaining_seconds: remaining,
        message: `Đã kích hoạt · ${label} · còn ${formatRemaining(remaining)} (hết hạn ${formatMoment(expiresAt)}).`
    };
}

module.exports = {
    APP_TAG,
    KEY_LEN,
    ALPHABET,
    DURATIONS,
    LICENSE_FILE,
    CHALLENGE_FILE,
    normalizeKey,
    formatKey,
    machineMac,
    machineGuid,
    deviceName,
    machineId,
    machineTag,
    generateOtp,
    otpHash,
    otpValidMinutes,
    durationOptions,
    createActivationRequest,
    activate,
    licenseStatus,
    _internal: { readState, writeState, removeState, nowSeconds }
};
