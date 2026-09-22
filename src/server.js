import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitUserName } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY_FILE = path.join(ROOT, 'client', 'overlay.js');
const AVATAR_DIR = path.join(ROOT, 'avatars');
const PREFIX = '/__ft/';
const TAG = '<script src="/__ft/overlay.js" defer data-feedback-tunnel></script>';
const IMAGE_TYPES = { png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

// ---- Avatars ----------------------------------------------------------------

export function loadAvatars() {
  const list = JSON.parse(fs.readFileSync(path.join(AVATAR_DIR, 'avatars.json'), 'utf8'));
  return list.map((a) => {
    const ext = Object.keys(IMAGE_TYPES).find((e) => fs.existsSync(path.join(AVATAR_DIR, `${a.id}.${e}`)));
    return { ...a, image: ext ? `/__ft/avatars/${a.id}.${ext}` : null };
  });
}

// ---- Helpers ----------------------------------------------------------------

// Requests that came through the tunnel carry Cloudflare headers.
function looksLikeTunnel(req) {
  const h = req.headers;
  return !!(h['cf-connecting-ip'] || h['cf-ray'] || h['cf-visitor'] || h['x-forwarded-for']);
}

// Anything reaching 127.0.0.1 without those headers is you, on your own machine.
function isHost(req) {
  if (looksLikeTunnel(req)) return false;
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// DNS rebinding: a page you have open in your own browser gets an attacker
// to repoint its domain's DNS at 127.0.0.1 after the page loads. The browser
// treats that fetch as same-origin (no CORS, no preflight, any header goes),
// so it can otherwise reach this server exactly as you would - including
// setting a fake cf-connecting-ip to pass as a reviewer, or none at all to
// pass as the host. The one thing the attacker's domain can't produce is a
// Host header of "localhost" or "127.0.0.1": the browser sets Host from the
// URL it actually fetched, which is still their domain. So outside the
// tunnel, only those two are allowed; everything else is refused before it
// reaches routing, host detection, or the dev server.
function hostHeaderOk(req) {
  if (looksLikeTunnel(req)) return true; // Host is the public *.trycloudflare.com name; that's expected
  let hostname;
  try {
    hostname = new URL('http://' + (req.headers.host || '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// CSRF on the host-only endpoint: a page you have open could still submit a
// same-origin-looking POST with Content-Type: text/plain (no preflight) and a
// body crafted to parse as JSON. Cross-origin fetch() can set an explicit
// application/json header, but that forces a real CORS preflight, which this
// server never approves, so the browser blocks the request before it's sent.
// A plain <form> can't set this header at all. Requiring it exactly rules
// out both.
function isJsonRequest(req) {
  return /^application\/json\b/i.test(req.headers['content-type'] || '');
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, lo, hi, d = 0) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function decode(buf, encoding) {
  switch ((encoding || '').toLowerCase()) {
    case '':
    case 'identity':
      return buf;
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buf);
    case 'br':
      return zlib.brotliDecompressSync(buf);
    case 'deflate':
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    default:
      return null;
  }
}

// latin1 maps bytes 1:1, so splicing ASCII into any ASCII-compatible charset is safe.
function inject(buf) {
  const html = buf.toString('latin1');
  if (html.includes('data-feedback-tunnel')) return buf;
  let i = html.search(/<\/head>/i);
  if (i === -1) i = html.search(/<\/body>/i);
  const out = i === -1 ? html + TAG : html.slice(0, i) + TAG + html.slice(i);
  return Buffer.from(out, 'latin1');
}

function offlinePage(target) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prototype offline</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#202124">
<h1 style="font-size:1.4rem;font-weight:600">This prototype isn't running right now</h1>
<p>Nothing answered at <code>${target.host}</code>. If you're the designer, start your dev server and refresh. If you're reviewing, ask them to start it, then refresh this page.</p>
</body>`;
}

// ---- Server -----------------------------------------------------------------

export function createReviewServer({ target, store, avatars }) {
  const targetHost = target.hostname;
  const targetPort = Number(target.port) || 80;
  const hostHeader = target.host; // e.g. localhost:3000
  const avatarIds = new Set(avatars.map((a) => a.id));
  const hostName = gitUserName(store.cwd) || 'Host';

  async function api(req, res, url) {
    const p = url.pathname;

    if (req.method === 'GET' && p === '/__ft/overlay.js') {
      const js = fs.readFileSync(OVERLAY_FILE);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(js);
    }

    const av = p.match(/^\/__ft\/avatars\/([a-z0-9-]+)\.(png|webp|svg|jpe?g)$/);
    if (req.method === 'GET' && av) {
      const file = path.join(AVATAR_DIR, `${av[1]}.${av[2]}`);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': IMAGE_TYPES[av[2]], 'cache-control': 'max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && p === '/__ft/api/bootstrap') {
      return sendJson(res, 200, {
        isHost: isHost(req),
        project: path.basename(store.cwd),
        avatars: loadAvatars(), // re-read so new images show up without a restart
      });
    }

    if (req.method === 'GET' && p === '/__ft/api/comments') {
      const since = Number(url.searchParams.get('since'));
      if (since === store.version) return sendJson(res, 200, { version: store.version, unchanged: true });
      return sendJson(res, 200, { version: store.version, comments: store.comments });
    }

    if (req.method === 'POST' && p === '/__ft/api/comments') {
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'Expected content-type: application/json.' });
      let b;
      try {
        b = await readJson(req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const text = str(b.text, 4000).trim();
      if (!text) return sendJson(res, 400, { error: 'Write something before posting.' });
      const avatar = avatarIds.has(b.author?.avatar) ? b.author.avatar : avatars[0].id;
      const animal = avatars.find((a) => a.id === avatar).name;
      const a = b.anchor || {};
      const ctx = b.context || {};
      const comment = store.add({
        text,
        author: { name: str(b.author?.name, 40).trim() || `Anonymous ${animal}`, avatar, animal },
        page: { path: str(b.page?.path, 500) || '/', title: str(b.page?.title, 200) },
        anchor: {
          selector: str(a.selector, 1000),
          text: str(a.text, 200),
          tag: str(a.tag, 40),
          label: str(a.label, 120),
          id: str(a.id, 120),
          testId: str(a.testId, 120),
          classes: str(a.classes, 200),
          components: Array.isArray(a.components) ? a.components.slice(0, 6).map((c) => str(c, 120)) : [],
          offset: { x: num(a.offset?.x, 0, 1, 0.5), y: num(a.offset?.y, 0, 1, 0.5) },
        },
        context: {
          viewport: { w: num(ctx.viewport?.w, 0, 10000), h: num(ctx.viewport?.h, 0, 10000) },
          pageWidth: num(ctx.pageWidth, 0, 100000),
          dpr: num(ctx.dpr, 0, 8, 1),
          browser: str(ctx.browser, 60),
        },
      });
      return sendJson(res, 201, { version: store.version, comment });
    }

    const st = p.match(/^\/__ft\/api\/comments\/(\d+)\/status$/);
    if (req.method === 'POST' && st) {
      if (!isHost(req)) return sendJson(res, 403, { error: 'Only the host can resolve notes.' });
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'Expected content-type: application/json.' });
      let b;
      try {
        b = await readJson(req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const status = b.status === 'resolved' ? 'resolved' : 'open';
      const given = str(b.by?.name, 40).trim();
      const by = { name: given && given !== 'Host' ? given : hostName, avatar: avatarIds.has(b.by?.avatar) ? b.by.avatar : undefined };
      const c = store.setStatus(Number(st[1]), status, by, 'browser');
      if (!c) return sendJson(res, 404, { error: 'No note with that number.' });
      return sendJson(res, 200, { version: store.version, comment: c });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  function proxy(req, res) {
    const headers = { ...req.headers, host: hostHeader };
    // Make the dev server believe it's being visited on localhost, so host
    // checks (Vite allowedHosts, Next.js dev origins, server actions) pass.
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer) {
      try {
        const r = new URL(headers.referer);
        headers.referer = target.origin + r.pathname + r.search;
      } catch {}
    }
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    const wantsHtml = req.method === 'GET' && /text\/html/.test(headers.accept || '');
    if (wantsHtml) headers['accept-encoding'] = 'identity';

    const up = http.request(
      { hostname: targetHost, port: targetPort, method: req.method, path: req.url, headers },
      (upRes) => {
        const out = { ...upRes.headers };
        if (out.location && out.location.startsWith(target.origin)) {
          out.location = out.location.slice(target.origin.length) || '/';
        }
        const isHtml = /text\/html/i.test(out['content-type'] || '');
        const hasBody = req.method !== 'HEAD' && ![204, 304].includes(upRes.statusCode);
        if (!isHtml || !hasBody) {
          res.writeHead(upRes.statusCode, out);
          return upRes.pipe(res);
        }
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const raw = Buffer.concat(chunks);
          let body = null;
          try {
            body = decode(raw, out['content-encoding']);
          } catch {}
          if (!body) {
            res.writeHead(upRes.statusCode, out); // unknown encoding: pass through untouched
            return res.end(raw);
          }
          const html = inject(body);
          for (const h of ['content-length', 'content-encoding', 'transfer-encoding', 'etag',
            'content-security-policy', 'content-security-policy-report-only']) delete out[h];
          out['content-length'] = html.length;
          out['cache-control'] = 'no-store';
          res.writeHead(upRes.statusCode, out);
          res.end(html);
        });
      }
    );
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      if (wantsHtml) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(offlinePage(target));
      }
      sendJson(res, 502, { error: `Dev server at ${hostHeader} isn't responding.` });
    });
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    if (!hostHeaderOk(req)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('Bad Host header.');
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith(PREFIX)) {
      api(req, res, url).catch(() => sendJson(res, 500, { error: 'Something broke in feedback-tunnel.' }));
    } else {
      proxy(req, res);
    }
  });

  // WebSockets (hot reload) pass straight through with the same header rewrite.
  server.on('upgrade', (req, socket, head) => {
    if (!hostHeaderOk(req) || req.url.startsWith(PREFIX)) return socket.destroy();
    const upstream = net.connect(targetPort, targetHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        let v = req.rawHeaders[i + 1];
        const lk = k.toLowerCase();
        if (lk === 'host') v = hostHeader;
        else if (lk === 'origin') v = target.origin;
        else if (lk === 'x-forwarded-host' || lk === 'x-forwarded-proto') continue;
        lines.push(`${k}: ${v}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const kill = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', kill);
    socket.on('error', kill);
  });

  return server;
}
