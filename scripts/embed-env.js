'use strict';

// Nhúng nội dung .env vào module embedded-env.js cho bản đóng gói.
// Chạy: node scripts/embed-env.js <thu-muc-goi>
// Sau khi nhúng, file .env không được đi kèm gói (package.bat đã loại trừ).

const fs = require('node:fs');
const path = require('node:path');

const stageDir = process.argv[2];
if (!stageDir) {
    console.error('[LOI] Thieu duong dan thu muc goi.');
    process.exit(1);
}

const repoRoot = path.join(__dirname, '..');
const sourceEnv = path.join(repoRoot, 'TikTokBridge', '.env');
const { encryptEnv } = require(path.join(repoRoot, 'TikTokBridge', 'src', 'license', 'secure-env'));

if (!fs.existsSync(sourceEnv)) {
    console.error('[LOI] Khong tim thay TikTokBridge/.env de nhung vao goi.');
    process.exit(1);
}

const plain = fs.readFileSync(sourceEnv, 'utf8');
if (!/^\s*SECRET_KEY\s*=\s*\S+/m.test(plain)) {
    console.error('[LOI] .env chua co SECRET_KEY. Sinh moi bang:');
    console.error('      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
}

const { salt, iv, tag, blob } = encryptEnv(plain);
const target = path.join(stageDir, 'TikTokBridge', 'src', 'license', 'embedded-env.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `'use strict';

// Sinh tu dong boi scripts/embed-env.js — KHONG sua tay, KHONG commit len git.
// Noi dung .env da duoc ma hoa AES-256-GCM; sua mot byte la giai ma that bai.
module.exports = {
    SALT: '${salt}',
    IV: '${iv}',
    TAG: '${tag}',
    BLOB: '${blob}'
};
`, 'utf8');

// Bảo đảm gói không kèm .env dạng văn bản thường.
const stageEnv = path.join(stageDir, 'TikTokBridge', '.env');
if (fs.existsSync(stageEnv)) fs.rmSync(stageEnv, { force: true });

console.log('      Da nhung cau hinh ban quyen vao goi (khong kem file .env).');
