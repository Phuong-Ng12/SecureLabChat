// Docker health check: asks /health over https when the certificate exists, otherwise http.
// The certificate is self-signed, so it is not verified here (this only talks to localhost).
const fs = require('fs');
const path = require('path');

const certPath = process.env.TLS_CERT || path.join(__dirname, '..', 'certs', 'server.crt');
const keyPath = process.env.TLS_KEY || path.join(__dirname, '..', 'certs', 'server.key');
const secure = fs.existsSync(certPath) && fs.existsSync(keyPath);
const lib = require(secure ? 'https' : 'http');

const req = lib.get({
    host: '127.0.0.1',
    port: process.env.PORT || 3000,
    path: '/health',
    rejectUnauthorized: false,
    timeout: 2500
}, (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));