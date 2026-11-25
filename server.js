const express = require('express');
const http = require('http');
const {
    Server
} = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');
const { hashPassword, verifyPassword, isLegacyHash, hashToken } = require('./lib/passwords');
const { ROOMS, ROLES, departmentRoom, canPost } = require('./lib/permissions');
const { createLoginLimiter } = require('./lib/loginLimiter');

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

// const ROOMS = ['#general', '#announcements'];

// Every logged-in socket joins this room, so a new announcement can reach people who
// are reading another channel. It is not a channel and never shown to users.
const SIGNED_IN_ROOM = 'signed-in-users';

// A department channel has primary key which is the department id, so two similar names can
// never clash. The visible name comes from the departments table.
// function departmentRoom(departmentId) {
//     return `#dept-${departmentId}`;
// }

// 5 failed logins for a username blocks that username for 5 minutes.
// LOCKOUT_MS can shorten the lock for testing.
const loginLimiter = createLoginLimiter({
    maxFailures: 5,
    lockMs: Number(process.env.LOCKOUT_MS) || 5 * 60 * 1000
});

// Duration of valid token (e.g. a clinic shift)
const SESSION_HOURS = 12;

// Messages older than this are no longer shown (and will be deleted by the cleanup)
const RETENTION_HOURS = 72;

// const ROLES = ['Admin', 'Manager', 'Supervisor', 'Staff'];

// Same hashing for login and for accounts created by an admin
// function hashPassword(password) {
//     return crypto.createHash('sha256').update(password).digest('hex');
// }

// Only hashed token is stored in db
// function hashToken(token) {
//     return crypto.createHash('sha256').update(token).digest('hex');
// }

// Query a user with their department. Login handler also uses this string
const USER_SELECT = `SELECT u.id, u.username, u.password_hash, u.role, u.department_id, d.name AS department
                     FROM users u LEFT JOIN departments d ON d.id = u.department_id`;

// Server-side posting rules (the browser check is only cosmetic)
// function canPost(role, room, departmentId) {
//     if (room === '#announcements') return role === 'Manager' || role === 'Admin';
//     if (room === '#general') return ['Manager', 'Admin', 'Supervisor'].includes(role);

//     // department channel: only a Supervisor, and only in their own department
//     if (departmentId != null && room === departmentRoom(departmentId)) {
//         return role === 'Supervisor';
//     }
//     return false;
// }

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
        socket.data.userId = userRow.id;
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

    // Refresh permissions for this account even if the user is already signed in.
    socket.data.refreshUser = (user) => {
        if (session.userId !== user.id) return;
        if (session.departmentId != null && session.departmentId !== user.departmentId) {
            socket.leave(departmentRoom(session.departmentId));
        }
        session.role = user.role;
        session.departmentId = user.departmentId;
        session.department = user.department;
        sendAuthenticated(undefined, undefined, true);
    };

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
        // const hash = hashPassword(credentials.password);

        // A locked username gets the same generic error as a wrong password, and the
        // password is not even checked, so the lock cannot be used to test guesses.
        if (loginLimiter.isLocked(credentials.username)) {
            console.warn(`[AUTH] login blocked for "${credentials.username.trim()}" (too many failures)`);
            socket.emit('authenticated', {
                success: false,
                error: 'Access Denied: Invalid credentials.'
            });
            return;
        }

        db.get(
            // The salt is stored inside password_hash, so the row is found by username
            // and the password is checked afterwards.
           `${USER_SELECT} WHERE u.username = ?`,
            [credentials.username.trim()],
            (err, userRow) => {
                if (err) {
                    console.error('SQL Auth Error:', err.message);
                    socket.emit('authenticated', {
                        success: false,
                        error: 'Database verification failure.'
                    });
                    return;
                }
                if (!userRow || !verifyPassword(credentials.password, userRow.password_hash)) {
                    loginLimiter.recordFailure(credentials.username);
                    socket.emit('authenticated', {
                        success: false,
                        error: 'Access Denied: Invalid credentials.'
                    });
                    return;
                }

                loginLimiter.reset(credentials.username);
                
                // an account made before salting is upgraded the first time it logs in
                if (isLegacyHash(userRow.password_hash)) {
                    db.run(`UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?`,
                        [hashPassword(credentials.password), userRow.id, userRow.password_hash]);
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

    // Apply the same name rules when creating or renaming a department.
    function readDepartmentName(action, data) {
        const name = data && typeof data.name === 'string' ? data.name.trim() : '';
        if (!name) {
            adminResult(action, false, { error: 'Department name is required.' });
            return null;
        }
        if (name.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(name)) {
            adminResult(action, false, {
                error: 'Use up to 40 letters, numbers, spaces or hyphens.'
            });
            return null;
        }
        return name;
    }

    socket.on('create_department', (data) => {
        if (!requireAdmin('create_department')) return;

        const name = readDepartmentName('create_department', data);
        if (!name) return;

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

    socket.on('update_department', (data) => {
        const action = 'update_department';
        if (!requireAdmin(action)) return;

        const id = data?.id;
        if (!Number.isSafeInteger(id) || id < 1) {
            adminResult(action, false, { error: 'Choose a valid department.' });
            return;
        }
        const name = readDepartmentName(action, data);
        if (!name) return;

        // The room uses the department ID, so renaming keeps its users and chat history.
        db.run(`UPDATE departments SET name = ? WHERE id = ?`, [name, id], function (err) {
            if (err) {
                const duplicate = err.code === 'SQLITE_CONSTRAINT';
                if (!duplicate) console.error('Update department error:', err.message);
                adminResult(action, false, {
                    error: duplicate ? 'That department already exists.' : 'Database failure.'
                });
                return;
            }
            if (!this.changes) {
                adminResult(action, false, { error: 'That department does not exist.' });
                return;
            }
            console.log(`[ADMIN] ${session.name} renamed department ${id} to ${name}`);
            adminResult(action, true, { department: { id, name } });
        });
    });

    socket.on('delete_department', (data) => {
        const action = 'delete_department';
        if (!requireAdmin(action)) return;

        const id = data?.id;
        if (!Number.isSafeInteger(id) || id < 1) {
            adminResult(action, false, { error: 'Choose a valid department.' });
            return;
        }

        // SQLite checks users.department_id during the delete, so a department with users stays in place.
        db.run(`DELETE FROM departments WHERE id = ?`, [id], function (err) {
            if (err) {
                const hasUsers = err.code === 'SQLITE_CONSTRAINT' && err.message.includes('FOREIGN KEY');
                if (!hasUsers) console.error('Delete department error:', err.message);
                adminResult(action, false, {
                    error: hasUsers ? 'Move users to another department before deleting this one.' : 'Database failure.'
                });
                return;
            }
            if (!this.changes) {
                adminResult(action, false, { error: 'That department does not exist.' });
                return;
            }
            console.log(`[ADMIN] ${session.name} deleted department ${id}`);
            adminResult(action, true, { department: { id } });
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

    socket.on('update_user', (data) => {
        const action = 'update_user';
        if (!requireAdmin(action)) return;

        const fail = (error) => adminResult(action, false, { error });
        if (!data || !Number.isSafeInteger(data.id) || data.id < 1) {
            return fail('Choose a user to update.');
        }

        const { id, role, password } = data;
        const hasDepartment = data.departmentId !== undefined;
        if (role === undefined && password === undefined && !hasDepartment) {
            return fail('Provide a role, department or password to update.');
        }
        if (role !== undefined && !ROLES.includes(role)) return fail('Unknown role.');
        if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
            return fail('Password must be at least 8 characters.');
        }
        if (hasDepartment && (!Number.isSafeInteger(data.departmentId) || data.departmentId < 1)) {
            return fail('Choose a valid department.');
        }

        db.get(`SELECT role, department_id FROM users WHERE id = ?`, [id], (err, current) => {
            if (err) {
                console.error('Update user lookup error:', err.message);
                return fail('Database failure.');
            }
            if (!current) return fail('That user does not exist.');

            // Keep the same department rules as create_user.
            const nextRole = role ?? current.role;
            const needsDepartment = nextRole === 'Supervisor' || nextRole === 'Staff';
            let departmentId = current.department_id;
            if (role !== undefined || hasDepartment) {
                if (!needsDepartment && hasDepartment) return fail('This role does not belong to a department.');
                departmentId = needsDepartment ? (data.departmentId ?? departmentId) : null;
                if (needsDepartment && departmentId == null) return fail('Choose a department for this role.');
            }

            // SQLite checks the department foreign key. The old values prevent overwriting
            // a role or department that another admin changed while this request was waiting.
            db.get(
                `UPDATE users SET role = ?, department_id = ?, password_hash = COALESCE(?, password_hash)
                 WHERE id = ? AND role = ? AND department_id IS ?
                 RETURNING id, username, role, department_id AS departmentId,
                           (SELECT name FROM departments WHERE id = users.department_id) AS department`,
                [nextRole, departmentId, password === undefined ? null : hashPassword(password),
                    id, current.role, current.department_id],
                (updateErr, user) => {
                    if (updateErr) {
                        if (updateErr.code === 'SQLITE_CONSTRAINT' && updateErr.message.includes('FOREIGN KEY')) {
                            return fail('That department does not exist.');
                        }
                        console.error('Update user error:', updateErr.message);
                        return fail('Database failure.');
                    }
                    if (!user) return fail('This user changed. Please try again.');

                    console.log(`[ADMIN] ${session.name} updated user ${user.username}`);
                    adminResult(action, true, { user });
                    if (user.role !== current.role || user.departmentId !== current.department_id) {
                        for (const connectedSocket of io.sockets.sockets.values()) {
                            connectedSocket.data.refreshUser(user);
                        }
                    }
                }
            );
        });
    });

    socket.on('delete_user', (data) => {
        const action = 'delete_user';
        if (!requireAdmin(action)) return;

        const fail = (error) => adminResult(action, false, { error });
        if (!data || !Number.isSafeInteger(data.id) || data.id < 1) {
            return fail('Choose a user to delete.');
        }

        const { id } = data;
        const adminId = session.userId;
        if (id === adminId) return fail('You cannot delete your own account.');

        // Check both admin roles in the delete itself. SQLite removes the user's sessions with it.
        db.run(
            `DELETE FROM users
             WHERE id = ?
               AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'Admin')
               AND (role IS NOT 'Admin' OR EXISTS (SELECT 1 FROM users WHERE id <> ? AND role = 'Admin'))`,
            [id, adminId, id],
            function (err) {
                if (err) {
                    console.error('Delete user error:', err.message);
                    return fail('Database failure.');
                }
                if (!this.changes) return fail('User not found or deletion is not allowed. The last admin cannot be deleted.');

                for (const connectedSocket of io.sockets.sockets.values()) {
                    if (connectedSocket.data.userId !== id) continue;
                    connectedSocket.emit('authenticated', {
                        success: false,
                        resume: true,
                        error: 'Your account was deleted.'
                    });
                    // Close the transport so the browser can reconnect at the login screen.
                    connectedSocket.conn.close();
                }

                console.log(`[ADMIN] ${session.name} deleted user ${id}`);
                adminResult(action, true, { user: { id } });
            }
        );
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
        socket.data.userId = null;
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

// Timers and the listening port start only when this file is run directly (npm start),
// so a test can require this file without starting anything.
function start(port = process.env.PORT || 3000) {
    // first run after the database has finished its setup, then on a schedule
    setTimeout(runCleanup, 5000);
    setInterval(runCleanup, CLEANUP_INTERVAL_MS);

    server.listen(port, '0.0.0.0', () => {
        console.log(`Server running on port ${port}`);
    });
}

if (require.main === module) {
    start();
}

module.exports = { app, server, io, start, runCleanup };
