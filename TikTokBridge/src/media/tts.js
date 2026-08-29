'use strict';

// Tổng hợp giọng đọc chào khách bằng API TTS tiếng Việt (Google Translate TTS,
// không cần API key). Kết quả được cache ra đĩa theo nội dung để lần sau tức thì.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TEXT = 180; // endpoint tw-ob cắt câu quá dài, lời chào luôn ngắn.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let cacheDir = null;

function configure(dir) {
    cacheDir = dir;
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* bỏ qua */ }
}

// Loại ký tự điều khiển, gộp khoảng trắng, cắt độ dài an toàn cho URL/endpoint.
function sanitizeText(input) {
    const text = String(input || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.slice(0, MAX_TEXT);
}

function normalizeLang(input) {
    const lang = String(input || 'vi').toLowerCase().replace(/[^a-z-]/g, '');
    return lang.slice(0, 8) || 'vi';
}

function cachePath(lang, text) {
    const key = crypto.createHash('sha1').update(`${lang}|${text}`).digest('hex');
    return path.join(cacheDir || '.', `${key}.mp3`);
}

function buildUrl(lang, text) {
    const q = encodeURIComponent(text);
    return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${q}`;
}

// Trả về Buffer MP3 cho câu chào. Ném lỗi nếu văn bản rỗng hoặc API thất bại.
async function synthesize(rawText, rawLang) {
    const text = sanitizeText(rawText);
    if (!text) throw new Error('Nội dung đọc rỗng.');
    const lang = normalizeLang(rawLang);

    if (cacheDir) {
        const file = cachePath(lang, text);
        try {
            const cached = await fs.promises.readFile(file);
            if (cached.length > 0) return cached;
        } catch { /* chưa có cache */ }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
        response = await fetch(buildUrl(lang, text), {
            headers: { 'User-Agent': USER_AGENT, Referer: 'https://translate.google.com/' },
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`TTS trả về HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('TTS trả về dữ liệu rỗng.');

    if (cacheDir) {
        const file = cachePath(lang, text);
        try {
            const tmp = `${file}.tmp`;
            await fs.promises.writeFile(tmp, buffer);
            await fs.promises.rename(tmp, file);
        } catch { /* cache không ghi được thì thôi */ }
    }
    return buffer;
}

module.exports = { configure, synthesize, sanitizeText, normalizeLang, MAX_TEXT };
