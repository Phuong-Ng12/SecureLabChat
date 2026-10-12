const express = require('express');
const http = require('http');
const {
    Server
} = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.send('<h1>Admin dashboard placeholder</h1>');
});

const ROOMS = ['#general', '#announcements'];

// Server-side posting rules (the browser check is only cosmetic)
function canPost(role, room) {
    if (room === '#announcements') return role === 'Manager' || role === 'Admin';
    if (room === '#general') return ['Manager', 'Admin', 'Supervisor'].includes(role);
    return false;
}

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    const session = {
        authenticated: false,
        name: null,
        role: null
    };

    socket.on('authenticate', (credentials) => {
        if (!credentials || typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
            socket.emit('authenticated', {
                success: false,
                error: 'Invalid login payload.'
            });
            return;
        }

        const hash = crypto.createHash('sha256').update(credentials.password).digest('hex');

        db.get(
            `SELECT username, role FROM users WHERE username = ? AND password_hash = ?`,
            [credentials.username.trim(), hash],
            (err, userRow) => {
                if (err) {
                    console.error('SQL Auth Error:', err.message);
                    socket.emit('authenticated', {
                        success: false,
                        error: 'Database verification failure.'
                    });
                    return;
                }
                if (!userRow) {
                    socket.emit('authenticated', {
                        success: false,
                        error: 'Access Denied: Invalid credentials.'
                    });
                    return;
                }

                session.authenticated = true;
                session.name = userRow.username;
                session.role = userRow.role;

                console.log(`[AUTH] ${session.name} logged in as ${session.role}`);
                socket.emit('authenticated', {
                    success: true,
                    name: session.name,
                    role: session.role
                });
            }
        );
    });

    socket.on('join_room', (room) => {
        if (!session.authenticated || !ROOMS.includes(room)) return;

        socket.join(room);
        console.log(`${session.name} joined ${room}`);

        db.all(
            `SELECT id, user, role, encrypted_text, timestamp FROM messages WHERE room = ? ORDER BY id ASC`,
            [room],
            (err, rows) => {
                if (err) {
                    console.error('History error:', err.message);
                    return;
                }
                socket.emit('load_history', rows || []);
            }
        );
    });

    socket.on('leave_room', (room) => {
        socket.leave(room);
    });

    socket.on('chat_message', (data) => {
        if (!session.authenticated || !data) return;

        const {
            room
        } = data;
        const text = typeof data.text === 'string' ? data.text.trim().slice(0, 1000) : '';

        if (!ROOMS.includes(room) || !text) return;

        if (!canPost(session.role, room)) {
            socket.emit('security_alert', 'You do not have permission to post in this channel.');
            return;
        }

        const timestamp = new Date().toLocaleTimeString();

        db.run(
            `INSERT INTO messages (room, user, role, encrypted_text, timestamp) VALUES (?, ?, ?, ?, ?)`,
            [room, session.name, session.role, text, timestamp],
            function (err) {
                if (err) {
                    console.error('Insert error:', err.message);
                    return;
                }
                io.to(room).emit('chat_message', {
                    id: this.lastID,
                    room,
                    user: session.name,
                    role: session.role,
                    encrypted_text: text,
                    timestamp
                });
            }
        );
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});