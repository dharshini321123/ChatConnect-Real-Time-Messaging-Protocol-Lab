# ChatConnect — Complete Real-Time Messaging Application

A fresh full-stack project demonstrating a real-time private chat, online presence, persistent MongoDB message history, and Computer Networks / Formal Language & Automata Theory concepts.

## Features
- Register/login with bcrypt password hashing and JWT authentication
- MongoDB Atlas connection via environment variable
- Private real-time messaging using Socket.IO
- Online/offline presence and last-seen display
- Stored chat history and message status lifecycle: Pending → Sent → Read
- Username validation using a regular expression (FLA regular-language demonstration)
- Server-side finite-state transition guard for message status
- SMTP message notification (optional)
- MIME text/HTML email body via Nodemailer (no attachment upload feature)
- POP3 mailbox connection demo (optional, real provider credentials needed)
- IMAP inbox metadata connection demo (optional, real provider credentials needed)
- Responsive light UI and protocol lab
- Render-ready start script

## Requirements
Node.js 18+ and an Atlas cluster (or MongoDB server).

## Setup
1. Extract ZIP and open the project folder in VS Code.
2. In a terminal run:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env`.
4. Edit `.env` and provide:
   - `MONGO_URI`: your MongoDB connection string and database name
   - `JWT_SECRET`: a long random secret
5. Start:
   ```bash
   npm start
   ```
6. Open `http://localhost:5000`.

**Never commit `.env`; it is excluded by `.gitignore`.** Use a database user with a strong password, and only allow the IP addresses you need in Atlas Network Access. Do not share secrets/screenshots.

## Atlas connection
Replace the placeholder in `.env` with the Atlas URI from Database → Connect → Drivers. Ensure the database user exists and Atlas Network Access permits the machine/service IP. URI format example (placeholder only):
```
mongodb+srv://USERNAME:PASSWORD@YOUR_CLUSTER.mongodb.net/chatconnectDB?retryWrites=true&w=majority
```
If the password has URI-reserved characters, URL-encode them.

## SMTP / email notices (optional)
Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and optionally `SMTP_FROM`. For Gmail, use a provider-approved App Password with 2-Step Verification; do not use your account's normal password. The app sends a brief notification to a recipient when they receive a chat message. SMTP test is available in the Protocol Lab. Email uses plain text + HTML MIME alternatives.

## POP3 demo (optional)
Configure `POP3_HOST`, `POP3_PORT`, `POP3_USER`, `POP3_PASS`, and `POP3_TLS`. The demo authenticates, issues `STAT`, and quits; it does not download or delete messages. Provider access/app-password setup may be required. The default Gmail host is an example, not a guarantee of access.

## IMAP demo (optional)
Configure `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `IMAP_SECURE`. The demo connects and reads INBOX mailbox metadata only. It does not fetch message bodies or change mailbox content.

## Render deployment
- Create a Web Service from your GitHub repository.
- Build Command: `npm install`
- Start Command: `npm start`
- Add Environment Variables in Render: `MONGO_URI`, `JWT_SECRET` (and optional SMTP/POP3/IMAP values).
- Atlas Network Access must allow Render's outbound IP ranges as required by your service/region. Follow Render's current dashboard information and Atlas's current network settings; avoid opening access to all IPs unless you understand the security trade-off.
- Render provides `PORT`; app honors it.

## API
- `POST /api/register` `{username,email,password}`
- `POST /api/login` `{identifier,password}` (username or email)
- `GET /api/me` (Bearer token)
- `GET /api/users` (Bearer token)
- `GET /api/messages/:userId` (Bearer token)
- `GET /api/protocols` (Bearer token)
- `POST /api/protocol/smtp-test` (Bearer token)
- `POST /api/protocol/pop3-demo` (Bearer token)
- `POST /api/protocol/imap-demo` (Bearer token)
- `POST /api/fla/validate-username` `{username}` (Bearer token)

## Concepts demonstrated
- Client/server: browser frontend and Express server
- HTTP: REST API calls
- TCP: transport underpinning HTTP/TLS and Socket.IO connections (not application code that manually implements TCP)
- WebSocket: Socket.IO real-time events (Socket.IO may use WebSocket or fallback transport)
- SMTP/MIME: optional mail notices; MIME multipart alternatives for text/HTML
- POP3: optional authentication + STAT mailbox demo
- IMAP: optional INBOX mailbox metadata demo
- FLA: regular-expression username language; message finite-state machine with allowed transitions

## Important scope
This is a student/demo application. POP3/IMAP integrations are connection demonstrations, not a full email client. SMTP, POP3, and IMAP need valid mail provider settings. SMTP notifications are sent only if configured; failed email does not block chat message delivery. No attachment upload support is included. Review security, rate limits, deployment settings, and provider policies before public production use.
