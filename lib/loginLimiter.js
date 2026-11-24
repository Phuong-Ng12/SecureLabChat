// Counts failed logins per username and blocks that username for a while after too many.
// Kept in memory: a server restart clears it, which is fine for a short lockout.
function createLoginLimiter({ maxFailures = 5, lockMs = 5 * 60 * 1000, now = Date.now } = {}) {
    // key -> { failures, lastFailure, lockedUntil }
    const entries = new Map();

    // "Staff", " staff " and "STAFF" are the same account, so they share one counter
    const keyOf = (username) => String(username).trim().toLowerCase();

    function isLocked(username) {
        const entry = entries.get(keyOf(username));
        if (!entry || !entry.lockedUntil) return false;

        if (now() < entry.lockedUntil) return true;

        // the lock has ended: start again with a clean count
        entries.delete(keyOf(username));
        return false;
    }

    function recordFailure(username) {
        const key = keyOf(username);
        const time = now();
        let entry = entries.get(key);

        // failures from long ago should not add up with today's
        if (!entry || (!entry.lockedUntil && time - entry.lastFailure > lockMs)) {
            entry = { failures: 0, lastFailure: time, lockedUntil: 0 };
        }

        entry.failures += 1;
        entry.lastFailure = time;
        if (entry.failures >= maxFailures) {
            entry.lockedUntil = time + lockMs;
        }
        entries.set(key, entry);

        // unknown usernames are counted too, so keep the map from growing forever
        if (entries.size > 1000) {
            for (const [k, e] of entries) {
                if (time - e.lastFailure > lockMs && !(e.lockedUntil > time)) entries.delete(k);
            }
        }
    }

    function reset(username) {
        entries.delete(keyOf(username));
    }

    return { isLocked, recordFailure, reset };
}

module.exports = { createLoginLimiter };