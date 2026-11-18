require('dotenv').config();

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const User = require('./models/User');
const Message = require('./models/Message');
const emailService = require('./services/emailService');
const { runPop3Demo } = require('./services/pop3Demo');
const { runImapDemo } = require('./services/imapDemo');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.warn('Warning: JWT_SECRET is missing. Set it in .env');
}

// Regular Expressions
const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Generate JWT Token
function tokenFor(user) {
    return jwt.sign(
        { id: user._id.toString() },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

// Authentication Middleware
async function auth(req, res, next) {
    try {
        const raw = (req.headers.authorization || '')
            .replace(/^Bearer\s+/i, '');

        if (!raw) {
            return res.status(401).json({
                error: 'Login required'
            });
        }

        const payload = jwt.verify(raw, JWT_SECRET);

        req.user = await User.findById(payload.id)
            .select('_id username email');

        if (!req.user) {
            return res.status(401).json({
                error: 'Account not found'
            });
        }

        next();

    } catch {
        res.status(401).json({
            error: 'Invalid or expired token'
        });
    }
}

// Health Check
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        app: 'ChatConnect',
        database: mongoose.connection.readyState === 1
            ? 'connected'
            : 'disconnected'
    });
});

// Register
app.post('/api/register', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const email = String(req.body.email || '')
            .trim()
            .toLowerCase();

        const password = String(req.body.password || '');

        if (!usernameRegex.test(username)) {
            return res.status(400).json({
                error: 'Username must be 3–20 characters: letters, numbers, underscore only.'
            });
        }

        if (!emailRegex.test(email)) {
            return res.status(400).json({
                error: 'Enter a valid email address.'
            });
        }

        if (password.length < 8 || password.length > 72) {
            return res.status(400).json({
                error: 'Password must be 8–72 characters.'
            });
        }

        const existing = await User.findOne({
            $or: [{ username }, { email }]
        });

        if (existing) {
            return res.status(409).json({
                error: 'Username or email already exists.'
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const user = await User.create({
            username,
            email,
            passwordHash
        });

        res.status(201).json({
            token: tokenFor(user),
            user: {
                id: user._id,
                username,
                email
            }
        });

    } catch (e) {
        if (e.code === 11000) {
            return res.status(409).json({
                error: 'Username or email already exists.'
            });
        }

        console.error('Registration error:', e.message);

        res.status(500).json({
            error: 'Registration failed.'
        });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const identifier = String(req.body.identifier || '').trim();
        const password = String(req.body.password || '');

        const user = await User.findOne({
            $or: [
                { username: identifier },
                { email: identifier.toLowerCase() }
            ]
        });

        if (!user || !(await bcrypt.compare(
            password,
            user.passwordHash
        ))) {
            return res.status(401).json({
                error: 'Invalid username/email or password.'
            });
        }

        res.json({
            token: tokenFor(user),
            user: {
                id: user._id,
                username: user.username,
                email: user.email
            }
        });

    } catch (e) {
        console.error('Login error:', e.message);

        res.status(500).json({
            error: 'Login failed.'
        });
    }
});

// Current User
app.get('/api/me', auth, (req, res) => {
    res.json(req.user);
});

// Users List
app.get('/api/users', auth, async (req, res) => {
    try {
        const users = await User.find({
            _id: { $ne: req.user._id }
        })
            .select('username online lastSeen')
            .sort({ username: 1 });

        res.json(users);

    } catch {
        res.status(500).json({
            error: 'Unable to load users.'
        });
    }
});

// Message History
app.get('/api/messages/:userId', auth, async (req, res) => {
    try {
        const other = req.params.userId;

        const msgs = await Message.find({
            $or: [
                {
                    sender: req.user._id,
                    receiver: other
                },
                {
                    sender: other,
                    receiver: req.user._id
                }
            ]
        })
            .sort({ createdAt: 1 })
            .limit(300);

        await Message.updateMany(
            {
                sender: other,
                receiver: req.user._id,
                status: { $ne: 'read' }
            },
            {
                $set: { status: 'read' },
                $push: {
                    statusHistory: {
                        status: 'read',
                        at: new Date()
                    }
                }
            }
        );

        res.json(msgs);

    } catch {
        res.status(400).json({
            error: 'Unable to load messages.'
        });
    }
});

// Protocol Information
app.get('/api/protocols', auth, (req, res) => {
    res.json({
        tcp: 'Underlying transport used by HTTP/WebSocket connections',
        http: 'REST APIs are implemented',
        websocket: 'Socket.IO real-time messaging is implemented',
        smtp: emailService.configured()
            ? 'Configured'
            : 'Not configured',
        mime: 'SMTP email supports text and HTML MIME content',
        pop3: Boolean(
            process.env.POP3_HOST &&
            process.env.POP3_USER &&
            process.env.POP3_PASS
        ),
        imap: Boolean(
            process.env.IMAP_HOST &&
            process.env.IMAP_USER &&
            process.env.IMAP_PASS
        ),
        fla: [
            'Username regular-expression validation',
            'Message status finite-state transitions'
        ]
    });
});

// SMTP Test
app.post('/api/protocol/smtp-test', auth, async (req, res) => {
    try {
        if (!emailService.configured()) {
            return res.status(400).json({
                error: 'SMTP not configured. Add SMTP variables to .env.'
            });
        }

        const nodemailer = require('nodemailer');

        const tx = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 465),
            secure: String(
                process.env.SMTP_SECURE || 'true'
            ) === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        await tx.verify();

        res.json({
            ok: true,
            message: 'SMTP server connection verified.'
        });

    } catch (e) {
        res.status(400).json({
            error: 'SMTP verification failed: ' + e.message
        });
    }
});

// POP3 Demo
app.post('/api/protocol/pop3-demo', auth, async (req, res) => {
    try {
        res.json(await runPop3Demo());

    } catch (e) {
        res.status(400).json({
            error: 'POP3 connection failed: ' + e.message
        });
    }
});

// IMAP Demo
app.post('/api/protocol/imap-demo', auth, async (req, res) => {
    try {
        res.json(await runImapDemo());

    } catch (e) {
        res.status(400).json({
            error: 'IMAP connection failed: ' + e.message
        });
    }
});

// FLA Regular Language / Regex Validation
app.post('/api/fla/validate-username', auth, (req, res) => {
    const value = String(req.body.username || '');

    res.json({
        input: value,
        valid: usernameRegex.test(value),
        rule: 'L = usernames of 3–20 characters from letters, digits and underscore',
        regex: '^[a-zA-Z0-9_]{3,20}$'
    });
});

// Finite State Machine
const allowedTransitions = {
    pending: ['sent'],
    sent: ['read'],
    read: []
};

function transitionStatus(message, next) {
    if (!allowedTransitions[message.status]?.includes(next)) {
        return false;
    }

    message.status = next;

    message.statusHistory.push({
        status: next,
        at: new Date()
    });

    return true;
}

// Online Users / Socket Tracking
const onlineSockets = new Map();

// Socket Authentication
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        const payload = jwt.verify(token, JWT_SECRET);

        socket.userId = payload.id;
        next();

    } catch {
        next(new Error('Authentication required'));
    }
});

// Socket Connection
io.on('connection', async (socket) => {
    const uid = socket.userId;

    socket.join(uid);

    onlineSockets.set(
        uid,
        (onlineSockets.get(uid) || 0) + 1
    );

    await User.findByIdAndUpdate(uid, {
        online: true,
        lastSeen: null
    });

    io.emit('presence', {
        userId: uid,
        online: true
    });

    // PRIVATE MESSAGE + EMAIL NOTIFICATION
    socket.on('private-message', async (data, ack = () => { }) => {
        try {
            const receiver = String(data?.receiver || '');
            const text = String(data?.text || '').trim();

            if (
                !mongoose.isValidObjectId(receiver) ||
                receiver === uid
            ) {
                return ack({
                    ok: false,
                    error: 'Choose a valid recipient.'
                });
            }

            if (!text || text.length > 2000) {
                return ack({
                    ok: false,
                    error: 'Message must contain 1–2000 characters.'
                });
            }

            // Save message in MongoDB
            const message = await Message.create({
                sender: uid,
                receiver,
                text,
                status: 'pending',
                statusHistory: [
                    { status: 'pending' }
                ]
            });

            // FSM: Pending -> Sent
            transitionStatus(message, 'sent');

            await message.save();

            const payload = {
                _id: message._id,
                sender: uid,
                receiver,
                text,
                status: message.status,
                statusHistory: message.statusHistory,
                createdAt: message.createdAt
            };

            // Deliver message to receiver
            io.to(receiver).emit(
                'private-message',
                payload
            );

            // Show message to sender
            io.to(uid).emit(
                'private-message',
                payload
            );

            // Confirm message delivery to client
            ack({
                ok: true,
                message: payload
            });

            // Find receiver and sender email details
            const recipient = await User.findById(receiver)
                .select('email username');

            const sender = await User.findById(uid)
                .select('username');

            // Trigger email notification
            if (
                recipient &&
                sender &&
                recipient.email
            ) {
                await sendNoticeSafely(
                    recipient.email,
                    sender.username
                );
            }

        } catch (e) {
            console.error('Private message error:', e.message);

            ack({
                ok: false,
                error: 'Message could not be sent.'
            });
        }
    });

    // Mark Messages as Read
    socket.on('mark-read', async ({ senderId } = {}) => {
        try {
            if (!mongoose.isValidObjectId(senderId)) {
                return;
            }

            const unread = await Message.find({
                sender: senderId,
                receiver: uid,
                status: 'sent'
            });

            for (const message of unread) {
                transitionStatus(message, 'read');
            }

            if (unread.length) {
                await Message.bulkSave(unread);
            }

            io.to(senderId).emit('messages-read', {
                reader: uid,
                ids: unread.map(m => m._id)
            });

        } catch (e) {
            console.error('Mark read error:', e.message);
        }
    });

    // Disconnect
    socket.on('disconnect', async () => {
        const count = Math.max(
            0,
            (onlineSockets.get(uid) || 1) - 1
        );

        if (count) {
            onlineSockets.set(uid, count);
        } else {
            onlineSockets.delete(uid);

            await User.findByIdAndUpdate(uid, {
                online: false,
                lastSeen: new Date()
            });

            io.emit('presence', {
                userId: uid,
                online: false,
                lastSeen: new Date()
            });
        }
    });
});

// Email Notification Helper
async function sendNoticeSafely(to, sender) {
    try {
        if (!emailService.configured()) {
            console.log(
                'Email notification skipped: SMTP is not configured.'
            );
            return;
        }

        const notificationText =
            'You received a new message on ChatConnect. Log in to ChatConnect to read it.';

        await emailService.sendMessageNotice(
            to,
            sender,
            notificationText
        );

        console.log(
            'Email notification sent successfully to recipient.'
        );

    } catch (e) {
        console.warn(
            'Email notification failed:',
            e.message
        );
    }
}

// General Error Handler
app.use((err, req, res, next) => {
    console.error(err);

    res.status(500).json({
        error: 'Server error.'
    });
});

// Start Server
async function start() {
    if (!process.env.MONGO_URI) {
        console.error(
            'MONGO_URI missing. Copy .env.example to .env and configure it.'
        );
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);

    console.log('MongoDB connected');

    server.listen(PORT, () => {
        console.log(`ChatConnect running on port ${PORT}`);
    });
}

if (require.main === module) {
    start().catch(err => {
        console.error('Startup failed:', err.message);
        process.exit(1);
    });
}

module.exports = {
    app,
    server,
    transitionStatus,
    allowedTransitions
};