'use strict';

// Bien dich cac module ban quyen sang bytecode V8 (.jsc) cho ban dong goi.
// Sau buoc nay, file .js goc bi xoa khoi goi: khong the doc hay sua bang trinh soan thao.
//
// Chay: node scripts/compile-protected.js <thu-muc-goi>
//
// Luu y: bytecode gan chat voi phien ban V8, nen goi phai chay bang dung Node
// di kem (runtime\node.exe). run.bat da uu tien runtime nay.

const fs = require('node:fs');
const path = require('node:path');

const stageDir = process.argv[2];
if (!stageDir) {
    console.error('[LOI] Thieu duong dan thu muc goi.');
    process.exit(1);
}

const repoRoot = path.join(__dirname, '..');
let bytenode;
try {
    bytenode = require(path.join(repoRoot, 'TikTokBridge', 'node_modules', 'bytenode'));
} catch (error) {
    console.error(`[LOI] Khong nap duoc bytenode: ${error.message}`);
    process.exit(1);
}

// Module nao cham toi khoa ky va cau hinh nhay cam thi bao ve.
const TARGETS = [
    'TikTokBridge/src/license/embedded-env.js',
    'TikTokBridge/src/license/secure-env.js',
    'TikTokBridge/src/license/license.js'
];

const compiled = [];
for (const relative of TARGETS) {
    const source = path.join(stageDir, relative);
    if (!fs.existsSync(source)) {
        console.error(`[LOI] Thieu ${relative} trong goi.`);
        process.exit(1);
    }

    const target = source.replace(/\.js$/, '.jsc');
    bytenode.compileFile({ filename: source, output: target, compileAsModule: true });

    // File .js goc phai bien mat, neu khong thi Node se nap ban van ban thay vi bytecode.
    fs.rmSync(source, { force: true });

    // Cau noi: require('./license') van chay duoc nho shim nap .jsc.
    const shim = `'use strict';
require('bytenode');
module.exports = require('./${path.basename(target)}');
`;
    fs.writeFileSync(source, shim, 'utf8');
    compiled.push(relative);
}

// bytenode phai duoc nap som nhat co the, truoc khi bat ky module bao ve nao chay.
const serverPath = path.join(stageDir, 'TikTokBridge', 'server.js');
if (fs.existsSync(serverPath)) {
    const server = fs.readFileSync(serverPath, 'utf8');
    if (!server.startsWith("'use strict';\nrequire('bytenode');")) {
        fs.writeFileSync(serverPath, server.replace("'use strict';", "'use strict';\nrequire('bytenode');"), 'utf8');
    }
}

console.log(`      Da bien dich ${compiled.length} module ban quyen sang bytecode V8.`);
