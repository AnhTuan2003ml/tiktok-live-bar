'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Windows launch scripts use CRLF line endings', () => {
    const repositoryRoot = path.join(__dirname, '..', '..');
    for (const fileName of ['run.bat', 'build.bat', 'package.bat']) {
        const content = fs.readFileSync(path.join(repositoryRoot, fileName), 'utf8');
        assert.match(content, /\r\n/, `${fileName} must contain CRLF line endings`);
        assert.doesNotMatch(content, /(^|[^\r])\n/, `${fileName} contains bare LF line endings`);
    }
});

test('launcher checks npm exit status at execution time', () => {
    const repositoryRoot = path.join(__dirname, '..', '..');
    const launcher = fs.readFileSync(path.join(repositoryRoot, 'run.bat'), 'utf8');

    assert.doesNotMatch(launcher, /NPM_RESULT=%ERRORLEVEL%/);
    assert.match(launcher, /call npm ci[\s\S]*?if errorlevel 1/);
});

test('packager ships a runnable bundle and strips private config', () => {
    const repositoryRoot = path.join(__dirname, '..', '..');
    const packager = fs.readFileSync(path.join(repositoryRoot, 'package.bat'), 'utf8');

    // Goi phai co du game, server va launcher.
    for (const piece of ['Build', 'TikTokBridge', 'DJ_MUSIC', 'LiveAssets', 'run.bat']) {
        assert.match(packager, new RegExp(piece), `package.bat must bundle ${piece}`);
    }
    // Khong duoc mang .env va mat khau OBS cua may dang dong goi sang may khac.
    assert.match(packager, /\/XF ".env"/);
    assert.match(packager, /sanitize-package-config\.js/);
    assert.ok(fs.existsSync(path.join(repositoryRoot, 'scripts', 'sanitize-package-config.js')));
});

test('launcher prefers a bundled Node runtime when the package ships one', () => {
    const repositoryRoot = path.join(__dirname, '..', '..');
    const launcher = fs.readFileSync(path.join(repositoryRoot, 'run.bat'), 'utf8');

    assert.match(launcher, /PORTABLE_NODE=%ROOT%runtime\\node\.exe/);
    assert.match(launcher, /if exist "%PORTABLE_NODE%"[\s\S]*?USE_PORTABLE_NODE=1/);
    assert.match(launcher, /if not defined USE_PORTABLE_NODE[\s\S]*?where node/);
});
