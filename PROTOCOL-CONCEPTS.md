# Subject mapping for viva / record

| Subject concept | Implementation location | Explanation |
|---|---|---|
| Client–Server | `public/` and `server.js` | Browser UI calls backend endpoints/events |
| HTTP | `server.js`, `public/script.js` | REST APIs for authentication, users, history |
| TCP | OS/network transport | TCP supports underlying HTTP/TLS and real-time transport; no custom TCP socket is written for chat |
| WebSocket | Socket.IO in `server.js` and frontend | Event-based real-time messaging; Socket.IO may fall back to polling |
| IP address / port | `server.js` uses `process.env.PORT || 5000` | Local server URL is localhost:5000; deployed platform sets port |
| SMTP | `services/emailService.js`, `/api/protocol/smtp-test` | SMTP sends optional notification email |
| MIME | `services/emailService.js` | Nodemailer sends text and HTML alternatives as MIME content |
| POP3 | `services/pop3Demo.js` | POP3S demo connects, authenticates, STATs, QUITs; no message download |
| IMAP | `services/imapDemo.js` | IMAP demo connects and reads INBOX metadata |
| Regex / Regular language | `server.js` username regex, Protocol Lab | Username language: 3–20 ASCII letters, digits, underscore |
| FSM / state transition | `models/Message.js`, `server.js` | Pending→Sent→Read; transition helper rejects other moves |
| Validation | `server.js` | username/email/password/message validations on server |

## FSM states
- Pending: message record created.
- Sent: server accepts and emits to sender and recipient.
- Read: recipient opens conversation; unread messages transition to read.

Allowed transitions: Pending→Sent; Sent→Read; Read has no outgoing transition.
