const nodemailer = require('nodemailer');
function configured() { return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }
function transporter() {
  if (!configured()) return null;
  return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: String(process.env.SMTP_SECURE || 'true') === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
}
async function sendMessageNotice(to, sender, text) {
  const tx = transporter(); if (!tx || !to) return { skipped: true, reason: 'SMTP is not configured or recipient has no email' };
  return tx.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject: `New ChatConnect message from ${sender}`, text: `${sender} sent you a message.\n\n${text}`, html: `<p><strong>${escapeHtml(sender)}</strong> sent you a message.</p><blockquote>${escapeHtml(text)}</blockquote><p>Sign in to ChatConnect to reply.</p>`, });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
module.exports = { sendMessageNotice, configured };
