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

// Duration of valid token (e.g. a clinic shift)
const SESSION_HOURS = 12;

// Only hashed token is stored in db
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Query a user with their department. Login handler also uses this string
const USER_SELECT = `SELECT u.id, u.username, u.role, u.department_id, d.name AS department
                     FROM users u LEFT JOIN departments d ON d.id = u.department_id`;

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
        userId: null,
        name: null,
        role: null,
        departmentId: null,
        department: null
    };

    function startSession(userRow) {
        session.authenticated = true;
        session.userId = userRow.id;
        session.name = userRow.username;
        session.role = userRow.role;
        session.departmentId = userRow.department_id;
        session.department = userRow.department;
    }

    function sendAuthenticated(token, expiresAt, resumed = false) {
        socket.emit('authenticated', {
            success: true,
            name: session.name,
            role: session.role,
            department: session.department,
            token,
            expiresAt,
            resumed
        });
    }

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
            `${USER_SELECT} WHERE u.username = ? AND u.password_hash = ?`,
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

                // create a random token that is valid for SESSION_HOURS
                const token = crypto.randomBytes(32).toString('hex');
                const now = new Date();
                const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000).toISOString();

                db.run(
                    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
                    [hashToken(token), userRow.id, now.toISOString(), expiresAt],
                    (insertErr) => {
                        if (insertErr) {
                            console.error('Session insert error:', insertErr.message);
                            socket.emit('authenticated', {
                                success: false,
                                error: 'Could not start a session.'
                            });
                            return;
                        }

                        startSession(userRow);
                        console.log(`[AUTH] ${session.name} logged in as ${session.role}`);
                        sendAuthenticated(
                            token,
                            expiresAt
                        );
                    }
                );
            }
        );
    });

    // The browser sends the saved token on page load. Only a valid,
    // unexpired token skips the login form.
    socket.on('resume_session', (token) => {
        const reject = (error) => socket.emit('authenticated', {
            success: false,
            resume: true,
            error
        });

        if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
            reject('Invalid session. Please log in.');
            return;
        }

        const tokenHash = hashToken(token);

        db.get(
            `SELECT s.expires_at, u.id, u.username, u.role, u.department_id, d.name AS department
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             LEFT JOIN departments d ON d.id = u.department_id
             WHERE s.token_hash = ?`,
            [tokenHash],
            (err, row) => {
                if (err) {
                    console.error('Resume error:', err.message);
                    reject('Database verification failure.');
                    return;
                }
                if (!row) {
                    reject('Session not found. Please log in.');
                    return;
                }
                if (new Date(row.expires_at) <= new Date()) {
                    db.run(`DELETE FROM sessions WHERE token_hash = ?`, [tokenHash]);
                    reject('Session expired. Please log in again.');
                    return;
                }

                // role and department come from the users table, not from the browser
                startSession(row);
                console.log(`[RESUME] ${session.name} (${session.role})`);
                sendAuthenticated(
                    token,
                    row.expires_at,
                    true
                );
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

        const timestamp = new Date().toISOString();

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

    socket.on('logout', () => {
        ROOMS.forEach((room) => socket.leave(room));
        session.authenticated = false;
        session.userId = null;
        session.name = null;
        session.role = null;
        session.departmentId = null;
        session.department = null;
        console.log(`[LOGOUT] socket ${socket.id}`);
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});