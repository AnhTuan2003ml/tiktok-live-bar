'use strict';

// Kiểm tra bản quyền cho run.bat. Thoát 0 nếu đã kích hoạt hợp lệ, thoát 1 nếu chưa.
// Chạy được cả bản mã nguồn lẫn bản đóng gói (module đã biên dịch bytecode).

try { require('bytenode'); } catch { /* bản mã nguồn không cần bytenode */ }

try {
    require('./src/license/secure-env').loadSecureEnvironment();
    const active = require('./src/license/license').licenseStatus().active === true;
    process.exit(active ? 0 : 1);
} catch (error) {
    // Lỗi bất ngờ coi như chưa kích hoạt để không mở nhầm giao diện vận hành.
    process.stderr.write(String(error && error.message || error) + '\n');
    process.exit(1);
}
