const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fs = require('fs');
fs.mkdirSync('./data', { recursive: true });

const DB_PATH = './data/chat.db';

// initialize SQLite database instance
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Database connection error: ', err.message);
    } else {
        console.log('Database connected securely inside Docker volume.');
        initializeAndSeedDatabase();
    }
})

function initializeAndSeedDatabase() {
    db.serialize(() => {
        // create user and role table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password_hash TEXT,
            role TEXT CHECK(role IN ('Admin', 'Manager', 'Supervisor', 'Staff'))
            )`);

        // create messages table to retain messages
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room TEXT,
            user TEXT,
            role TEXT,
            encrypted_text TEXT,
            timestamp TEXT
            )
            `);

        // seed mock data, password for all: diamond539
        const defaultHash = crypto.createHash('sha256').update('diamond539').digest('hex');
        const seedUsers = [
            { name: 'System Admin', role: 'Admin' },
            { name: 'Manager', role: 'Manager' },
            { name: 'Supervisor', role: 'Supervisor' },
            { name: 'Staff', role: 'Staff' }
        ];

        seedUsers.forEach(user => {
            db.run(
                `INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
                [user.name, defaultHash, user.role]
            );
        });

        console.log('Database schemas initilized and default accounts seeded.');

        // seed some mock history data to test socket.on('join_room')
        db.get(`SELECT COUNT(*) as count FROM messages`, [], (err, row) => {
            if (!err && row.count === 0) {
                const ts = new Date().toLocaleTimeString();
                db.run(`INSERT INTO messages (room, user, role, encrypted_text, timestamp) 
                        VALUES ('#general', 'Manager', 'Manager', 'Welcome to the clinic network feed.', '${ts}')`);
                db.run(`INSERT INTO messages (room, user, role, encrypted_text, timestamp) 
                        VALUES ('#announcements', 'System Admin', 'Admin', 'CRITICAL: Main server maintenance at 22:00.', '${ts}')`);
                console.log('Sample chat history seeded successfully.');
            }
        });

    })
}

module.exports = db;