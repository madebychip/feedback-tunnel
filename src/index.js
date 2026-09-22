import { Store } from './store.js';
import { createReviewServer } from './server.js';
import { startTunnel } from './tunnel.js';

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1);
const dim = c(2);
const green = c(32);
const yellow = c(33);
const cyan = c(36);

function short(s, n = 70) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export async function start({ target, port, tunnel, out, cwd }) {
  const store = new Store({
    cwd,
    outFile: out,
    onEvent(e) {
      const n = e.comment;
      if (e.type === 'added') {
        console.log(`\n  ${yellow('●')} ${bold('#' + n.id)}  ${n.author.name} on ${cyan(n.page.path)}  ${dim(short(n.anchor.label, 40))}`);
        console.log(`     ${short(n.text)}`);
      } else if (e.type === 'resolved') {
        const who = e.via === 'FEEDBACK.md' ? 'ticked in FEEDBACK.md' : 'by ' + (n.resolvedBy?.name || 'host');
        console.log(`\n  ${green('✓')} ${bold('#' + n.id)} resolved ${dim(who)}`);
      } else if (e.type === 'open') {
        console.log(`\n  ${yellow('↺')} ${bold('#' + n.id)} reopened`);
      }
    },
  });
  store.watchMarkdown();

  const server = createReviewServer({ target, store });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const local = `http://localhost:${port}`;
  const row = (label, value) => console.log(`  ${dim(label.padEnd(14))}${value}`);

  console.log(`\n  ${bold('feedback-tunnel')} ${dim('v0.1')}\n`);
  row('Prototype', target.origin);
  row('Your view', `${local}  ${dim('(you can resolve notes here)')}`);
  row('Notes file', store.outFile.replace(cwd + '/', './'));
  if (store.comments.length) row('Loaded', `${store.comments.length} earlier note${store.comments.length === 1 ? '' : 's'}`);

  let tun = { stop() {} };
  if (tunnel) {
    console.log(`\n  ${dim('Opening a Cloudflare quick tunnel…')}`);
    tun = startTunnel(port, {
      onUrl(url) {
        console.log(`\n  ${bold('Share this link')}  ${green(bold(url))}`);
        console.log(`  ${dim('It stops working when you quit. Your notes stay on disk.')}\n`);
      },
      onMissing() {
        console.log(`\n  ${yellow('cloudflared is not installed')}, so there's no public link yet.`);
        console.log(`  Install it, then restart:  ${bold('brew install cloudflared')}  ${dim('(Windows: winget install Cloudflare.cloudflared)')}`);
        console.log(`  Your local view still works at ${local}\n`);
      },
      onFail(msg) {
        console.log(`\n  ${yellow('Cloudflare did not hand out a tunnel.')} ${dim(short(msg, 120))}`);
        console.log(`  Wait a minute and restart. Your local view still works at ${local}\n`);
      },
      onExit(code, log) {
        if (code && log) console.log(dim(`\n  cloudflared exited (${code}).\n${log.split('\n').slice(-6).join('\n')}`));
      },
    });
  } else {
    console.log(`\n  ${dim('Tunnel off (--no-tunnel). Only this machine can reach the review view.')}\n`);
  }

  const stop = () => {
    tun.stop();
    store.close();
    server.close();
    console.log(`\n  ${dim('Stopped. Your notes are saved in')} ${store.outFile.replace(cwd + '/', './')}\n`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return { server, store, stop };
}
