'use strict';

// Kiểm tra bản phát hành mới trên GitHub Releases và kích hoạt cập nhật.
// Việc tải/ghi đè do installer/install-tiso.ps1 làm, vì nó phải đóng chính Bridge
// đang chạy trước khi thay file.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = String(process.env.UPDATE_REPO || 'AnhTuan2003ml/tiktok-live-bar');
const CHECK_TIMEOUT_MS = 15000;
const appRoot = path.join(__dirname, '..', '..', '..');

let cache = { at: 0, data: null };

function currentVersion() {
    // VERSION.json do installer ghi ra là nguồn chính xác nhất; nếu chạy từ mã nguồn
    // thì lấy version trong package.json của Bridge.
    try {
        const info = JSON.parse(fs.readFileSync(path.join(appRoot, 'VERSION.json'), 'utf8'));
        if (info.tag) return String(info.tag);
    } catch {
        // Không sao, rơi xuống package.json.
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        return `v${pkg.version}`;
    } catch {
        return 'v0.0.0';
    }
}

// So sánh phiên bản kiểu semver, bỏ tiền tố v và phần hậu tố sau dấu -.
function compareVersions(left, right) {
    const parse = value => String(value || '')
        .replace(/^v/i, '')
        .split('-')[0]
        .split('.')
        .map(part => Number.parseInt(part, 10) || 0);

    const a = parse(left);
    const b = parse(right);
    const length = Math.max(a.length, b.length, 3);
    for (let index = 0; index < length; index += 1) {
        const diff = (a[index] || 0) - (b[index] || 0);
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}

async function fetchLatestRelease() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
        const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { 'User-Agent': 'TISO-Bridge', Accept: 'application/vnd.github+json' },
            signal: controller.signal
        });
        if (response.status === 404) {
            throw new Error('Chưa có bản phát hành công khai nào trên GitHub (bản Draft không tính).');
        }
        if (!response.ok) throw new Error(`GitHub trả về HTTP ${response.status}.`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function checkForUpdate({ force = false } = {}) {
    const current = currentVersion();

    // Nhớ kết quả 10 phút để không gọi GitHub liên tục khi Control Panel mở lâu.
    if (!force && cache.data && Date.now() - cache.at < 10 * 60 * 1000) {
        return { ...cache.data, current };
    }

    try {
        const release = await fetchLatestRelease();
        const asset = (release.assets || []).find(item => String(item.name || '').toLowerCase().endsWith('.zip'));
        const latest = String(release.tag_name || '');
        const data = {
            ok: true,
            current,
            latest,
            has_update: compareVersions(latest, current) > 0,
            published_at: release.published_at || '',
            notes: String(release.body || '').slice(0, 4000),
            html_url: release.html_url || '',
            asset_name: asset ? asset.name : '',
            asset_size: asset ? Number(asset.size) || 0 : 0,
            download_url: asset ? asset.browser_download_url : ''
        };
        cache = { at: Date.now(), data };
        return data;
    } catch (error) {
        return { ok: false, current, has_update: false, error: error.message };
    }
}

function updaterScriptPath() {
    return path.join(appRoot, 'installer', 'install-tiso.ps1');
}

// Chạy installer ở chế độ cập nhật rồi buông tay: script sẽ tự đóng Bridge và Game,
// ghi đè file mới và mở lại app.
function startUpdate() {
    const script = updaterScriptPath();
    if (!fs.existsSync(script)) {
        throw new Error('Không tìm thấy installer/install-tiso.ps1 trong thư mục cài đặt.');
    }

    const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-InstallDir', appRoot,
        '-Update', '-Silent', '-Launch'
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();

    return { ok: true, message: 'Đang tải bản mới. TISO sẽ tự đóng, cập nhật rồi mở lại — vui lòng chờ vài phút.' };
}

module.exports = { REPO, currentVersion, compareVersions, checkForUpdate, startUpdate, updaterScriptPath };
