const http = require('http'), fs = require('fs'), zlib = require('zlib');
http.createServer((req, res) => {
  const html = fs.readFileSync(__dirname + '/index.html');
  const gz = zlib.gzipSync(html);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" });
  res.end(gz);
}).listen(3000, 'localhost', () => console.log('test site on 3000'));
