/**
 * Find a free TCP port on localhost (avoids EADDRINUSE when 3000 is taken).
 */
const net = require('net');

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, host, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

module.exports = { findFreePort };
