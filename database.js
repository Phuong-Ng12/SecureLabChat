const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

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
    })
}

module.exports = db;