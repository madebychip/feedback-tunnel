import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';

// Starts a Cloudflare quick tunnel to the local review proxy and reports the
// public *.trycloudflare.com URL once it actually works. Needs `cloudflared`
// on the PATH.

const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
const ANNOUNCE_DEADLINE_MS = 25000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cloudflared prints the URL about 3 seconds before its DNS record exists. A
// visitor who opens the link in that gap gets NXDOMAIN, which resolvers cache,
// so the link looks dead for minutes. Ask Cloudflare's own nameservers, which
// skips every cache, and only resolve once they know the name.
async function waitUntilResolvable(hostname, deadline) {
  let auth;
  try {
    const zone = hostname.split('.').slice(-2).join('.');
    const names = await dns.resolveNs(zone);
    const ips = (await Promise.all(names.slice(0, 2).map((n) => dns.resolve4(n).catch(() => [])))).flat();
    if (ips.length) {
      auth = new dns.Resolver({ timeout: 2000, tries: 1 });
      auth.setServers(ips);
    }
  } catch {}
  if (!auth) return sleep(4000); // offline resolver or odd network: a fixed pause beats nothing
  while (Date.now() < deadline) {
    try {
      await auth.resolve4(hostname);
      return;
    } catch {
      await sleep(300);
    }
  }
}

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

  let found = null; // the URL, once printed
  let registered = false; // cloudflared reached Cloudflare's edge
  let live = false; // ...and the hostname resolves
  let announced = false;
  let stopped = false;
  let log = '';

  const announce = () => {
    if (announced || stopped || !found || !registered || !live) return;
    announced = true;
    onUrl(found);
  };

  const scan = (chunk) => {
    const text = chunk.toString();
    log = (log + text).slice(-4000);
    if (!registered && /Registered tunnel connection/.test(text)) {
      registered = true;
      announce();
    }
    if (found) return;
    const m = text.match(URL_RE);
    if (m) {
      found = m[0];
      const deadline = Date.now() + ANNOUNCE_DEADLINE_MS;
      waitUntilResolvable(new URL(found).hostname, deadline).then(() => {
        live = true;
        announce();
      });
      // Never hold the link back forever if the edge line changes wording in a future cloudflared.
      setTimeout(() => {
        registered = live = true;
        announce();
      }, ANNOUNCE_DEADLINE_MS).unref();
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
      stopped = true;
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}
