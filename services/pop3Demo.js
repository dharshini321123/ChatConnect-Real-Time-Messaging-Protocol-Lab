const net = require('net'); const tls = require('tls');
// Minimal POP3S demo client: reads greeting and sends USER/PASS/STAT/QUIT.
function runPop3Demo() {
  const { POP3_HOST: host, POP3_USER: user, POP3_PASS: pass } = process.env;
  if (!host || !user || !pass) return Promise.resolve({ configured: false, message: 'Set POP3_HOST, POP3_USER and POP3_PASS in .env to enable.' });
  const port = Number(process.env.POP3_PORT || 995); const secure = String(process.env.POP3_TLS || 'true') === 'true';
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buffer = ''; let step = 0; let finished = false;
    const end = (err, result) => { if (finished) return; finished = true; socket.destroy(); err ? reject(err) : resolve(result); };
    socket.setTimeout(12000, () => end(new Error('POP3 connection timed out')));
    socket.on('error', err => end(err));
    socket.on('data', chunk => { buffer += chunk.toString(); if (!buffer.includes('\r\n')) return; const line = buffer.split('\r\n')[0]; buffer = buffer.slice(line.length + 2); if (step === 0) { if (!line.startsWith('+OK')) return end(new Error('POP3 server greeting failed')); step++; socket.write(`USER ${user}\r\n`); } else if (step === 1) { if (!line.startsWith('+OK')) return end(new Error('POP3 USER rejected')); step++; socket.write(`PASS ${pass}\r\n`); } else if (step === 2) { if (!line.startsWith('+OK')) return end(new Error('POP3 authentication failed')); step++; socket.write('STAT\r\n'); } else if (step === 3) { if (!line.startsWith('+OK')) return end(new Error('POP3 STAT failed')); const stats = line; step++; socket.write('QUIT\r\n'); end(null, { configured: true, connected: true, stats, message: 'POP3 authentication succeeded. Mail count/size returned by STAT.' }); } });
  });
}
module.exports = { runPop3Demo };
