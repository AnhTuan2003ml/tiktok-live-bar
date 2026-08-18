'use strict';

// Khung kích hoạt bản quyền: 2 bước, đếm ngược và tự kiểm tra trạng thái.
// Mất kết nối tới Bridge thì giữ nguyên trạng thái hiện tại, không tự khoá.

(() => {
    const KEY_LEN = 12;   // mã kích hoạt 12 ký tự
    const POLL_MS = 15000;

    const gate = document.getElementById('license-gate');
    if (!gate) return;

    const el = id => document.getElementById(id);
    const state = { status: null, expiresAt: 0, perpetual: false, active: false, timer: null };

    function setGateVisible(visible) {
        gate.classList.toggle('hidden', !visible);
        document.body.classList.toggle('license-locked', visible);
    }

    function formatRemaining(seconds) {
        if (seconds <= 0) return 'Hết hạn';
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        if (days > 0) return `${days} ngày ${hours} giờ`;
        if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        return `${minutes}:${String(secs).padStart(2, '0')}`;
    }

    function renderCountdown() {
        const chip = el('license-chip');
        const dot = el('license-dot');
        const text = el('license-countdown');
        if (!chip || !text) return;

        if (!state.active) {
            text.textContent = 'Chưa kích hoạt';
            dot.className = 'dot bad';
            chip.classList.remove('warn');
            return;
        }
        if (state.perpetual) {
            text.textContent = 'Vĩnh viễn';
            dot.className = 'dot ok';
            chip.classList.remove('warn');
            return;
        }

        const remaining = Math.max(0, state.expiresAt - Math.floor(Date.now() / 1000));
        text.textContent = formatRemaining(remaining);
        dot.className = remaining < 3600 ? 'dot warn' : 'dot ok';
        chip.classList.toggle('warn', remaining < 3600);

        if (remaining <= 0) {
            // Đếm ngược chạm 0: kiểm tra ngay để khoá app, không đợi hết chu kỳ poll.
            refreshStatus();
        }
    }

    const onActivatePage = location.pathname.endsWith('/activate.html');

    function applyStatus(status) {
        if (!status || typeof status.active !== 'boolean') return;
        state.status = status;
        state.active = status.active;
        state.perpetual = Boolean(status.perpetual);
        state.expiresAt = Number(status.expires_at) || 0;

        const message = el('license-message');
        if (message) message.textContent = status.message || '';

        // Trang kích hoạt và giao diện vận hành là hai trang khác nhau: có bản quyền thì
        // vào thẳng giao diện chính, mất bản quyền thì quay lại trang kích hoạt.
        if (onActivatePage && status.active) {
            location.replace('/control.html');
            return;
        }
        if (!onActivatePage && !status.active) {
            location.replace('/activate.html');
            return;
        }

        setGateVisible(!status.active);
        renderCountdown();
    }

    async function refreshStatus() {
        try {
            const response = await fetch('/api/license/status', { cache: 'no-store' });
            if (!response.ok) return;
            applyStatus(await response.json());
        } catch {
            // Bridge chưa sẵn sàng: giữ nguyên trạng thái, tránh khoá nhầm.
        }
    }

    async function loadOptions() {
        try {
            const response = await fetch('/api/license/options', { cache: 'no-store' });
            if (!response.ok) return;
            const data = await response.json();

            const device = el('license-device');
            const mac = el('license-mac');
            if (device) device.textContent = data.device || '—';
            if (mac) mac.textContent = data.mac || '—';

            const select = el('license-duration');
            if (select) {
                select.replaceChildren(...(data.durations || []).map(item => {
                    const option = document.createElement('option');
                    option.value = String(item.code);
                    option.textContent = item.label;
                    return option;
                }));
            }

            const note = el('license-request-note');
            if (note) {
                const receivers = (data.receivers || []).join(', ');
                note.textContent = receivers
                    ? `Mã sẽ có hiệu lực ${data.valid_minutes} phút. Mã không hiển thị tại đây — hãy liên hệ người bán để nhận.`
                    : 'Chưa cấu hình email người bán trong file .env của Bridge.';
            }
        } catch {
            // Bỏ qua: bấm "Gửi mã" sẽ báo lỗi cụ thể nếu thật sự không gọi được Bridge.
        }
    }

    // Mã 12 ký tự: viết hoa, bỏ ký tự lạ, cắt còn 12 rồi chèn gạch mỗi 4 ký tự.
    function normalizeInput(raw) {
        const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, KEY_LEN);
        return (cleaned.match(/.{1,4}/g) || []).join('-');
    }

    function keyLength() {
        return String(el('license-key')?.value || '').replace(/[^A-Z0-9]/gi, '').length;
    }

    function syncActivateButton() {
        const button = el('license-activate');
        if (button) button.disabled = keyLength() !== KEY_LEN;
    }

    el('license-key')?.addEventListener('input', event => {
        const atEnd = event.target.selectionStart === event.target.value.length;
        event.target.value = normalizeInput(event.target.value);
        if (atEnd) event.target.setSelectionRange(event.target.value.length, event.target.value.length);
        syncActivateButton();
    });

    el('license-key')?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            el('license-activate')?.click();
        }
    });

    el('license-request')?.addEventListener('click', async () => {
        const button = el('license-request');
        const note = el('license-request-note');
        const durationCode = Number(el('license-duration')?.value);
        button.disabled = true;
        button.textContent = 'Đang gửi mã…';
        try {
            const response = await fetch('/api/license/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ duration_code: durationCode })
            });
            const data = await response.json();
            if (!response.ok || data.ok === false) throw new Error(data.error || 'Không gửi được mã.');
            if (note) {
                note.textContent = `Đã gửi mã gói "${data.label}". `
                    + `Liên hệ người bán để nhận mã trong ${data.valid_minutes} phút rồi dán vào ô bên dưới.`;
                note.className = 'license-note ok';
            }
            el('license-key')?.focus();
        } catch (error) {
            if (note) {
                note.textContent = error.message;
                note.className = 'license-note err';
            }
        } finally {
            button.disabled = false;
            button.textContent = 'Gửi mã về email người bán';
        }
    });

    el('license-activate')?.addEventListener('click', async () => {
        const button = el('license-activate');
        const note = el('license-activate-note');
        button.disabled = true;
        button.textContent = 'Đang kích hoạt…';
        try {
            const response = await fetch('/api/license/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: el('license-key')?.value || '' })
            });
            const data = await response.json();
            if (!response.ok || data.ok === false) throw new Error(data.error || 'Kích hoạt thất bại.');
            if (note) {
                note.textContent = data.message || 'Đã kích hoạt.';
                note.className = 'license-note ok';
            }
            applyStatus(data);
        } catch (error) {
            if (note) {
                note.textContent = error.message;
                note.className = 'license-note err';
            }
        } finally {
            button.textContent = 'Kích hoạt';
            syncActivateButton();
        }
    });

    window.TisoLicense = { refresh: refreshStatus };

    loadOptions();
    refreshStatus();
    setInterval(refreshStatus, POLL_MS);
    state.timer = setInterval(renderCountdown, 1000);
})();
