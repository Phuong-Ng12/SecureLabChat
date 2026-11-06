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

// The admin dashboard is a view inside the same page. The page itself holds no data:
// every admin action is checked on the server (create_department, create_user).
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const ROOMS = ['#general', '#announcements'];

// Every logged-in socket joins this room, so a new announcement can reach people who
// are reading another channel. It is not a channel and never shown to users.
const SIGNED_IN_ROOM = 'signed-in-users';

// A department channel has primary key which is the department id, so two similar names can
// never clash. The visible name comes from the departments table.
function departmentRoom(departmentId) {
    return `#dept-${departmentId}`;
}

// Duration of valid token (e.g. a clinic shift)
const SESSION_HOURS = 12;

// Messages older than this are no longer shown (and will be deleted by the cleanup)
const RETENTION_HOURS = 72;

const ROLES = ['Admin', 'Manager', 'Supervisor', 'Staff'];

// Same hashing for login and for accounts created by an admin
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Only hashed token is stored in db
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Query a user with their department. Login handler also uses this string
const USER_SELECT = `SELECT u.id, u.username, u.role, u.department_id, d.name AS department
                     FROM users u LEFT JOIN departments d ON d.id = u.department_id`;

// Server-side posting rules (the browser check is only cosmetic)
function canPost(role, room, departmentId) {
    if (room === '#announcements') return role === 'Manager' || role === 'Admin';
    if (room === '#general') return ['Manager', 'Admin', 'Supervisor'].includes(role);

    // department channel: only a Supervisor, and only in their own department
    if (departmentId != null && room === departmentRoom(departmentId)) {
        return role === 'Supervisor';
    }
    return false;
}

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    const session = {
        authenticated: false,
        tokenHash: null,
        userId: null,
        name: null,
        role: null,
        departmentId: null,
        department: null
    };

    function startSession(userRow, tokenHash) {
        socket.join(SIGNED_IN_ROOM);
        session.authenticated = true;
        session.tokenHash = tokenHash;
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
            channels: allowedChannels(), 
            token,
            expiresAt,
            resumed
        });
    }

    // Every channel this user may open, and whether they may post in it.
    // Used to build the sidebar AND to check join_room, so they always agree.
    function allowedChannels() {
        const channels = ROOMS.map((room) => ({
            room,
            label: room,
            canPost: canPost(session.role, room, session.departmentId)
        }));

        if (session.departmentId != null) {
            const room = departmentRoom(session.departmentId);
            channels.push({
                room,
                label: `#${session.department}`,
                canPost: canPost(session.role, room, session.departmentId)
            });
        }
        return channels;
    }

    socket.on('authenticate', (credentials) => {
        if (!credentials || typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
            socket.emit('authenticated', {
                success: false,
                error: 'Invalid login payload.'
            });
            return;
        }

        // const hash = crypto.createHash('sha256').update(credentials.password).digest('hex');
        const hash = hashPassword(credentials.password);

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

                        // startSession(userRow);
                        startSession(userRow, hashToken(token));
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
                // startSession(row);
                startSession(row, tokenHash);
                console.log(`[RESUME] ${session.name} (${session.role})`);
                sendAuthenticated(
                    token,
                    row.expires_at,
                    true
                );
            }
        );
    });

    // ---------- Admin events ----------

    // Same for every admin result so the dashboard needs one listener
    function adminResult(action, success, payload) {
        socket.emit('admin_result', { action, success, ...payload });
    }

    // The role always comes from the server-side session, never from the browser
    function requireAdmin(action) {
        if (session.authenticated && session.role === 'Admin') return true;
        adminResult(action, false, { error: 'Only admins can do this.' });
        return false;
    }

    socket.on('list_departments', () => {
        if (!requireAdmin('list_departments')) return;

        db.all(`SELECT id, name FROM departments ORDER BY name`, [], (err, rows) => {
            if (err) {
                console.error('List departments error:', err.message);
                adminResult('list_departments', false, { error: 'Database failure.' });
                return;
            }
            adminResult('list_departments', true, { departments: rows });
        });
    });

    socket.on('create_department', (data) => {
        if (!requireAdmin('create_department')) return;

        const name = data && typeof data.name === 'string' ? data.name.trim() : '';
        if (!name) {
            adminResult('create_department', false, { error: 'Department name is required.' });
            return;
        }
        if (name.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(name)) {
            adminResult('create_department', false, {
                error: 'Use up to 40 letters, numbers, spaces or hyphens.'
            });
            return;
        }

        // departments.name is UNIQUE and case-insensitive, so a duplicate fails here
        db.run(`INSERT INTO departments (name) VALUES (?)`, [name], function (err) {
            if (err) {
                const duplicate = err.code === 'SQLITE_CONSTRAINT';
                if (!duplicate) console.error('Create department error:', err.message);
                adminResult('create_department', false, {
                    error: duplicate ? 'That department already exists.' : 'Database failure.'
                });
                return;
            }
            console.log(`[ADMIN] ${session.name} created department ${name}`);
            adminResult('create_department', true, { department: { id: this.lastID, name } });
        });
    });

    socket.on('create_user', (data) => {
        if (!requireAdmin('create_user')) return;

        const fail = (error) => adminResult('create_user', false, { error });

        if (!data || typeof data.username !== 'string' || typeof data.password !== 'string' ||
            typeof data.role !== 'string') {
            fail('Username, password and role are required.');
            return;
        }

        const username = data.username.trim();
        const { password, role } = data;

        if (!username || username.length > 50) {
            fail('Username must be 1 to 50 characters.');
            return;
        }
        if (password.length < 8) {
            fail('Password must be at least 8 characters.');
            return;
        }
        if (!ROLES.includes(role)) {
            fail('Unknown role.');
            return;
        }

        // Supervisors and Staff belong to a department. Admin and Manager are company-wide.
        const needsDepartment = role === 'Supervisor' || role === 'Staff';
        const departmentId = needsDepartment ? Number(data.departmentId) : null;

        if (needsDepartment && !Number.isInteger(departmentId)) {
            fail('Choose a department for this role.');
            return;
        }

        const insertUser = (departmentName) => {
            // usernames are compared without case so "staff" cannot shadow "Staff"
            db.get(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`, [username], (err, existing) => {
                if (err) {
                    console.error('Create user lookup error:', err.message);
                    fail('Database failure.');
                    return;
                }
                if (existing) {
                    fail('That username is already taken.');
                    return;
                }

                db.run(
                    `INSERT INTO users (username, password_hash, role, department_id) VALUES (?, ?, ?, ?)`,
                    [username, hashPassword(password), role, departmentId],
                    function (insertErr) {
                        if (insertErr) {
                            const duplicate = insertErr.code === 'SQLITE_CONSTRAINT';
                            if (!duplicate) console.error('Create user error:', insertErr.message);
                            fail(duplicate ? 'That username is already taken.' : 'Database failure.');
                            return;
                        }
                        console.log(`[ADMIN] ${session.name} created user ${username} (${role})`);
                        // the password hash is never sent back
                        adminResult('create_user', true, {
                            user: { id: this.lastID, username, role, department: departmentName }
                        });
                    }
                );
            });
        };

        if (!needsDepartment) {
            insertUser(null);
            return;
        }

        db.get(`SELECT name FROM departments WHERE id = ?`, [departmentId], (err, dept) => {
            if (err) {
                console.error('Create user department error:', err.message);
                fail('Database failure.');
                return;
            }
            if (!dept) {
                fail('That department does not exist.');
                return;
            }
            insertUser(dept.name);
        });
    });

    socket.on('join_room', (room) => {
        if (!session.authenticated) return;

        // same answer for "other department" and "does not exist", so nothing leaks
        if (typeof room !== 'string' || !allowedChannels().some((c) => c.room === room)) {
            socket.emit('security_alert', 'You do not have access to that channel.');
            return;
        }

        socket.join(room);
        console.log(`${session.name} joined ${room}`);

        // only messages from the last RETENTION_HOURS (timestamps are UTC ISO text)
        const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();

        db.all(
            `SELECT id, user, role, encrypted_text, timestamp
             FROM messages
             WHERE room = ? AND timestamp >= ?
             ORDER BY id ASC`,
            [room, cutoff],
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

        // the room must be one of this user's own channels (#general, #announcements,
        // or their own department), the same list that join_room checks
        const channel = allowedChannels().find((c) => c.room === room);
        if (!channel) {
            socket.emit('security_alert', 'You do not have access to that channel.');
            return;
        }
        if (!text) return;

        if (!channel.canPost) {
            socket.emit('security_alert', 'You do not have permission to post in this channel.');
            return;
        }

        // copy now, the session can change before the database answers
        const author = session.name;
        const authorRole = session.role;
        const timestamp = new Date().toISOString();

        // the room name (for example #dept-1) is saved, so each channel keeps its own history
        db.run(
            `INSERT INTO messages (room, user, role, encrypted_text, timestamp) VALUES (?, ?, ?, ?, ?)`,
            [room, author, authorRole, text, timestamp],
            function (err) {
                if (err) {
                    console.error('Insert error:', err.message);
                    return;
                }
                // only sockets that joined this room receive it, and join_room only
                // lets a department's own members in
                // io.to(room).emit('chat_message', {
                //     id: this.lastID,
                //     room,
                //     user: author,
                //     role: authorRole,
                //     encrypted_text: text,
                //     timestamp
                // });

                const saved = {
                    id: this.lastID,
                    room,
                    user: author,
                    role: authorRole,
                    encrypted_text: text,
                    timestamp
                };

                io.to(room).emit('chat_message', saved);

                // everyone signed in hears about a new announcement, whatever channel they are in
                if (room === '#announcements') {
                    io.to(SIGNED_IN_ROOM).emit('announcement', saved);
                }
            }
        );
    });

    socket.on('logout', () => {
        // end the saved login too, otherwise a refresh would sign the user back in
        if (session.tokenHash) {
            db.run(`DELETE FROM sessions WHERE token_hash = ?`, [session.tokenHash]);
        }
        
        // leave every room (general, announcements and the department room)
        [...socket.rooms].forEach((room) => {
            if (room !== socket.id) socket.leave(room);
        });

        session.authenticated = false;
        session.tokenHash = null;
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

// How often the cleanup runs (milliseconds). CLEANUP_INTERVAL_MS can shorten it for testing.
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS) || 10 * 60 * 1000;

// Remove expired login tokens
function deleteExpiredSessions() {
    db.run(`DELETE FROM sessions WHERE expires_at <= ?`, [new Date().toISOString()], function (err) {
        if (err) {
            console.error('Session cleanup error:', err.message);
        } else if (this.changes > 0) {
            console.log(`Session cleanup: removed ${this.changes} expired token(s).`);
        }
    });
}

// Remove messages older than RETENTION_HOURS from every channel, so older sensitive
// patient information does not stay in the database
function deleteOldMessages() {
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();

    db.run(`DELETE FROM messages WHERE timestamp < ?`, [cutoff], function (err) {
        if (err) {
            console.error('Message cleanup error:', err.message);
        } else if (this.changes > 0) {
            console.log(`Message cleanup: removed ${this.changes} message(s) older than ${RETENTION_HOURS} hours.`);
        }
    });
}

function runCleanup() {
    deleteExpiredSessions();
    deleteOldMessages();
}

// first run after the database has finished its setup, then on a schedule
setTimeout(runCleanup, 5000);
setInterval(runCleanup, CLEANUP_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});