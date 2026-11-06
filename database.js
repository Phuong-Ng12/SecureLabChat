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

// SQLite has no add column if not exists so this function checks the table first.
// This function lets an existing data/chat.db be upgraded without deleting it.
function addColumnIfMissing(table, column, definition, done) {
    db.all(`PRAGMA table_info(${table})`, [], (err, cols) => {
        if (err) {
            console.error(`Could not inspect ${table}:`, err.message);
            return;
        }
        if (cols.some((c) => c.name === column)) {
            done();
            return;
        }
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (alterErr) => {
            if (alterErr) {
                console.error(`Could not add ${table}.${column}:`, alterErr.message);
                return;
            }
            console.log(`Migration: added ${table}.${column}`);
            done();
        });
    });
}

// seed mock data, password for all: diamond539
function seedData() {
    const defaultHash = crypto.createHash('sha256').update('diamond539').digest('hex');

    const seedDepartments = ['Pharmacy', 'Emergency'];

    // dept is null for company-wide users (Admin, Manager)
    const seedUsers = [
        { name: 'System Admin', role: 'Admin', dept: null },
        { name: 'Manager', role: 'Manager', dept: null },
        { name: 'Supervisor', role: 'Supervisor', dept: 'Pharmacy' },
        { name: 'Staff', role: 'Staff', dept: 'Pharmacy' },
        { name: 'ER Supervisor', role: 'Supervisor', dept: 'Emergency' },
        { name: 'ER Staff', role: 'Staff', dept: 'Emergency' }
    ];

    db.serialize(() => {
        seedDepartments.forEach((name) => {
            db.run(`INSERT OR IGNORE INTO departments (name) VALUES (?)`, [name]);
        });

        seedUsers.forEach((user) => {
            db.run(
                `INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
                [user.name, defaultHash, user.role]
            );
            // only fills an empty department, so later changes by an admin are kept
            if (user.dept) {
                db.run(
                    `UPDATE users
                     SET department_id = (SELECT id FROM departments WHERE name = ?)
                     WHERE username = ? AND department_id IS NULL`,
                    [user.dept, user.name]
                );
            }
        });

        console.log('Database schemas initilized and default accounts seeded.');

        // seed some mock history data to test socket.on('join_room')
        db.get(`SELECT COUNT(*) as count FROM messages`, [], (err, row) => {
            if (!err && row.count === 0) {
                const ts = new Date().toISOString();
                db.run(`INSERT INTO messages (room, user, role, encrypted_text, timestamp)
                        VALUES (?, ?, ?, ?, ?)`,
                    ['#general', 'Manager', 'Manager', 'Welcome to the clinic network feed.', ts]);
                db.run(`INSERT INTO messages (room, user, role, encrypted_text, timestamp)
                        VALUES (?, ?, ?, ?, ?)`,
                    ['#announcements', 'System Admin', 'Admin', 'CRITICAL: Main server maintenance at 22:00.', ts]);
                console.log('Sample chat history seeded successfully.');
            }
        });
    });
}


function initializeAndSeedDatabase() {
    db.serialize(() => {
        // enforce REFERENCES ON DELETE CASCADE (SQLite has this off by default)
        db.run(`PRAGMA foreign_keys = ON`);
        
        // overwrite deleted rows, so a message removed by the 72-hour cleanup
        // does not stay readable inside the database file
        db.run(`PRAGMA secure_delete = ON`);

        // create user and role table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password_hash TEXT,
            role TEXT CHECK(role IN ('Admin', 'Manager', 'Supervisor', 'Staff'))
            )`);

        // department_id stays NULL for system-wide user such as Admin and Manager
        db.run(`CREATE TABLE IF NOT EXISTS departments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )`);

        // create messages table to retain messages
        // timestamp is always a full UTC ISO string
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room TEXT,
            user TEXT,
            role TEXT,
            encrypted_text TEXT,
            timestamp TEXT
            )
            `);
        
        // repair any old row that has no timestamp, then index for the 72-hour queries
        db.run(`UPDATE messages SET timestamp = ? WHERE timestamp IS NULL OR timestamp = ''`,
            [new Date().toISOString()]);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_room_timestamp ON messages(room, timestamp)`);

        // login session. Only a SHA-256 hash of the token is stored. No usable tokens are stored in chat.db
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
            )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`);

        // add users.department_id (existing databases), then seed the data
        addColumnIfMissing('users', 'department_id', 'INTEGER REFERENCES departments(id)', seedData);

    })
}

module.exports = db;
