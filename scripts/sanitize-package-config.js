'use strict';

// Xoa cac thiet lap rieng tu khoi goi mang sang may khac:
// mat khau OBS, dia chi LAN, danh sach gift/nguoi choi da quan sat cua phien cu.

const fs = require('node:fs');
const path = require('node:path');

const stageDir = process.argv[2];
if (!stageDir) {
    console.error('[LOI] Thieu duong dan thu muc goi.');
    process.exit(1);
}

const configDir = path.join(stageDir, 'TikTokBridge', 'config');

function rewriteJson(fileName, transform) {
    const filePath = path.join(configDir, fileName);
    if (!fs.existsSync(filePath)) return;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const next = transform(data);
        if (next === null) return;
        fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (error) {
        console.error(`[LOI] Khong xu ly duoc ${fileName}: ${error.message}`);
        process.exitCode = 1;
    }
}

rewriteJson('operator.json', config => ({
    ...config,
    // Khoa EulerStream gan voi tung may - moi may tu dan key rieng, khong di theo goi.
    eulerApiKey: '',
    obs: {
        ...(config.obs || {}),
        host: '127.0.0.1',
        port: Number(config.obs?.port) || 4455,
        password: '',
        autoConnect: config.obs?.autoConnect !== false
    }
}));

rewriteJson('observed-gifts.json', config => (Array.isArray(config) ? [] : {}));

// Trang thai ban quyen gan voi tung may - khong duoc di theo goi phat hanh.
for (const relative of [
    'TikTokBridge/config/.license.dat',
    'TikTokBridge/config/.activation.dat',
    'TikTokBridge/server.log',
    'build_log.txt'
]) {
    const target = path.join(stageDir, relative);
    if (!fs.existsSync(target)) continue;
    try {
        if (process.platform === 'win32') {
            // File license duoc dat thuoc tinh an/he thong, phai go truoc khi xoa.
            require('node:child_process').execFileSync('attrib', ['-h', '-s', target], { windowsHide: true });
        }
    } catch {
        // Khong go duoc thuoc tinh thi van thu xoa.
    }
    fs.rmSync(target, { force: true });
}

console.log('      Da xoa mat khau OBS va du lieu phien cu khoi goi.');
