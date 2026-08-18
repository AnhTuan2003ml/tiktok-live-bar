'use strict';

// ============================================================
//  Nạp cấu hình nhạy cảm cho bản đóng gói.
//
//  Bản phát hành không kèm file .env. Nội dung .env được mã hoá AES-256-GCM và
//  nhúng vào module embedded-env; khoá giải mã không nằm nguyên khối ở đâu cả mà
//  được ghép lại lúc chạy từ nhiều mảnh rải rác, rồi đưa qua scrypt.
//  Module này còn được biên dịch sang bytecode V8 khi đóng gói nên không đọc hay
//  sửa bằng trình soạn thảo được.
//
//  Giới hạn cần biết: mọi lớp ở đây là làm-cho-khó, không phải bảo mật tuyệt đối.
//  Chương trình phải giải mã khoá ra bộ nhớ để dùng, nên người thạo dịch ngược
//  vẫn lấy được. Muốn chắc chắn thì khoá riêng không được rời máy người bán.
// ============================================================

const crypto = require('node:crypto');
const path = require('node:path');
const { parseEnvironment, loadEnvironmentFile } = require('../config/environment');

const APP_TAG = 'TISO';

// Các mảnh khoá cố ý để rời nhau và trộn cùng dữ liệu vô hại.
const FRAGMENT_A = [0x54, 0x49, 0x53, 0x4f, 0x2d, 0x6c, 0x69, 0x63];
const NOISE_ONE = 'club-lighting-bpm-128';
const FRAGMENT_B = 'ZW5zZS12MS1zdHJlYW0';
const NOISE_TWO = 'dj-booth-spotlight';
const FRAGMENT_C = [0x39, 0x2e, 0x6b, 0x65, 0x79, 0x2e, 0x76, 0x32];

const SENSITIVE_KEYS = [
    'SECRET_KEY',
    'LICENSE_SECRET',
    'LICENSE_PRIVATE_KEY',
    'LICENSE_PUBLIC_KEY',
    'LICENSE_STORAGE_DIR',
    'LICENSE_TEST_DURATION',
    'OTP_VALID_MINUTES',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
    'SENDMAIL_USER',
    'SENDMAIL_PASS',
    'RECEIVER_EMAIL_1',
    'RECEIVER_EMAIL_2',
    'RECIPIENT_EMAILS'
];

function assembleSeed() {
    return Buffer.concat([
        Buffer.from(FRAGMENT_A),
        Buffer.from(FRAGMENT_B, 'utf8'),
        Buffer.from(FRAGMENT_C),
        Buffer.from(`${APP_TAG}${NOISE_ONE.length}${NOISE_TWO.length}`, 'utf8')
    ]);
}

function deriveKey(salt) {
    return crypto.scryptSync(assembleSeed(), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encryptEnv(plainText) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
    const blob = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
    return {
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        blob: blob.toString('base64')
    };
}

function decryptEnv({ salt, iv, tag, blob }) {
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        deriveKey(Buffer.from(String(salt), 'base64')),
        Buffer.from(String(iv), 'base64')
    );
    // GCM tự bác bỏ dữ liệu bị sửa: đổi một byte trong blob là giải mã thất bại.
    decipher.setAuthTag(Buffer.from(String(tag), 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(String(blob), 'base64')),
        decipher.final()
    ]).toString('utf8');
}

function readEmbedded() {
    try {
        // eslint-disable-next-line global-require
        return require('./embedded-env');
    } catch {
        return null;
    }
}

// Trả 'embedded' nếu chạy bản đóng gói, 'file' nếu chạy từ mã nguồn.
function loadSecureEnvironment(environment = process.env) {
    const embedded = readEmbedded();
    if (embedded && embedded.SALT && embedded.BLOB && embedded.IV && embedded.TAG) {
        for (const key of SENSITIVE_KEYS) delete environment[key];
        let parsed;
        try {
            parsed = parseEnvironment(decryptEnv({
                salt: embedded.SALT, iv: embedded.IV, tag: embedded.TAG, blob: embedded.BLOB
            }));
        } catch {
            throw new Error('Cấu hình bản quyền trong bản cài đặt đã bị sửa đổi. Hãy cài lại từ bản phát hành chính thức.');
        }
        for (const [key, value] of Object.entries(parsed)) {
            if (SENSITIVE_KEYS.includes(key) || environment[key] === undefined) {
                environment[key] = value;   // bản nhúng luôn thắng
            }
        }
        return 'embedded';
    }

    loadEnvironmentFile(path.join(__dirname, '..', '..', '.env'), environment);
    return 'file';
}

module.exports = {
    APP_TAG,
    SENSITIVE_KEYS,
    encryptEnv,
    decryptEnv,
    loadSecureEnvironment
};
