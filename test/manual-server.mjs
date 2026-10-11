#!/usr/bin/env node
// Runs feedback-tunnel against the Kopi Club demo site for manual, by-hand
// testing (as opposed to the Playwright suites in test/run.mjs). Started via
// `.claude/launch.json`'s "feedback-tunnel" entry.
//
// Runs from a throwaway git project under test/.manual (gitignored) so
// FEEDBACK.md and .feedback-tunnel/ never land in the real repo. It sits outside
// test/.work because the Playwright runner wipes that folder on every run. Start the
// Kopi Club site (the "kopi-site" launch.json entry) first.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'feedback-tunnel.js');
const dir = path.join(HERE, '.manual');

fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(path.join(dir, '.git'))) {
  const git = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Chip');
  git('config', 'user.email', 'host@localhost');
  fs.writeFileSync(path.join(dir, 'README.md'), '# feedback-tunnel manual test project\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
}

// --no-tunnel: this is the local-only view. Ask for the real tunnel separately.
// Optional args pick other ports: node test/manual-server.mjs localhost:3100 4100
const [target = 'localhost:3000', port = '4000'] = process.argv.slice(2);
const args = [BIN, target, '--port', port, '--no-tunnel'];
const child = spawn(process.execPath, args, { cwd: dir, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
