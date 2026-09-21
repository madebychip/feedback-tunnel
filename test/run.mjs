#!/usr/bin/env node
// Runs the Playwright suites against throwaway projects under test/.work.
//
//   node test/run.mjs                 every local suite (kopi, vite, next)
//   node test/run.mjs kopi            just one
//   node test/run.mjs tunnel          real cloudflared quick tunnel (needs `cloudflared`; opt-in)
//
// One-time setup: npm run test:setup   (see test/README.md)
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'feedback-tunnel.js');
const WORK = path.join(HERE, '.work');
const SHOTS = path.join(WORK, 'shots');
const PYTHON = process.env.PYTHON || 'python3';

// ---- plumbing ---------------------------------------------------------------

const children = [];
const cleanup = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const out = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => out.push(d));
  children.push(child);
  return { child, log: () => Buffer.concat(out).toString(), stop: () => child.kill('SIGTERM') };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url, what, ms = 40000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what} at ${url}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// A throwaway git project for the proxy to run in, so FEEDBACK.md, the notes
// store and the "code version" stamp are all real.
function makeProject(name) {
  const cwd = path.join(WORK, name);
  fs.mkdirSync(cwd, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Chip Tester'); // the host's first name shows up as "Chip"
  git('config', 'user.email', 'tester@example.com');
  fs.writeFileSync(path.join(cwd, 'README.md'), `# ${name}\n`);
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return cwd;
}

async function startProxy(name, targetPort, extra = []) {
  const cwd = makeProject(name);
  const port = await freePort();
  const proc = run(process.execPath, [BIN, String(targetPort), '--port', String(port), ...extra], { cwd });
  await waitFor(`http://127.0.0.1:${port}/__ft/api/bootstrap`, 'the review proxy');
  return { cwd, port, url: `http://127.0.0.1:${port}/`, ...proc };
}

// Async on purpose: the event loop has to keep draining the servers' stdout while a suite runs.
function py(script, env) {
  console.log(`\n▶ ${script}`);
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [path.join(HERE, script)], {
      env: { ...process.env, PYTHONUNBUFFERED: '1', FT_SHOTS: SHOTS, ...env },
      stdio: 'inherit',
    });
    children.push(child);
    child.on('error', (err) => {
      console.log(`  could not run ${PYTHON}: ${err.message}`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

let hostFailures = 0;
function check(name, ok, detail = '') {
  if (!ok) hostFailures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  return ok;
}

function needInstalled(dir, hint) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    console.log(`  SKIP  ${path.basename(dir)}: dependencies not installed (${hint})`);
    return false;
  }
  return true;
}

// ---- suites -----------------------------------------------------------------

const suites = {
  // A gzipped page with a CSP header, carousel and alert() CTA. Scripts run in
  // order and share one notes file, like a real review session.
  async kopi() {
    const sitePort = await freePort();
    run(process.execPath, [path.join(HERE, 'testsite', 'server.mjs')], { env: { ...process.env, PORT: String(sitePort) } });
    await waitFor(`http://localhost:${sitePort}/`, 'the test site');
    const px = await startProxy('kopi', sitePort, ['--no-tunnel']);
    const env = { FT_URL: px.url, FT_PROJECT: px.cwd };
    let ok = true;
    for (const script of ['e2e.py', 'e2e2.py', 'e2e3.py']) ok = (await py(script, env)) && ok;
    console.log('\n▶ terminal output');
    const log = px.log();
    check('log shows a note arriving', /#1\s+Maya/.test(log));
    check('log shows a resolve from the browser', /#1 resolved by Chip/.test(log));
    check('log shows a resolve from FEEDBACK.md', /resolved ticked in FEEDBACK\.md/.test(log));
    check('no stack traces', !/\n\s+at .*\.js:\d+/.test(log));
    if (hostFailures) console.log(`\n--- proxy output ---\n${log}`);
    return ok;
  },

  // React + Vite dev server: HMR websocket, component names, a hot update.
  async vite() {
    const dir = path.join(HERE, 'viteapp');
    if (!needInstalled(dir, 'npm run test:setup')) return null;
    const appFile = path.join(dir, 'src', 'App.jsx');
    const original = fs.readFileSync(appFile, 'utf8');
    try {
      const vitePort = await freePort();
      run(path.join(dir, 'node_modules', '.bin', 'vite'), ['--port', String(vitePort), '--strictPort'], { cwd: dir });
      await waitFor(`http://localhost:${vitePort}/`, 'Vite');
      const px = await startProxy('vite', vitePort, ['--no-tunnel']);
      return await py('e2e_vite.py', { FT_URL: px.url, FT_PROJECT: px.cwd, FT_APP: appFile });
    } finally {
      fs.writeFileSync(appFile, original); // e2e_vite.py edits the component; always put it back
    }
  },

  // Next.js App Router: hydration and a server action through the proxy.
  async next() {
    const dir = path.join(HERE, 'nextapp');
    if (!fs.existsSync(dir)) return null;
    if (!needInstalled(dir, 'npm run test:setup')) return null;
    const nextPort = await freePort();
    const appFile = path.join(dir, 'app', 'page.jsx');
    const original = fs.readFileSync(appFile, 'utf8');
    try {
      const app = run(path.join(dir, 'node_modules', '.bin', 'next'), ['dev', '-p', String(nextPort)], {
        cwd: dir,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      });
      await waitFor(`http://localhost:${nextPort}/`, 'Next.js');
      const px = await startProxy('next', nextPort, ['--no-tunnel']);
      const ok = await py('e2e_next.py', { FT_URL: px.url, FT_PROJECT: px.cwd, FT_APP: appFile });
      if (!ok) console.log(app.log().split('\n').slice(-15).join('\n'));
      return ok;
    } finally {
      fs.writeFileSync(appFile, original);
      fs.rmSync(path.join(dir, '.next'), { recursive: true, force: true });
    }
  },

  // The real thing: a cloudflared quick tunnel in front of the Vite app, with a
  // reviewer browsing from the public trycloudflare.com URL.
  async tunnel() {
    const which = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
    if (which.error) {
      console.log('  SKIP  tunnel: cloudflared is not installed (brew install cloudflared)');
      return null;
    }
    console.log(`  ${(which.stdout || which.stderr).trim()}`);
    const dir = path.join(HERE, 'viteapp');
    if (!needInstalled(dir, 'npm run test:setup')) return null;
    const appFile = path.join(dir, 'src', 'App.jsx');
    const original = fs.readFileSync(appFile, 'utf8');
    try {
      const vitePort = await freePort();
      run(path.join(dir, 'node_modules', '.bin', 'vite'), ['--port', String(vitePort), '--strictPort'], { cwd: dir });
      await waitFor(`http://localhost:${vitePort}/`, 'Vite');
      const px = await startProxy('tunnel', vitePort, []); // no --no-tunnel
      const started = Date.now();
      const url = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`No tunnel URL within 60s. Proxy output:\n${px.log()}`)), 60000);
        const iv = setInterval(() => {
          const m = px.log().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
          if (m) {
            clearTimeout(t);
            clearInterval(iv);
            resolve(m[0]);
          }
        }, 200);
      });
      console.log(`  banner printed the link after ${((Date.now() - started) / 1000).toFixed(1)}s: ${url}`);
      const ok = await py('e2e_tunnel.py', { FT_URL: `${url}/`, FT_LOCAL: px.url, FT_PROJECT: px.cwd, FT_APP: appFile });
      if (!ok) console.log(`\n--- proxy output ---\n${px.log()}`);
      return ok;
    } finally {
      fs.writeFileSync(appFile, original);
    }
  },
};

// ---- main -------------------------------------------------------------------

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = wanted.length ? wanted : ['kopi', 'vite', 'next'];
for (const n of names) {
  if (!suites[n]) {
    console.error(`Unknown suite "${n}". Choose from: ${Object.keys(suites).join(', ')}`);
    process.exit(2);
  }
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
for (const n of names) {
  console.log(`\n━━ ${n} ━━`);
  let ok;
  try {
    ok = await suites[n]();
  } catch (err) {
    console.log(`  ERROR  ${err.message}`);
    ok = false;
  }
  results.push([n, ok]);
}

console.log('\n━━ summary ━━');
for (const [n, ok] of results) console.log(`  ${ok === null ? 'skip' : ok ? 'pass' : 'FAIL'}  ${n}`);
if (hostFailures) console.log(`  ${hostFailures} runner check(s) failed`);
console.log(`  screenshots: ${SHOTS}`);
process.exit(results.some(([, ok]) => ok === false) || hostFailures ? 1 : 0);
