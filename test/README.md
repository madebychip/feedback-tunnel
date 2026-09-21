# Tests

End-to-end suites that drive a real headless Chromium against the real proxy and overlay. Nothing is mocked, and no paths are hard-coded: each run builds throwaway projects under `test/.work/` (git-ignored, wiped at the start of every run) and picks free ports.

## One-time setup

```bash
pip install playwright && playwright install chromium   # Python 3.9+
npm run test:setup                                      # installs the Vite and Next.js sample apps
```

## Running

```bash
npm test                    # kopi + vite + next
node test/run.mjs kopi      # one suite
npm run test:tunnel         # the real Cloudflare tunnel (needs `brew install cloudflared`; opt-in)
```

Screenshots from every run land in `test/.work/shots/`. A suite whose dependencies aren't installed is reported as `skip`, and any failed check exits non-zero.

## Suites

| Suite | Target | What it proves |
|---|---|---|
| `kopi` | `testsite/`: gzipped page, strict CSP, snap carousel, `alert()` CTA | Injection, host vs reviewer, Comment mode swallowing clicks, pins on carousel cards, the green-pin moment (host click and agent tick), reload, clipped carousels, phone layout, other-page notes, orphans, hostile input, the `FEEDBACK.md` format |
| `vite` | `viteapp/`: React 19 + Vite | HMR websocket through the proxy, React component names, hot update without reload, pin stays put |
| `next` | `nextapp/`: Next.js App Router | Hydration, a server action through the proxy, the overlay surviving a hot update |
| `tunnel` | `viteapp/` behind a real `cloudflared` quick tunnel | The link only appears once its DNS resolves, the URL scrape against real `cloudflared` output, host vs reviewer from genuine Cloudflare headers (403 on a reviewer's resolve), the HMR websocket over `wss://`, hot update and green pin through the tunnel, and a probe of the 200-in-flight cap (`FT_CAP_PROBE=0` skips it) |

`kopi` runs `e2e.py`, `e2e2.py` and `e2e3.py` in that order because they share one notes file, the way a real review session does.

## Not covered

A real iPhone in Safari, Windows, and Firefox. The Playwright phone run emulates an iPhone 13 in Chromium. The tunnel suite talks to Cloudflare's free quick-tunnel service, so it needs internet and can occasionally hit its rate limit; rerun it if `cloudflared` reports a 429.
