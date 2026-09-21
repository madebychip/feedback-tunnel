import { spawn } from 'node:child_process';

// Starts a Cloudflare quick tunnel to the local review proxy and reports the
// public *.trycloudflare.com URL. Needs `cloudflared` on the PATH.

const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

export function startTunnel(port, { onUrl, onMissing, onFail, onExit }) {
  // 127.0.0.1 rather than localhost: cloudflared may resolve localhost to ::1,
  // and the proxy only listens on IPv4 loopback.
  const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  let child;
  try {
    child = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    onMissing(err);
    return { stop() {} };
  }

  let found = false;
  let log = '';
  const scan = (chunk) => {
    const text = chunk.toString();
    log = (log + text).slice(-4000);
    if (found) return;
    const m = text.match(URL_RE);
    if (m) {
      found = true;
      onUrl(m[0]);
    } else if (/failed to request quick tunnel|error unmarshaling|429 Too Many Requests/i.test(text)) {
      onFail(text.trim());
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', (err) => {
    if (err.code === 'ENOENT') onMissing(err);
    else onFail(err.message);
  });
  child.on('exit', (code) => onExit(code, found ? '' : log));

  return {
    stop() {
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}
