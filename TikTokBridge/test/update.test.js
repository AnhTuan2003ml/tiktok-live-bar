'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const updater = require('../src/update/updater');

test('so sánh phiên bản theo semver, bỏ qua tiền tố v', () => {
    assert.equal(updater.compareVersions('v1.0.1', 'v1.0.0'), 1);
    assert.equal(updater.compareVersions('1.0.0', 'v1.0.0'), 0);
    assert.equal(updater.compareVersions('v0.9.9', 'v1.0.0'), -1);
    assert.equal(updater.compareVersions('v1.2', 'v1.10'), -1, '1.2 phải nhỏ hơn 1.10');
    assert.equal(updater.compareVersions('v2.0.0-beta', 'v2.0.0'), 0, 'hậu tố beta không đổi thứ tự');
    assert.equal(updater.compareVersions('', 'v1.0.0'), -1);
});

test('đọc được phiên bản đang chạy', () => {
    const version = updater.currentVersion();
    assert.match(version, /^v\d+\.\d+\.\d+/);
});

test('VERSION.json do installer ghi được ưu tiên hơn package.json', () => {
    const versionFile = path.join(__dirname, '..', '..', 'VERSION.json');
    const existed = fs.existsSync(versionFile);
    const backup = existed ? fs.readFileSync(versionFile, 'utf8') : null;

    fs.writeFileSync(versionFile, JSON.stringify({ tag: 'v9.9.9', installed_at: 'test' }), 'utf8');
    try {
        delete require.cache[require.resolve('../src/update/updater')];
        // eslint-disable-next-line global-require
        assert.equal(require('../src/update/updater').currentVersion(), 'v9.9.9');
    } finally {
        if (existed) fs.writeFileSync(versionFile, backup, 'utf8');
        else fs.rmSync(versionFile, { force: true });
        delete require.cache[require.resolve('../src/update/updater')];
    }
});

test('trình cài đặt/cập nhật có mặt và khai báo đủ các bước', () => {
    const script = updater.updaterScriptPath();
    assert.ok(fs.existsSync(script), 'phải có installer/install-tiso.ps1');

    const content = fs.readFileSync(script, 'utf8');
    for (const piece of [
        'FolderBrowserDialog',        // chọn thư mục cài
        'releases/latest',            // lấy bản mới nhất
        'Invoke-WebRequest',          // tải ZIP
        'Expand-Archive',             // giải nén
        'robocopy',                   // ghi đè
        'CreateShortcut',             // tạo shortcut run.bat
        'Stop-TisoProcesses'          // đóng app trước khi ghi đè
    ]) {
        assert.ok(content.includes(piece), `install-tiso.ps1 phải có bước: ${piece}`);
    }

    // Cập nhật không được xoá cấu hình, bản quyền và media của người dùng.
    for (const preserved of ['.env', 'operator.json', '.license.dat', 'DJ_MUSIC', 'LiveAssets']) {
        assert.ok(content.includes(preserved), `phải giữ lại: ${preserved}`);
    }
});

test('trình cài đặt Python cho chọn thư mục và tải bản mới nhất', () => {
    const py = fs.readFileSync(path.join(__dirname, '..', '..', 'installer', 'tiso_installer.py'), 'utf8');
    // Bản .exe web-installer được build từ file Python này.
    assert.match(py, /filedialog\.askdirectory/, 'phải cho người dùng chọn thư mục');
    assert.match(py, /releases\/latest/, 'phải hỏi GitHub bản mới nhất');
    assert.match(py, /zipfile\.ZipFile/, 'phải giải nén ZIP');
    assert.match(py, /run\.bat/, 'shortcut phải trỏ vào run.bat');

    // install-tiso.ps1 lo phan tu cap nhat trong app va giu lai cau hinh nguoi dung.
    const ps1 = fs.readFileSync(path.join(__dirname, '..', '..', 'installer', 'install-tiso.ps1'), 'utf8');
    assert.match(ps1, /releases\/latest/);
    assert.match(ps1, /Expand-Archive/);
    for (const preserved of ['.env', 'operator.json', '.license.dat', 'DJ_MUSIC', 'LiveAssets']) {
        assert.ok(ps1.includes(preserved), `cập nhật phải giữ lại: ${preserved}`);
    }
});

test('email kích hoạt có bản HTML dễ đọc và bản chữ thuần', () => {
    process.env.OTP_VALID_MINUTES = '5';
    const mailerPath = require.resolve('../src/license/mailer');
    delete require.cache[mailerPath];
    // eslint-disable-next-line global-require
    require('../src/license/mailer');

    // buildHtml không xuất khẩu nên kiểm tra qua nội dung nguồn.
    const source = fs.readFileSync(mailerPath, 'utf8');
    assert.match(source, /<!doctype html>/i, 'email phải là HTML hoàn chỉnh');
    assert.match(source, /Mã kích hoạt/);
    assert.match(source, /Tên thiết bị/);
    assert.match(source, /Địa chỉ MAC/);
    assert.match(source, /đối chiếu/i, 'phải nhắc người bán đối chiếu thiết bị');
    assert.match(source, /buildText/, 'vẫn phải có bản chữ thuần cho mail client cũ');
});
