
const $ = id => document.getElementById(id);

let token = localStorage.getItem('cc_token') || '';
let me = null;
let socket = null;
let activeUser = null;
let users = [];
let chatSummaries = new Map();
let isRegister = false;
let toastTimer;
let typingTimer;
let isTyping = false;

const EMOJIS = [
    '😀', '😃', '😄', '😁', '😂', '🤣', '😊', '😍',
    '🥰', '😘', '😎', '🤔', '😢', '😭', '😡', '👍',
    '👎', '👏', '🙏', '❤️', '💕', '🔥', '🎉', '✨',
    '💯', '👌', '🙌', '🤝', '💖', '😇', '🥳', '😉'
];

const MAX_FILE_SIZE = 10 * 1024 * 1024;

// --------------------------------------------------
// COMMON HELPERS
// --------------------------------------------------

function showToast(message) {
    const toast = $('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2800);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function getId(value) {
    if (!value) return '';
    return String(value._id || value.id || value);
}

function getMessageId(message) {
    return getId(message?._id);
}

function formatTime(date) {
    if (!date) return '';
    return new Date(date).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatLastSeen(date) {
    if (!date) return 'Offline';
    return `Last seen ${new Date(date).toLocaleString()}`;
}

function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
}

function hideElement(id) {
    const element = $(id);
    if (element) element.classList.add('hidden');
}

function showElement(id) {
    const element = $(id);
    if (element) element.classList.remove('hidden');
}

// --------------------------------------------------
// API HELPER
// --------------------------------------------------

async function api(path, options = {}) {
    const headers = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
    };

    // FormData must not use application/json.
    if (!(options.body instanceof FormData) && options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(path, {
        ...options,
        headers
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }

    return data;
}

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

function setAuthMode(register) {
    isRegister = register;

    setText(
        'authTitle',
        register ? 'Create your account' : 'Welcome back'
    );

    setText(
        'authSubtitle',
        register
            ? 'Join ChatConnect and start messaging.'
            : 'Sign in to continue your conversations.'
    );

    $('usernameField')?.classList.toggle('hidden', !register);

    if ($('identifier')) {
        $('identifier').placeholder = register
            ? 'Email address'
            : 'Username or email';
    }

    setText('authSubmit', register ? 'Create account' : 'Sign in');
    setText(
        'switchLabel',
        register ? 'Already have an account?' : 'New to ChatConnect?'
    );
    setText('switchAuth', register ? 'Sign in' : 'Create account');
    setText('authError', '');
}

$('switchAuth')?.addEventListener('click', () => {
    setAuthMode(!isRegister);
});

$('authForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    setText('authError', '');

    try {
        const body = isRegister
            ? {
                username: $('username')?.value.trim(),
                email: $('identifier')?.value.trim(),
                password: $('password')?.value
            }
            : {
                identifier: $('identifier')?.value.trim(),
                password: $('password')?.value
            };

        const data = await api(
            isRegister ? '/api/register' : '/api/login',
            {
                method: 'POST',
                body: JSON.stringify(body)
            }
        );

        token = data.token;
        me = data.user;

        localStorage.setItem('cc_token', token);
        await openApp();

    } catch (error) {
        setText('authError', error.message);
    }
});

// --------------------------------------------------
// OPEN APPLICATION
// --------------------------------------------------

async function openApp() {
    hideElement('authView');
    showElement('chatView');

    try {
        me = await api('/api/me');

        setText('myName', me.username);
        setText('myAvatar', me.username[0].toUpperCase());

        connectSocket();

        await loadUsers();
        await loadChatSummaries();

    } catch (error) {
        logout();
        showToast(error.message);
    }
}

// --------------------------------------------------
// SOCKET CONNECTION
// --------------------------------------------------

function connectSocket() {
    if (socket) socket.disconnect();

    socket = io({
        auth: { token }
    });

    socket.on('connect_error', error => {
        showToast(error.message);
    });

    // New incoming or outgoing message
    socket.on('private-message', message => {
        handleIncomingMessage(message);
    });

    // Online / Offline status
    socket.on('presence', presence => {
        const user = users.find(
            item => getId(item) === getId(presence.userId)
        );

        if (user) {
            user.online = presence.online;
            user.lastSeen = presence.lastSeen;

            renderUsers();

            if (
                activeUser &&
                getId(activeUser) === getId(presence.userId)
            ) {
                updatePeerStatus(user);
            }
        }
    });

    // Read receipt
    socket.on('messages-read', data => {
        if (
            activeUser &&
            getId(data.reader) === getId(activeUser)
        ) {
            document
                .querySelectorAll('.message.mine .message-status')
                .forEach(element => {
                    element.textContent = 'Read ✓✓';
                    element.dataset.status = 'read';
                });
        }
    });

    // Message edited
    socket.on('message-updated', message => {
        updateMessageInChat(message);
    });

    // Message deleted
    socket.on('message-deleted', data => {
        const id = getId(data.messageId || data._id);
        const element = document.querySelector(
            `[data-message-id="${id}"]`
        );

        if (element) {
            if (data.deletedForEveryone) {
                element.querySelector('.bubble').textContent =
                    'This message was deleted';
                element.classList.add('deleted-message');
            } else {
                element.remove();
            }
        }
    });

    // Delivered receipt
    socket.on('message-delivered', data => {
        updateMessageStatus(data.messageId, 'Delivered ✓✓');
    });

    // Typing indicator
    socket.on('typing', data => {
        if (
            activeUser &&
            getId(data.senderId) === getId(activeUser)
        ) {
            showTypingIndicator(Boolean(data.isTyping));
        }
    });

    socket.on('connect', () => {
        if (activeUser) {
            socket.emit('join-chat', {
                userId: getId(activeUser)
            });
        }
    });
}

// --------------------------------------------------
// USERS AND RECENT CHATS
// --------------------------------------------------

async function loadUsers() {
    users = await api('/api/users');
    renderUsers();
}

async function loadChatSummaries() {
    try {
        const data = await api('/api/chats');
        const chats = Array.isArray(data) ? data : data.chats || [];

        chatSummaries.clear();

        chats.forEach(chat => {
            const user = chat.user || chat.contact || chat;
            const userId = getId(user);

            if (userId) {
                chatSummaries.set(userId, {
                    lastMessage: chat.lastMessage,
                    unreadCount: Number(chat.unreadCount || 0)
                });
            }
        });

        renderUsers();

    } catch (error) {
        // Keep the normal user list working if this endpoint
        // is not available on the current backend.
        console.warn('Chat summaries unavailable:', error.message);
    }
}

function renderUsers() {
    const search = $('searchUsers')?.value.toLowerCase() || '';
    const list = $('usersList');

    if (!list) return;

    list.innerHTML = '';

    const visibleUsers = users
        .filter(user => user.username.toLowerCase().includes(search))
        .sort((a, b) => {
            const aSummary = chatSummaries.get(getId(a));
            const bSummary = chatSummaries.get(getId(b));

            const aTime = new Date(
                aSummary?.lastMessage?.createdAt || 0
            ).getTime();

            const bTime = new Date(
                bSummary?.lastMessage?.createdAt || 0
            ).getTime();

            return bTime - aTime;
        });

    setText('userCount', users.length);

    visibleUsers.forEach(user => {
        const summary = chatSummaries.get(getId(user));
        const unread = summary?.unreadCount || 0;

        const button = document.createElement('button');

        button.className =
            'user-row' +
            (
                activeUser && getId(activeUser) === getId(user)
                    ? ' selected'
                    : ''
            );

        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        avatar.textContent = user.username[0].toUpperCase();

        const presence = document.createElement('i');
        presence.className = `presence ${user.online ? 'on' : ''}`;
        avatar.appendChild(presence);

        const info = document.createElement('span');
        info.className = 'user-info';

        const name = document.createElement('strong');
        name.textContent = user.username;

        const lastMessage = document.createElement('small');
        lastMessage.textContent =
            summary?.lastMessage?.text ||
            (user.online ? 'Online' : 'Offline');

        info.append(name, lastMessage);
        button.append(avatar, info);

        if (unread > 0) {
            const badge = document.createElement('span');
            badge.className = 'unread-badge';
            badge.textContent = unread > 99 ? '99+' : unread;
            button.appendChild(badge);
        }

        button.addEventListener('click', () => selectUser(user));

        list.appendChild(button);
    });

    if (!visibleUsers.length) {
        list.innerHTML = '<p class="no-users">No contacts found</p>';
    }
}

$('searchUsers')?.addEventListener('input', renderUsers);

// --------------------------------------------------
// SELECT CHAT
// --------------------------------------------------

function selectUser(user) {
    activeUser = user;

    hideElement('emptyChat');
    hideElement('protocolPanel');
    showElement('activeChat');

    setText('peerName', user.username);
    setText('peerAvatar', user.username[0].toUpperCase());

    updatePeerStatus(user);
    renderUsers();

    const summary = chatSummaries.get(getId(user));
    if (summary) summary.unreadCount = 0;

    loadMessages(user);

    if (socket) {
        socket.emit('join-chat', {
            userId: getId(user)
        });
    }
}

function updatePeerStatus(user) {
    const status = $('peerStatus');
    if (!status) return;

    status.textContent = user.online
        ? '● Online'
        : formatLastSeen(user.lastSeen);

    status.className = user.online ? 'online-label' : '';
}

// --------------------------------------------------
// LOAD MESSAGE HISTORY
// --------------------------------------------------

async function loadMessages(user) {
    const messages = $('messages');
    if (!messages) return;

    messages.innerHTML = '';

    try {
        const data = await api(`/api/messages/${getId(user)}`);
        const list = Array.isArray(data) ? data : data.messages || [];

        list.forEach(appendMessage);

        if (socket) {
            socket.emit('mark-read', {
                senderId: getId(user)
            });
        }

        scrollMessages();

    } catch (error) {
        showToast(error.message);
    }
}

// --------------------------------------------------
// MESSAGE RENDERING
// --------------------------------------------------

function appendMessage(message) {
    const messageId = getMessageId(message);

    if (!messageId || !me || !activeUser) return;

    if (document.querySelector(`[data-message-id="${messageId}"]`)) {
        return;
    }

    const mine = getId(message.sender) === getId(me);

    const box = document.createElement('div');
    box.className = `message ${mine ? 'mine' : 'theirs'}`;
    box.dataset.messageId = messageId;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (message.deletedForEveryone) {
        bubble.textContent = 'This message was deleted';
        box.classList.add('deleted-message');
    } else {
        if (message.replyTo) {
            const reply = document.createElement('div');
            reply.className = 'reply-preview';

            const replyText =
                message.replyTo.text ||
                message.replyTo.messageText ||
                'Original message';

            reply.textContent = `↪ ${replyText}`;
            bubble.appendChild(reply);
        }

        if (message.text) {
            const text = document.createElement('div');
            text.className = 'message-text';
            text.textContent = message.text;
            bubble.appendChild(text);
        }

        if (message.attachment) {
            renderAttachment(message.attachment, bubble);
        }
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const time = document.createElement('span');
    time.textContent = formatTime(message.createdAt);
    meta.appendChild(time);

    if (message.editedAt) {
        const edited = document.createElement('span');
        edited.className = 'edited-label';
        edited.textContent = 'Edited';
        meta.appendChild(edited);
    }

    if (mine) {
        const status = document.createElement('span');
        status.className = 'message-status';

        if (message.status === 'read') {
            status.textContent = 'Read ✓✓';
        } else if (message.deliveredAt) {
            status.textContent = 'Delivered ✓✓';
        } else {
            status.textContent = 'Sent ✓';
        }

        status.dataset.status = message.status || 'sent';
        meta.appendChild(status);
    }

    bubble.appendChild(meta);

    if (!message.deletedForEveryone) {
        const actions = createMessageActions(message, mine);
        bubble.appendChild(actions);
    }

    box.appendChild(bubble);
    $('messages')?.appendChild(box);

    scrollMessages();
}

function renderAttachment(attachment, container) {
    const fileId = attachment.fileId || attachment._id;
    if (!fileId) return;

    const url = `/api/files/${encodeURIComponent(fileId)}`;

    if (
        attachment.type === 'image' ||
        (attachment.mimeType || '').startsWith('image/')
    ) {
        const image = document.createElement('img');
        image.className = 'message-image';
        image.alt = attachment.originalName || 'Shared image';
        image.src = url;
        image.addEventListener('click', () => openAttachment(fileId));
        container.appendChild(image);
    } else {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'file-attachment';
        link.textContent = `📎 ${attachment.originalName || 'Download file'}`;

        link.addEventListener('click', () => openAttachment(fileId));
        container.appendChild(link);
    }
}

function createMessageActions(message, mine) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.textContent = '↩ Reply';
    replyButton.addEventListener('click', () => setReply(message));

    actions.appendChild(replyButton);

    if (mine) {
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.textContent = 'Edit';
        editButton.addEventListener('click', () => editMessage(message));
        actions.appendChild(editButton);
    }

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => deleteMessage(message));
    actions.appendChild(deleteButton);

    return actions;
}

function scrollMessages() {
    const messages = $('messages');
    if (messages) {
        messages.scrollTop = messages.scrollHeight;
    }
}

// --------------------------------------------------
// INCOMING MESSAGE HANDLER
// --------------------------------------------------

function handleIncomingMessage(message) {
    const senderId = getId(message.sender);
    const receiverId = getId(message.receiver);

    const belongsToActiveChat =
        activeUser &&
        (
            senderId === getId(activeUser) ||
            receiverId === getId(activeUser)
        );

    if (belongsToActiveChat) {
        appendMessage(message);

        if (receiverId === getId(me) && socket) {
            socket.emit('mark-read', {
                senderId
            });
        }
    }

    loadChatSummaries();
}

// --------------------------------------------------
// SEND TEXT MESSAGE AND REPLY
// --------------------------------------------------

let replyMessageId = null;

function setReply(message) {
    replyMessageId = getMessageId(message);

    const preview = $('replyPreview');
    if (preview) {
        preview.textContent = `Replying to: ${message.text || 'Attachment'}`;
        preview.classList.remove('hidden');
    } else {
        showToast('Reply selected. Send your message now.');
    }

    $('messageInput')?.focus();
}

function clearReply() {
    replyMessageId = null;
    hideElement('replyPreview');
    setText('replyPreview', '');
}

$('messageForm')?.addEventListener('submit', event => {
    event.preventDefault();

    const input = $('messageInput');
    const text = input?.value.trim();

    if (!text || !activeUser || !socket) return;

    const payload = {
        receiver: getId(activeUser),
        text
    };

    if (replyMessageId) {
        payload.replyTo = replyMessageId;
    }

    socket.emit('private-message', payload, result => {
        if (!result?.ok) {
            showToast(result?.error || 'Message could not be sent');
        }
    });

    input.value = '';
    clearReply();
    input.focus();
});

// --------------------------------------------------
// EDIT MESSAGE
// --------------------------------------------------

async function editMessage(message) {
    const oldText = message.text || '';
    if (!oldText) {
        showToast('Only text messages can be edited.');
        return;
    }

    const newText = prompt('Edit your message:', oldText);
    if (newText === null) return;

    const text = newText.trim();

    if (!text || text.length > 2000) {
        showToast('Message must contain 1 to 2000 characters.');
        return;
    }

    try {
        const updated = await api(
            `/api/messages/${getMessageId(message)}`,
            {
                method: 'PATCH',
                body: JSON.stringify({ text })
            }
        );

        updateMessageInChat(updated.message || updated);
        showToast('Message updated');

    } catch (error) {
        showToast(error.message);
    }
}

function updateMessageInChat(message) {
    const id = getMessageId(message);
    const element = document.querySelector(
        `[data-message-id="${id}"]`
    );

    if (!element) return;

    const textElement = element.querySelector('.message-text');

    if (textElement && message.text !== undefined) {
        textElement.textContent = message.text;
    }

    if (message.editedAt && !element.querySelector('.edited-label')) {
        const edited = document.createElement('span');
        edited.className = 'edited-label';
        edited.textContent = 'Edited';

        element.querySelector('.message-meta')?.appendChild(edited);
    }
}

// --------------------------------------------------
// DELETE MESSAGE
// --------------------------------------------------

async function deleteMessage(message) {
    const choice = prompt(
        'Type "me" to delete only for you, or "everyone" to delete for everyone:'
    );

    if (!choice) return;

    const mode = choice.trim().toLowerCase();

    if (!['me', 'everyone'].includes(mode)) {
        showToast('Enter either me or everyone.');
        return;
    }

    if (
        mode === 'everyone' &&
        getId(message.sender) !== getId(me)
    ) {
        showToast('You can delete for everyone only your own messages.');
        return;
    }

    if (!confirm(`Delete this message ${mode === 'me' ? 'for you' : 'for everyone'}?`)) {
        return;
    }

    try {
        await api(
            `/api/messages/${getMessageId(message)}?mode=${mode}`,
            { method: 'DELETE' }
        );

        const element = document.querySelector(
            `[data-message-id="${getMessageId(message)}"]`
        );

        if (mode === 'me') {
            element?.remove();
        } else if (element) {
            const bubble = element.querySelector('.bubble');
            if (bubble) {
                bubble.textContent = 'This message was deleted';
            }
            element.classList.add('deleted-message');
        }

        showToast('Message deleted');

    } catch (error) {
        showToast(error.message);
    }
}

// --------------------------------------------------
// DELIVERED STATUS
// --------------------------------------------------

function updateMessageStatus(messageId, statusText) {
    const element = document.querySelector(
        `[data-message-id="${getId(messageId)}"]`
    );

    const status = element?.querySelector('.message-status');

    if (status) {
        status.textContent = statusText;
    }
}

// --------------------------------------------------
// FILE AND IMAGE ATTACHMENTS
// --------------------------------------------------

function setupAttachmentControls() {
    const form = $('messageForm');
    if (!form) return;

    let fileInput =
        $('fileInput') ||
        $('attachmentInput') ||
        $('attachmentFile');

    if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'fileInput';
        fileInput.accept = 'image/*,.pdf,.doc,.docx,.txt,.xlsx,.csv';
        fileInput.hidden = true;
        form.appendChild(fileInput);
    }

    let attachButton =
        $('attachmentBtn') ||
        $('attachButton') ||
        $('attachmentButton');

    if (!attachButton) {
        attachButton = document.createElement('button');
        attachButton.type = 'button';
        attachButton.id = 'attachmentBtn';
        attachButton.textContent = '📎';
        attachButton.title = 'Attach a file';

        form.insertBefore(attachButton, form.firstChild);
    }

    attachButton.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;

        if (!activeUser) {
            showToast('Select a chat first.');
            fileInput.value = '';
            return;
        }

        if (file.size > MAX_FILE_SIZE) {
            showToast('Maximum file size is 10 MB.');
            fileInput.value = '';
            return;
        }

        await uploadAttachment(file);
        fileInput.value = '';
    });
}

async function uploadAttachment(file) {
    if (!activeUser) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
        showToast('Uploading file...');

        const result = await api(
            `/api/upload/${getId(activeUser)}`,
            {
                method: 'POST',
                body: formData
            }
        );

        const message = result.message || result;

        if (message._id) {
            appendMessage(message);
        }

        showToast('File uploaded successfully');

    } catch (error) {
        showToast(error.message);
    }
}

async function openAttachment(fileId) {
    try {
        const response = await fetch(
            `/api/files/${encodeURIComponent(fileId)}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        if (!response.ok) {
            throw new Error('Unable to open this attachment');
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const opened = window.open(objectUrl, '_blank');

        if (!opened) {
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = 'ChatConnect-attachment';
            link.click();
        }

        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);

    } catch (error) {
        showToast(error.message);
    }
}

// --------------------------------------------------
// EMOJI PICKER
// --------------------------------------------------

function setupEmojiPicker() {
    const form = $('messageForm');
    const input = $('messageInput');

    if (!form || !input) return;

    let emojiButton =
        $('emojiBtn') ||
        $('emojiButton');

    if (!emojiButton) {
        emojiButton = document.createElement('button');
        emojiButton.type = 'button';
        emojiButton.id = 'emojiBtn';
        emojiButton.textContent = '😊';
        emojiButton.title = 'Choose emoji';
        form.insertBefore(emojiButton, input);
    }

    let picker =
        $('emojiPicker') ||
        $('emojiPanel');

    if (!picker) {
        picker = document.createElement('div');
        picker.id = 'emojiPicker';
        picker.className = 'emoji-picker hidden';
        form.appendChild(picker);
    }

    picker.innerHTML = '';

    EMOJIS.forEach(emoji => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = emoji;
        button.className = 'emoji-option';

        button.addEventListener('click', () => {
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? input.value.length;

            input.value =
                input.value.slice(0, start) +
                emoji +
                input.value.slice(end);

            input.focus();

            const position = start + emoji.length;
            input.setSelectionRange(position, position);

            picker.classList.add('hidden');
        });

        picker.appendChild(button);
    });

    emojiButton.addEventListener('click', () => {
        picker.classList.toggle('hidden');
    });

    document.addEventListener('click', event => {
        if (
            !picker.contains(event.target) &&
            !emojiButton.contains(event.target)
        ) {
            picker.classList.add('hidden');
        }
    });
}

// --------------------------------------------------
// TYPING INDICATOR
// --------------------------------------------------

function setupTypingIndicator() {
    const input = $('messageInput');
    if (!input) return;

    input.addEventListener('input', () => {
        if (!socket || !activeUser) return;

        if (!isTyping) {
            isTyping = true;

            socket.emit('typing', {
                receiverId: getId(activeUser),
                isTyping: true
            });
        }

        clearTimeout(typingTimer);

        typingTimer = setTimeout(() => {
            isTyping = false;

            socket.emit('typing', {
                receiverId: getId(activeUser),
                isTyping: false
            });
        }, 1200);
    });
}

function showTypingIndicator(show) {
    const indicator =
        $('typingIndicator') ||
        $('typing');

    if (!indicator) return;

    indicator.textContent = show
        ? `${activeUser?.username || 'User'} is typing...`
        : '';

    indicator.classList.toggle('hidden', !show);
}

// --------------------------------------------------
// LOGOUT
// --------------------------------------------------

$('logout')?.addEventListener('click', logout);

function logout() {
    if (socket) socket.disconnect();

    socket = null;
    token = '';
    me = null;
    activeUser = null;
    users = [];

    chatSummaries.clear();

    localStorage.removeItem('cc_token');

    showElement('authView');
    hideElement('chatView');
    hideElement('activeChat');
    hideElement('protocolPanel');
    showElement('emptyChat');

    if ($('password')) $('password').value = '';

    setAuthMode(false);
}

// --------------------------------------------------
// PROTOCOL PANEL
// --------------------------------------------------

$('showProtocols')?.addEventListener('click', () => {
    hideElement('activeChat');
    hideElement('emptyChat');
    showElement('protocolPanel');
});

$('backChat')?.addEventListener('click', () => {
    hideElement('protocolPanel');

    if (activeUser) {
        showElement('activeChat');
    } else {
        showElement('emptyChat');
    }
});

async function runProtocol(path, resultId) {
    const element = $(resultId);
    if (!element) return;

    element.textContent = 'Connecting...';

    try {
        const data = await api(path, {
            method: 'POST',
            body: '{}'
        });

        element.textContent = data.message || JSON.stringify(data);
        element.className = 'result success';

    } catch (error) {
        element.textContent = error.message;
        element.className = 'result error';
    }
}

$('smtpTest')?.addEventListener('click', () => {
    runProtocol('/api/protocol/smtp-test', 'smtpResult');
});

$('pop3Test')?.addEventListener('click', () => {
    runProtocol('/api/protocol/pop3-demo', 'pop3Result');
});

$('imapTest')?.addEventListener('click', () => {
    runProtocol('/api/protocol/imap-demo', 'imapResult');
});

// --------------------------------------------------
// FLA REGULAR LANGUAGE VALIDATION
// --------------------------------------------------

$('flaCheck')?.addEventListener('click', async () => {
    const value = $('flaUsername')?.value || '';
    const result = $('flaResult');

    if (!result) return;

    result.textContent = 'Checking...';

    try {
        const data = await api('/api/fla/validate-username', {
            method: 'POST',
            body: JSON.stringify({ username: value })
        });

        result.textContent = data.valid
            ? `Accepted: "${data.input}" belongs to the defined language.`
            : `Rejected: "${data.input}" does not match the regular language.`;

        result.className = `result ${data.valid ? 'success' : 'error'}`;

    } catch (error) {
        result.textContent = error.message;
        result.className = 'result error';
    }
});

// --------------------------------------------------
// INITIALIZE
// --------------------------------------------------

setupAttachmentControls();
setupEmojiPicker();
setupTypingIndicator();

if (token) {
    openApp();
} else {
    setAuthMode(false);
}
