const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the static frontend file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io connection logic
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Listen for incoming messages from a client
    socket.on('chat_message', (data) => {
        // Broadcast the message to EVERY connected user in the lab
        io.emit('chat_message', {
            user: data.user,
            text: data.text,
            time: new Date().toLocaleTimeString()
        });
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
