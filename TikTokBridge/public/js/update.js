'use strict';

// Kiểm tra bản phát hành mới trên GitHub và chạy cập nhật.
// Tự kiểm tra một lần lúc mở Control Panel, sau đó mỗi 6 giờ.

(() => {
    const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;

    const el = id => document.getElementById(id);
    if (!el('update-check')) return;

    function setBadge(element, label, mode = '') {
        if (!element) return;
        element.textContent = label;
        element.className = `state-badge ${mode}`.trim();
    }

    function formatSize(bytes) {
        if (!bytes) return '';
        return ` · ${(bytes / 1048576).toFixed(1)} MB`;
    }

    function renderVersionChip(data) {
        const chip = el('version-chip');
        if (!chip) return;
        if (data.ok !== false && data.has_update) {
            chip.textContent = `⬆ Cập nhật ${data.latest}`;
            chip.classList.add('has-update');
            chip.title = `Đang chạy ${data.current} · đã có ${data.latest}. Bấm để cập nhật.`;
        } else {
            chip.textContent = data.current || 'v—';
            chip.classList.remove('has-update');
            chip.title = `Phiên bản ${data.current || ''}`;
        }
    }

    function render(data) {
        renderVersionChip(data);
        const info = el('update-info');
        const notes = el('update-notes');
        const apply = el('update-apply');
        const link = el('update-link');
        const current = el('update-current');

        if (current) current.textContent = `Đang chạy bản ${data.current || '—'}`;

        if (data.ok === false) {
            setBadge(el('update-badge'), 'KHÔNG KIỂM TRA ĐƯỢC', 'warn');
            info.className = 'inline-status update-error';
            info.textContent = data.error || 'Không hỏi được GitHub.';
            notes.classList.add('hidden');
            apply.classList.add('hidden');
            link.classList.add('hidden');
            return;
        }

        if (data.has_update) {
            setBadge(el('update-badge'), 'CÓ BẢN MỚI', 'ok');
            info.className = 'inline-status update-ready';
            info.textContent = `Đã có bản ${data.latest}${formatSize(data.asset_size)}. `
                + 'Bấm "Cập nhật ngay" — TISO sẽ tự tải, đóng app, ghi đè rồi mở lại. '
                + 'Cấu hình, nhạc, ảnh nền và bản quyền của bạn được giữ nguyên.';
            apply.classList.remove('hidden');
        } else {
            setBadge(el('update-badge'), 'MỚI NHẤT', 'ok');
            info.className = 'inline-status';
            info.textContent = `Bạn đang dùng bản mới nhất (${data.current}).`;
            apply.classList.add('hidden');
        }

        if (data.notes) {
            notes.textContent = data.notes;
            notes.classList.remove('hidden');
        } else {
            notes.classList.add('hidden');
        }

        if (data.html_url) {
            link.href = data.html_url;
            link.classList.remove('hidden');
        } else {
            link.classList.add('hidden');
        }
    }

    async function check(force = false) {
        const button = el('update-check');
        button.disabled = true;
        button.textContent = 'Đang kiểm tra…';
        setBadge(el('update-badge'), 'ĐANG KIỂM TRA', 'warn');
        try {
            const response = await fetch(`/api/update/check${force ? '?force=1' : ''}`, { cache: 'no-store' });
            render(await response.json());
        } catch (error) {
            render({ ok: false, error: `Không gọi được Bridge: ${error.message}` });
        } finally {
            button.disabled = false;
            button.textContent = 'Kiểm tra bản mới';
        }
    }

    el('update-check').addEventListener('click', () => check(true));

    el('version-chip')?.addEventListener('click', () => {
        const chip = el('version-chip');
        if (chip && chip.classList.contains('has-update')) {
            el('update-apply')?.click();   // co ban moi -> cap nhat ngay
        } else {
            document.querySelector('.nav-btn[data-tab="advanced"]')?.click();  // mo tab Cau hinh
        }
    });

    el('update-apply')?.addEventListener('click', async () => {
        const button = el('update-apply');
        const info = el('update-info');
        button.disabled = true;
        button.textContent = 'Đang khởi động trình cập nhật…';
        try {
            const response = await fetch('/api/update/apply', { method: 'POST' });
            const data = await response.json();
            if (!response.ok || data.ok === false) throw new Error(data.error || 'Không chạy được trình cập nhật.');
            info.className = 'inline-status update-ready';
            info.textContent = data.message;
        } catch (error) {
            info.className = 'inline-status update-error';
            info.textContent = error.message;
            button.disabled = false;
            button.textContent = 'Cập nhật ngay';
        }
    });

    check(false);
    setInterval(() => check(true), AUTO_CHECK_MS);
})();
