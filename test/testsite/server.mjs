// Serves index.html gzipped with a strict CSP, so the proxy's decode + inject +
// CSP-strip path is exercised on every run.
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';

const port = Number(process.env.PORT) || 3000;
const html = fs.readFileSync(new URL('./index.html', import.meta.url));

http.createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-encoding': 'gzip',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  });
  res.end(zlib.gzipSync(html));
}).listen(port, 'localhost', () => console.log(`test site on ${port}`));
