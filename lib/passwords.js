const crypto = require('crypto');

// Same hashing for login and for accounts created by an admin
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Only hashed token is stored in db
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { hashPassword, hashToken };