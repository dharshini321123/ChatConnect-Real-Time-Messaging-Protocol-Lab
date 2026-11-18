const { ImapFlow } = require('imapflow');
async function runImapDemo() {
  const { IMAP_HOST: host, IMAP_USER: user, IMAP_PASS: pass } = process.env;
  if (!host || !user || !pass) return { configured: false, message: 'Set IMAP_HOST, IMAP_USER and IMAP_PASS in .env to enable.' };
  const client = new ImapFlow({ host, port: Number(process.env.IMAP_PORT || 993), secure: String(process.env.IMAP_SECURE || 'true') === 'true', auth: { user, pass }, logger: false });
  try { await client.connect(); const lock = await client.getMailboxLock('INBOX'); try { const mailbox = client.mailbox; return { configured: true, connected: true, mailbox: mailbox.path, exists: mailbox.exists, message: 'IMAP connection succeeded; inbox mailbox metadata retrieved.' }; } finally { lock.release(); } } finally { await client.logout().catch(() => {}); }
}
module.exports = { runImapDemo };
