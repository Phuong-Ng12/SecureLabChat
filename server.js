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

// Serve the static frontend file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.send('<h1>Admin dashboard placeholder</h1>');
});

// Socket.io connection logic
io.on('connection', (socket) => {
    console.log(`New connection handshake on socket: ${socket.id}`);

    let session = {
        name: 'Anonymous',
        role: 'Staff'
    };

    // Listen for incoming messages from a client
    // socket.on('chat_message', (data) => {
    //     // Broadcast the message to EVERY connected user in the lab
    //     io.emit('chat_message', {
    //         user: data.user,
    //         text: data.text,
    //         time: new Date().toLocaleTimeString()
    //     });
    // });

    socket.on('authenticate', (credentials) => {
        try {
            const hash = crypto.createHash('sha256').update(credentials.password).digest('hex');

            db.get(`SELECT username, role FROM users WHERE username = ? AND password_hash = ?`,
                [credentials.username, hash],
                (err, userRow) => {
                    if (err) {
                        console.error('SQL Auth Error:', err.message);
                        socket.emit('authenticated', {
                            success: false,
                            error: 'Database verification failure.'
                        });
                        return;
                    }

                    if (userRow) {
                        session.name = userRow.username;
                        session.role = userRow.role;

                        // Respond back to browser UI
                        socket.emit('authenticated', {
                            success: true,
                            name: userRow.username,
                            role: userRow.role
                        });
                        console.log(`[AUTH DETECTED] ${session.name} authenticated into room with role context: ${session.role}`);

                        // Auto-join base landing channel on successful login
                        socket.join('#general');
                    } else {
                        socket.emit('authenticated', {
                            success: false,
                            error: 'Access Denied: Invalid credentials.'
                        });
                    }
                }
            );

        } catch (error) {
            console.error('Authentication error: ', error.message);
            socket.emit('authenticated', { success: false, error: 'Internal server error processing payload.' });
        }

    });


    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

const PORT = 3000;
// CRITICAL: Bind to 0.0.0.0 so it listens to external LAN devices, not just localhost
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running! Tell your lab peers to visit: http://<YOUR_LAPTOP_IP>:${PORT}`);
});