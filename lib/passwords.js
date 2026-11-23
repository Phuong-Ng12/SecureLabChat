const crypto = require('crypto');

const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Stored as "salt:hash" (both hex). Every call makes a new random salt, so two users
// with the same password get different stored values.
function hashPassword(password) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = crypto.scryptSync(password, salt, KEY_BYTES);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Old accounts made before salting hold a plain 64-character SHA-256 hex string
function isLegacyHash(stored) {
    return typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored);
}

// True when the password matches the stored value (salted or legacy)
function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;

    try {
        if (isLegacyHash(stored)) {
            const legacy = crypto.createHash('sha256').update(password).digest();
            return crypto.timingSafeEqual(legacy, Buffer.from(stored, 'hex'));
        }

        const [saltHex, hashHex] = stored.split(':');
        if (!saltHex || !hashHex) return false;

        const expected = Buffer.from(hashHex, 'hex');
        const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
        return crypto.timingSafeEqual(actual, expected);
    } catch (err) {
        return false;
    }
}

// Only hashed token is stored in db. The token is 32 random bytes, so a plain SHA-256
// is enough here (a salt and a slow hash only matter for passwords people choose).
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { hashPassword, verifyPassword, isLegacyHash, hashToken };