#!/usr/bin/env node
import { start } from '../src/index.js';

const HELP = `
  feedback-tunnel <port or url> [options]

  Share a prototype running on localhost. Reviewers open the link, pick an
  animal, and pin sticky notes on anything. Notes land in FEEDBACK.md.

  Examples
    feedback-tunnel 3000
    feedback-tunnel localhost:5173 --port 4100
    feedback-tunnel http://127.0.0.1:8000 --no-tunnel

  Options
    -p, --port <n>     Port for the local review proxy (default 4000)
    -o, --out <file>   Where to write notes (default FEEDBACK.md)
        --no-tunnel    Skip the public link; review on this machine only
    -h, --help         Show this help

  Run it from your project's root folder so FEEDBACK.md sits next to your code.
`;

function parseTarget(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d+$/.test(s)) s = `http://localhost:${s}`;
  else if (!/^https?:\/\//.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:') return null; // local dev servers only
    return u;
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const opts = { port: 4000, tunnel: true, out: 'FEEDBACK.md', target: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(HELP);
    process.exit(0);
  } else if (a === '-p' || a === '--port') opts.port = Number(args[++i]);
  else if (a === '-o' || a === '--out') opts.out = args[++i];
  else if (a === '--no-tunnel') opts.tunnel = false;
  else if (!opts.target) opts.target = parseTarget(a);
  else {
    console.error(`  Unknown option: ${a}\n${HELP}`);
    process.exit(1);
  }
}

if (!opts.target) {
  console.error(`\n  Tell me which local port your prototype runs on, e.g. feedback-tunnel 3000\n${HELP}`);
  process.exit(1);
}
if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
  console.error('  --port needs a number between 1 and 65535.');
  process.exit(1);
}
if (String(opts.port) === opts.target.port) {
  console.error(`  The review proxy can't use port ${opts.port} too. Pick another with --port.`);
  process.exit(1);
}

start({ ...opts, cwd: process.cwd() }).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${opts.port} is busy. Try: feedback-tunnel ${opts.target.port} --port ${opts.port + 1}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
