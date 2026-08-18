'use strict';

// Bộ test cho cơ chế bản quyền OTP 12 ký tự, gắn từng máy (HMAC).
// Chạy trong thư mục tạm, không đụng license thật của máy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LICENSE_PATH = require.resolve('../src/license/license');
const SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tiso-license-test-'));

function freshLicense(env = {}) {
    process.env.LICENSE_STORAGE_DIR = SANDBOX_DIR;
    process.env.SECRET_KEY = env.SECRET_KEY ?? 'a'.repeat(64);
    process.env.OTP_VALID_MINUTES = env.OTP_VALID_MINUTES ?? '5';
    process.env.LICENSE_TEST_DURATION = env.LICENSE_TEST_DURATION ?? '1';
    delete require.cache[LICENSE_PATH];
    // eslint-disable-next-line global-require
    return require('../src/license/license');
}

function cleanState(license) {
    license._internal.removeState(license.LICENSE_FILE);
    license._internal.removeState(license.CHALLENGE_FILE);
}

test.beforeEach(() => cleanState(freshLicense()));
test.after(() => {
    cleanState(freshLicense());
    fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
    delete process.env.LICENSE_STORAGE_DIR;
});

test('kiểm thử chạy trong thư mục tạm, không chạm license thật', () => {
    assert.ok(freshLicense().LICENSE_FILE.startsWith(SANDBOX_DIR));
});

test('mã kích hoạt đúng 12 ký tự, ngẫu nhiên, không có ký tự dễ đọc nhầm', () => {
    const license = freshLicense();
    const first = license.generateOtp();
    assert.equal(first.length, license.KEY_LEN);
    assert.equal(license.KEY_LEN, 12);
    assert.notEqual(first, license.generateOtp());
    for (const banned of ['I', 'O', '0', '1']) {
        assert.ok(!license.ALPHABET.includes(banned), `không được dùng ký tự ${banned}`);
    }
});

test('chuẩn hoá sửa nhầm lẫn thị giác, định dạng nhóm 4', () => {
    const license = freshLicense();
    assert.equal(license.normalizeKey('ab-cd ef01'), 'ABCDEFPJ');
    assert.equal(license.normalizeKey('IOio'), 'JPJP');
    assert.equal(license.formatKey('ABCDEFGHJKLM'), 'ABCD-EFGH-JKLM');
});

test('1 · chưa kích hoạt thì trạng thái không active', () => {
    const status = freshLicense().licenseStatus();
    assert.equal(status.active, false);
    assert.equal(status.reason, 'none');
    assert.match(status.message, /Chưa kích hoạt/);
});

test('2 · tạo yêu cầu lưu hash, không lưu mã thô, mã 12 ký tự', () => {
    const license = freshLicense();
    const { otp, label } = license.createActivationRequest(1);
    assert.equal(label, '1 tháng');
    assert.equal(license.normalizeKey(otp).length, 12);

    const decoded = Buffer.from(fs.readFileSync(license.CHALLENGE_FILE, 'utf8'), 'base64').toString('utf8');
    assert.ok(!decoded.includes(license.normalizeKey(otp)), 'file challenge không được chứa mã thô');
    assert.match(decoded, /otp_hash/);
});

test('3 · nhập sai mã thì báo lỗi, challenge vẫn còn để thử lại', () => {
    const license = freshLicense();
    license.createActivationRequest(1);
    const result = license.activate('ZZZZ-ZZZZ-ZZZZ');
    assert.equal(result.ok, false);
    assert.match(result.error, /không đúng/);
    assert.ok(fs.existsSync(license.CHALLENGE_FILE), 'challenge phải còn');
});

test('4 · quá hạn OTP thì báo hết hạn và xoá challenge', () => {
    const license = freshLicense();
    const { otp } = license.createActivationRequest(1);
    const challenge = license._internal.readState(license.CHALLENGE_FILE);
    challenge.otp_expires_at = license._internal.nowSeconds() - 1;
    license._internal.writeState(license.CHALLENGE_FILE, challenge);

    const result = license.activate(otp);
    assert.equal(result.ok, false);
    assert.match(result.error, /hết hạn/);
    assert.equal(fs.existsSync(license.CHALLENGE_FILE), false, 'challenge hết hạn phải bị xoá');
});

test('5 · mã đúng kích hoạt được, dùng lại lần hai thất bại', () => {
    const license = freshLicense();
    const { otp } = license.createActivationRequest(1);
    const first = license.activate(otp);
    assert.equal(first.active, true);
    assert.equal(first.label, '1 tháng');
    assert.ok(first.remaining_seconds > 29 * 86400);
    assert.equal(fs.existsSync(license.CHALLENGE_FILE), false, 'OTP dùng một lần');
    assert.equal(license.activate(otp).ok, false, 'dùng lại phải thất bại');
});

test('5b · chấp nhận mã gõ thường, thiếu dấu gạch', () => {
    const license = freshLicense();
    const { otp } = license.createActivationRequest(2);
    const status = license.activate(` ${otp.replace(/-/g, '').toLowerCase()} `);
    assert.equal(status.active, true);
    assert.equal(status.label, '3 tháng');
});

test('6 · file license chép sang máy khác mất hiệu lực', () => {
    const license = freshLicense();
    license.activate(license.createActivationRequest(1).otp);
    assert.equal(license.licenseStatus().active, true);

    const original = process.env.COMPUTERNAME;
    process.env.COMPUTERNAME = `${original || os.hostname()}-MAY-KHAC`;
    try {
        assert.equal(freshLicense().licenseStatus().active, false, 'đổi máy là mất hiệu lực');
    } finally {
        if (original === undefined) delete process.env.COMPUTERNAME;
        else process.env.COMPUTERNAME = original;
    }
});

test('7 · sửa tay hạn dùng trong file làm hỏng chữ ký', () => {
    const license = freshLicense();
    license.activate(license.createActivationRequest(1).otp);

    const decoded = JSON.parse(Buffer.from(fs.readFileSync(license.LICENSE_FILE, 'utf8'), 'base64').toString('utf8'));
    decoded.body.expires_at = license._internal.nowSeconds() + 100 * 365 * 86400;
    if (process.platform === 'win32') {
        require('node:child_process').execFileSync('attrib', ['-h', '-s', license.LICENSE_FILE], { windowsHide: true });
    }
    fs.writeFileSync(license.LICENSE_FILE, Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64'), 'utf8');
    assert.equal(license.licenseStatus().active, false, 'sửa tay phải bị phát hiện');
});

test('8 · chỉnh đồng hồ lùi không kéo dài được thời hạn', () => {
    const license = freshLicense();
    const baseline = license.activate(license.createActivationRequest(1).otp).remaining_seconds;
    const state = license._internal.readState(license.LICENSE_FILE);
    state.last_seen = license._internal.nowSeconds() + 20 * 86400;
    license._internal.writeState(license.LICENSE_FILE, state);
    assert.ok(license.licenseStatus().remaining_seconds < baseline - 19 * 86400, 'mốc chỉ được tiến');
});

test('9 · gói vĩnh viễn không có hạn dùng', () => {
    const license = freshLicense();
    const status = license.activate(license.createActivationRequest(4).otp);
    assert.equal(status.active, true);
    assert.equal(status.perpetual, true);
    assert.match(status.message, /Vĩnh viễn/);
    assert.equal(license._internal.readState(license.LICENSE_FILE).expires_at, 0);
});

test('10 · gói hết hạn chuyển sang expired', () => {
    const license = freshLicense();
    license.activate(license.createActivationRequest(1).otp);
    const state = license._internal.readState(license.LICENSE_FILE);
    state.expires_at = license._internal.nowSeconds() - 10;
    license._internal.writeState(license.LICENSE_FILE, state);
    const status = license.licenseStatus();
    assert.equal(status.active, false);
    assert.equal(status.reason, 'expired');
});

test('11 · đủ 6 gói cho khách, sắp theo độ dài, vĩnh viễn cuối', () => {
    const license = freshLicense({ LICENSE_TEST_DURATION: '0' });
    const labels = license.durationOptions().map(o => o.label);
    assert.deepEqual(labels, ['7 ngày', '1 tháng', '2 tháng', '3 tháng', '6 tháng', 'Vĩnh viễn']);
    assert.equal(license.durationOptions().at(-1).perpetual, true);
});

test('12 · gói 7 ngày và 2 tháng kích hoạt đúng thời hạn', () => {
    const seven = freshLicense();
    const s7 = seven.activate(seven.createActivationRequest(5).otp);
    assert.equal(s7.label, '7 ngày');
    assert.ok(s7.remaining_seconds > 6 * 86400 && s7.remaining_seconds <= 7 * 86400);

    const two = freshLicense();
    const s2 = two.activate(two.createActivationRequest(6).otp);
    assert.equal(s2.label, '2 tháng');
    assert.ok(s2.remaining_seconds > 59 * 86400 && s2.remaining_seconds <= 60 * 86400);
});

test('gói không hợp lệ bị từ chối, thiếu SECRET_KEY báo rõ', () => {
    assert.throws(() => freshLicense().createActivationRequest(99), /Gói thời hạn không hợp lệ/);
    assert.throws(() => freshLicense({ SECRET_KEY: '' }).createActivationRequest(1), /Chưa cấu hình SECRET_KEY/);
});

test('mã máy để người bán phân biệt thiết bị', () => {
    assert.match(freshLicense().machineTag(), /^[0-9A-F]{16}$/, 'mã máy là 16 hex hoa');
});
