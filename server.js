
require('dotenv').config();

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const multer = require('multer');

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

// File Upload Configuration
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

let gridFSBucket;

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

// Validate ObjectId
function validId(id) {
    return mongoose.isValidObjectId(id);
}

// Check whether two users belong to a conversation
function conversationQuery(userId, otherId) {
    return {
        $or: [
            {
                sender: userId,
                receiver: otherId
            },
            {
                sender: otherId,
                receiver: userId
            }
        ]
    };
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

// Recent Chats + Last Message + Unread Count
app.get('/api/chats', auth, async (req, res) => {
    try {
        const userId = req.user._id;

        const messages = await Message.find({
            $or: [
                { sender: userId },
                { receiver: userId }
            ],
            deletedForEveryone: { $ne: true },
            deletedFor: { $ne: userId }
        }).sort({ createdAt: -1 });

        const chatMap = new Map();

        for (const message of messages) {
            const otherId = String(message.sender) === String(userId)
                ? String(message.receiver)
                : String(message.sender);

            if (!chatMap.has(otherId)) {
                chatMap.set(otherId, {
                    userId: otherId,
                    lastMessage: message,
                    unreadCount: 0,
                    lastMessageAt: message.createdAt
                });
            }

            if (
                String(message.receiver) === String(userId) &&
                message.status !== 'read'
            ) {
                chatMap.get(otherId).unreadCount++;
            }
        }

        const chatIds = [...chatMap.keys()];

        const chatUsers = await User.find({
            _id: { $in: chatIds }
        }).select('username online lastSeen');

        const result = chatUsers.map(user => {
            const chat = chatMap.get(String(user._id));

            return {
                user,
                lastMessage: chat.lastMessage,
                unreadCount: chat.unreadCount,
                lastMessageAt: chat.lastMessageAt
            };
        }).sort((a, b) =>
            new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
        );

        res.json(result);

    } catch (e) {
        console.error('Recent chats error:', e.message);

        res.status(500).json({
            error: 'Unable to load recent chats.'
        });
    }
});

// Message History
app.get('/api/messages/:userId', auth, async (req, res) => {
    try {
        const other = req.params.userId;

        if (!validId(other)) {
            return res.status(400).json({
                error: 'Invalid user ID.'
            });
        }

        const msgs = await Message.find({
            ...conversationQuery(req.user._id, other),
            deletedForEveryone: { $ne: true },
            deletedFor: { $ne: req.user._id }
        })
            .sort({ createdAt: 1 })
            .limit(300);

        // FSM: Sent -> Read
        const unread = await Message.find({
            sender: other,
            receiver: req.user._id,
            status: 'sent'
        });

        for (const message of unread) {
            transitionStatus(message, 'read');
        }

        if (unread.length) {
            await Message.bulkSave(unread);

            io.to(String(other)).emit('messages-read', {
                reader: String(req.user._id),
                ids: unread.map(m => m._id)
            });
        }

        res.json(msgs);

    } catch (e) {
        console.error('Message history error:', e.message);

        res.status(400).json({
            error: 'Unable to load messages.'
        });
    }
});

// Upload Image / File
app.post(
    '/api/upload/:receiverId',
    auth,
    upload.single('file'),
    async (req, res) => {
        try {
            const receiver = req.params.receiverId;

            if (!validId(receiver) || receiver === String(req.user._id)) {
                return res.status(400).json({
                    error: 'Invalid recipient.'
                });
            }

            const recipient = await User.findById(receiver);

            if (!recipient) {
                return res.status(404).json({
                    error: 'Recipient not found.'
                });
            }

            if (!req.file) {
                return res.status(400).json({
                    error: 'Choose a file to upload.'
                });
            }

            if (!gridFSBucket) {
                return res.status(503).json({
                    error: 'File storage is not ready.'
                });
            }

            const allowedTypes = [
                'image/jpeg',
                'image/png',
                'image/gif',
                'image/webp',
                'application/pdf',
                'text/plain',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-powerpoint',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            ];

            if (!allowedTypes.includes(req.file.mimetype)) {
                return res.status(400).json({
                    error: 'This file type is not supported.'
                });
            }

            const fileId = new mongoose.Types.ObjectId();

            const stream = gridFSBucket.openUploadStreamWithId(
                fileId,
                req.file.originalname,
                {
                    contentType: req.file.mimetype,
                    metadata: {
                        uploadedBy: String(req.user._id),
                        receiver: String(receiver)
                    }
                }
            );

            stream.end(req.file.buffer);

            await new Promise((resolve, reject) => {
                stream.on('finish', resolve);
                stream.on('error', reject);
            });

            const isImage = req.file.mimetype.startsWith('image/');

            const message = await Message.create({
                sender: req.user._id,
                receiver,
                text: '',
                attachment: {
                    url: `/api/files/${fileId}`,
                    originalName: req.file.originalname,
                    mimeType: req.file.mimetype,
                    size: req.file.size,
                    type: isImage ? 'image' : 'file'
                },
                status: 'sent',
                statusHistory: [
                    { status: 'pending' },
                    { status: 'sent' }
                ]
            });

            const payload = {
                _id: message._id,
                sender: String(req.user._id),
                receiver,
                text: '',
                attachment: message.attachment,
                status: message.status,
                createdAt: message.createdAt
            };

            io.to(receiver).emit('private-message', payload);
            io.to(String(req.user._id)).emit('private-message', payload);

            res.status(201).json({
                ok: true,
                message: payload
            });

        } catch (e) {
            console.error('Upload error:', e.message);

            res.status(500).json({
                error: 'File upload failed.'
            });
        }
    }
);

// Download / View File
app.get('/api/files/:fileId', auth, async (req, res) => {
    try {
        if (!validId(req.params.fileId) || !gridFSBucket) {
            return res.status(404).json({
                error: 'File not found.'
            });
        }

        const fileId = new mongoose.Types.ObjectId(req.params.fileId);

        const files = await mongoose.connection.db
            .collection('uploads.files')
            .find({ _id: fileId })
            .toArray();

        if (!files.length) {
            return res.status(404).json({
                error: 'File not found.'
            });
        }

        const file = files[0];
        const owner = file.metadata?.uploadedBy;
        const receiver = file.metadata?.receiver;

        if (
            String(req.user._id) !== owner &&
            String(req.user._id) !== receiver
        ) {
            return res.status(403).json({
                error: 'You cannot access this file.'
            });
        }

        res.setHeader(
            'Content-Type',
            file.contentType || 'application/octet-stream'
        );

        res.setHeader(
            'Content-Disposition',
            `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`
        );

        gridFSBucket.openDownloadStream(fileId).pipe(res);

    } catch (e) {
        console.error('File download error:', e.message);

        res.status(500).json({
            error: 'Unable to download file.'
        });
    }
});

// Edit Message
app.patch('/api/messages/:messageId', auth, async (req, res) => {
    try {
        const messageId = req.params.messageId;
        const text = String(req.body.text || '').trim();

        if (!validId(messageId)) {
            return res.status(400).json({
                error: 'Invalid message ID.'
            });
        }

        if (!text || text.length > 2000) {
            return res.status(400).json({
                error: 'Message must contain 1–2000 characters.'
            });
        }

        const message = await Message.findOne({
            _id: messageId,
            sender: req.user._id,
            deletedForEveryone: { $ne: true }
        });

        if (!message) {
            return res.status(404).json({
                error: 'Message not found or you cannot edit it.'
            });
        }

        message.text = text;
        message.editedAt = new Date();

        await message.save();

        const payload = {
            _id: message._id,
            text: message.text,
            editedAt: message.editedAt
        };

        io.to(String(message.receiver)).emit('message-updated', payload);
        io.to(String(message.sender)).emit('message-updated', payload);

        res.json({
            ok: true,
            message
        });

    } catch (e) {
        console.error('Edit message error:', e.message);

        res.status(500).json({
            error: 'Unable to edit message.'
        });
    }
});

// Delete Message
app.delete('/api/messages/:messageId', auth, async (req, res) => {
    try {
        const messageId = req.params.messageId;
        const mode = req.query.mode || 'me';

        if (!validId(messageId)) {
            return res.status(400).json({
                error: 'Invalid message ID.'
            });
        }

        const message = await Message.findOne({
            _id: messageId,
            $or: [
                { sender: req.user._id },
                { receiver: req.user._id }
            ]
        });

        if (!message) {
            return res.status(404).json({
                error: 'Message not found.'
            });
        }

        if (mode === 'everyone') {
            if (String(message.sender) !== String(req.user._id)) {
                return res.status(403).json({
                    error: 'Only the sender can delete this message for everyone.'
                });
            }

            message.deletedForEveryone = true;
            message.deletedAt = new Date();

            await message.save();

            const payload = {
                messageId: String(message._id),
                deletedForEveryone: true
            };

            io.to(String(message.sender)).emit('message-deleted', payload);
            io.to(String(message.receiver)).emit('message-deleted', payload);

        } else if (mode === 'me') {
            if (!message.deletedFor.some(
                id => String(id) === String(req.user._id)
            )) {
                message.deletedFor.push(req.user._id);
            }

            await message.save();

            io.to(String(req.user._id)).emit('message-deleted', {
                messageId: String(message._id),
                deletedForMe: true
            });

        } else {
            return res.status(400).json({
                error: 'Invalid delete mode.'
            });
        }

        res.json({
            ok: true,
            message: 'Message deleted.'
        });

    } catch (e) {
        console.error('Delete message error:', e.message);

        res.status(500).json({
            error: 'Unable to delete message.'
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
// Existing FSM is preserved:
// Pending -> Sent -> Read
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

    // PRIVATE MESSAGE + REPLY + EMAIL NOTIFICATION
    socket.on('private-message', async (data, ack = () => { }) => {
        try {
            const receiver = String(data?.receiver || '');
            const text = String(data?.text || '').trim();
            const replyTo = data?.replyTo || null;

            if (
                !validId(receiver) ||
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

            if (replyTo && !validId(replyTo)) {
                return ack({
                    ok: false,
                    error: 'Invalid reply message.'
                });
            }

            if (replyTo) {
                const original = await Message.findOne({
                    _id: replyTo,
                    ...conversationQuery(uid, receiver),
                    deletedForEveryone: { $ne: true }
                });

                if (!original) {
                    return ack({
                        ok: false,
                        error: 'Original message not found.'
                    });
                }
            }

            const recipient = await User.findById(receiver);

            if (!recipient) {
                return ack({
                    ok: false,
                    error: 'Recipient not found.'
                });
            }

            const message = await Message.create({
                sender: uid,
                receiver,
                text,
                replyTo,
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
                replyTo: message.replyTo,
                status: message.status,
                statusHistory: message.statusHistory,
                createdAt: message.createdAt
            };

            io.to(receiver).emit('private-message', payload);
            io.to(uid).emit('private-message', payload);

            ack({
                ok: true,
                message: payload
            });

            // Email notification
            const sender = await User.findById(uid)
                .select('username');

            if (recipient.email && sender) {
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
            if (!validId(senderId)) {
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

            io.to(String(senderId)).emit('messages-read', {
                reader: uid,
                ids: unread.map(m => m._id)
            });

        } catch (e) {
            console.error('Mark read error:', e.message);
        }
    });

    // Message Delivered Notification
    socket.on('message-delivered', async ({ messageId } = {}) => {
        try {
            if (!validId(messageId)) return;

            const message = await Message.findOne({
                _id: messageId,
                receiver: uid
            });

            if (!message) return;

            message.deliveredAt = new Date();
            await message.save();

            io.to(String(message.sender)).emit('message-delivered', {
                messageId: String(message._id),
                deliveredAt: message.deliveredAt
            });

        } catch (e) {
            console.error('Delivery status error:', e.message);
        }
    });

    // Receive Message Update Events
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

    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            error: err.code === 'LIMIT_FILE_SIZE'
                ? 'File size must be 10 MB or less.'
                : 'File upload error.'
        });
    }

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

    if (!JWT_SECRET) {
        console.error('JWT_SECRET is required.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);

    gridFSBucket = new mongoose.mongo.GridFSBucket(
        mongoose.connection.db,
        { bucketName: 'uploads' }
    );

    console.log('MongoDB connected');
    console.log('GridFS file storage initialized');

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
