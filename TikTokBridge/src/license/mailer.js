'use strict';

// Gửi mã kích hoạt tới các hộp thư quản trị. Mã KHÔNG bao giờ hiển thị cho khách,
// người bán đọc mã từ email sau khi đã đối chiếu thiết bị và thu tiền.

const nodemailer = require('nodemailer');
const { APP_TAG } = require('./license');

function smtpUser() {
    return String(process.env.SENDMAIL_USER || process.env.SMTP_USER || '').trim();
}

function smtpPass() {
    return String(process.env.SENDMAIL_PASS || process.env.SMTP_PASSWORD || '').trim();
}

function receivers() {
    const direct = [process.env.RECEIVER_EMAIL_1, process.env.RECEIVER_EMAIL_2]
        .map(value => String(value || '').trim())
        .filter(Boolean);
    if (direct.length) return direct;
    return String(process.env.RECIPIENT_EMAILS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
}

function maskEmail(email) {
    const value = String(email || '');
    const at = value.indexOf('@');
    if (at <= 0) return value;
    const name = value.slice(0, at);
    const visible = name.slice(0, 2);
    return `${visible}***${value.slice(at)}`;
}

function buildText({ otp, label, mac, device }) {
    return [
        `Yêu cầu kích hoạt ${APP_TAG} Live`,
        '',
        `Mã kích hoạt : ${otp}`,
        `Gói thời hạn : ${label}`,
        `Tên thiết bị : ${device}`,
        `Địa chỉ MAC  : ${mac}`,
        '',
        'Đối chiếu tên thiết bị và MAC với máy khách trước khi cấp mã.',
        `Mã chỉ dùng được trên đúng máy đã sinh ra nó và hết hạn sau ${process.env.OTP_VALID_MINUTES || 5} phút.`
    ].join('\n');
}

function buildHtml({ otp, label, mac, device }) {
    const escape = value => String(value).replace(/[&<>"]/g, char => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]
    ));
    const minutes = escape(process.env.OTP_VALID_MINUTES || 5);
    const row = (title, value) => `
          <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #eceff5;color:#6b7280;font-size:13px;white-space:nowrap">${escape(title)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #eceff5;color:#111827;font-size:14px;font-weight:600">${escape(value)}</td>
          </tr>`;

    return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#f4f6fb;font-family:'Segoe UI',Roboto,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;margin:0 auto;border-collapse:collapse;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(17,24,39,.08)">
    <tr>
      <td style="padding:20px 24px;background:linear-gradient(135deg,#6d7cff,#a06bff);color:#ffffff">
        <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.85">${escape(APP_TAG)} LIVE</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px">Yêu cầu kích hoạt bản quyền</div>
      </td>
    </tr>

    <tr>
      <td style="padding:24px 24px 8px">
        <div style="color:#6b7280;font-size:13px;margin-bottom:8px">Mã kích hoạt</div>
        <div style="padding:16px;border:2px dashed #6d7cff;border-radius:12px;background:#f5f6ff;text-align:center">
          <span style="font-family:Consolas,'Courier New',monospace;font-size:30px;font-weight:700;letter-spacing:4px;color:#3f3fa8">${escape(otp)}</span>
        </div>
        <div style="margin-top:8px;color:#9aa3b2;font-size:12px;text-align:center">
          Hiệu lực ${minutes} phút · chỉ dùng được trên đúng máy đã gửi yêu cầu
        </div>
      </td>
    </tr>

    <tr>
      <td style="padding:12px 24px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #eceff5;border-radius:10px;overflow:hidden">
${row('Gói thời hạn', label)}
${row('Tên thiết bị', device)}
${row('Địa chỉ MAC', mac)}
        </table>
      </td>
    </tr>

    <tr>
      <td style="padding:16px 24px 24px">
        <div style="padding:12px 14px;background:#fff8e6;border-left:4px solid #f0a500;border-radius:8px;color:#8a5a00;font-size:13px;line-height:1.6">
          <b>Trước khi đọc mã cho khách:</b> đối chiếu <b>tên thiết bị</b> và <b>địa chỉ MAC</b> ở trên
          với máy của khách, và xác nhận đã nhận thanh toán.
        </div>
        <div style="margin-top:14px;color:#9aa3b2;font-size:12px;line-height:1.6">
          Email này do ${escape(APP_TAG)} Live tự gửi khi có người bấm “Gửi mã” trên máy khách.
          Mã hết hạn sau ${minutes} phút và chỉ dùng được một lần.
        </div>
      </td>
    </tr>
  </table>
</body></html>`;
}

async function sendActivationCode({ otp, label, mac, device }) {
    const user = smtpUser();
    const pass = smtpPass();
    if (!user || !pass) {
        throw new Error('Chưa cấu hình SENDMAIL_USER/SENDMAIL_PASS trong file .env của Bridge.');
    }

    const to = receivers();
    if (!to.length) {
        throw new Error('Chưa cấu hình RECEIVER_EMAIL_1/RECEIVER_EMAIL_2 trong file .env của Bridge.');
    }

    const transporter = nodemailer.createTransport({
        host: String(process.env.SMTP_HOST || 'smtp.gmail.com'),
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,          // STARTTLS trên cổng 587
        requireTLS: true,
        auth: { user, pass }
    });

    const from = String(process.env.SMTP_FROM || `${APP_TAG} <${user}>`);
    const subject = `[${APP_TAG}] Mã kích hoạt · ${device} · ${mac}`;
    const sent = [];

    try {
        for (const recipient of to) {
            await transporter.sendMail({
                from,
                to: recipient,
                subject,
                text: buildText({ otp, label, mac, device }),
                html: buildHtml({ otp, label, mac, device })
            });
            sent.push(recipient);
        }
    } finally {
        transporter.close();
    }

    if (!sent.length) throw new Error('Không gửi được mã tới hộp thư quản trị nào.');
    return sent;
}

module.exports = { sendActivationCode, receivers, maskEmail };
