"""The real Cloudflare quick tunnel. Unlike every other suite, nothing here is
faked: the reviewer's browser arrives from the public trycloudflare.com URL, so
the Cloudflare headers the host/reviewer split depends on are genuine."""
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from playwright.sync_api import sync_playwright
from helpers import *

PUBLIC = URL.rstrip("/")                      # https://<random>.trycloudflare.com
LOCAL = os.environ["FT_LOCAL"].rstrip("/")    # the host's own view
APP = Path(os.environ["FT_APP"])              # run.mjs restores this file afterwards
CAP_PROBE = int(os.environ.get("FT_CAP_PROBE", "260"))  # 0 skips the in-flight cap probe

print("e2e_tunnel.py: real cloudflared quick tunnel")
print(f"  public {PUBLIC}")

with sync_playwright() as p:
    b = p.chromium.launch()
    api = p.request.new_context()  # no fake headers

    # -- the link goes live a few seconds after cloudflared prints it
    t0 = time.time()
    seen = {}
    def live():
        try:
            r = api.get(PUBLIC + "/", timeout=8000, headers={"accept": "text/html"})
            seen["last"] = r.status
            return r if r.status == 200 else None
        except Exception as e:
            seen["last"] = str(e).splitlines()[0][:120]
            return None
    first = poll(live, timeout=90, every=1.0)
    check("public link answers 200", bool(first), f"after {time.time() - t0:.1f}s" if first else f"last seen: {seen.get('last')}")
    if not first:
        b.close(); finish()
    html = first.text()
    check("prototype is served through the tunnel with the overlay injected", "data-feedback-tunnel" in html and 'id="root"' in html)

    # -- host vs reviewer, decided by real Cloudflare headers
    remote = api.get(PUBLIC + "/__ft/api/bootstrap").json()
    local = p.request.new_context().get(LOCAL + "/__ft/api/bootstrap").json()
    check("visitor on the public URL is a reviewer", remote["isHost"] is False, remote["isHost"])
    check("visitor on localhost is the host", local["isHost"] is True, local["isHost"])

    # -- a reviewer browses over https
    errs, ws = [], []
    rev = b.new_context(viewport={"width": 1100, "height": 700})
    r = rev.new_page()
    r.on("pageerror", lambda e: errs.append(str(e)))
    r.on("websocket", lambda w: ws.append(w.url))
    r.goto(URL); r.wait_for_selector("feedback-tunnel", state="attached", timeout=30000); r.wait_for_selector("text=Choose Pair"); time.sleep(0.8)
    check("page and overlay load in a real browser over https", r.evaluate("location.protocol") == "https:")
    check("HMR websocket connects over wss through Cloudflare", any(u.startswith("wss://") and "trycloudflare.com" in u for u in ws), ws)
    r.evaluate("localStorage.setItem('feedback-tunnel:me', JSON.stringify({name:'Farah',avatar:'fox',custom:true}))")
    r.reload(); r.wait_for_selector("feedback-tunnel", state="attached"); r.wait_for_selector("text=Choose Pair"); time.sleep(0.8)
    r.keyboard.press("c")
    bb = r.get_by_text("Choose Pair").bounding_box()
    r.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2); time.sleep(0.3)
    r.locator("feedback-tunnel").locator("textarea").fill("Make this the recommended plan, with a filled button.")
    r.locator("feedback-tunnel").locator("textarea").press("Control+Enter")
    check("note posted through the tunnel", poll(lambda: "1:open" in r.evaluate(PINS)), r.evaluate(PINS))
    r.keyboard.press("Escape")
    md = FEEDBACK_MD.read_text()
    check("note landed in FEEDBACK.md on the host's disk", "Note from Farah (Fox)" in md and "Choose Pair" in md)
    shot(r, "20_tunnel_reviewer.png")

    # -- hot reload reaches the reviewer through the tunnel
    r.evaluate("window.__noReload = 1")
    src = APP.read_text()
    APP.write_text(src.replace("<button>Choose {name}</button>", "<button style={{background: name === 'Pair' ? '#1a73e8' : 'white', color: 'black'}}>Choose {name}</button>"))
    bg = lambda: r.evaluate("getComputedStyle([...document.querySelectorAll('button')].find(b => b.textContent === 'Choose Pair')).backgroundColor")
    check("hot update reaches the reviewer over the tunnel", poll(lambda: bg() == "rgb(26, 115, 232)", timeout=15), bg())
    check("...without reloading their page", r.evaluate("window.__noReload") == 1)
    check("...and the pin stays attached", any(s.startswith("1:open") and not s.endswith("hidden") for s in r.evaluate(PINS)), r.evaluate(PINS))

    # -- the host resolves it on localhost; the reviewer watches it turn green
    hp = b.new_context(viewport={"width": 1100, "height": 700}).new_page()
    hp.on("pageerror", lambda e: errs.append(str(e)))
    hp.goto(LOCAL); hp.wait_for_selector("feedback-tunnel", state="attached"); hp.wait_for_selector("text=Choose Pair"); time.sleep(1)
    hp.locator("feedback-tunnel").locator(".pin", has=hp.locator(".num", has_text="1")).click(); time.sleep(0.4)
    hp.locator("feedback-tunnel").get_by_role("button", name="Resolve").click()
    check("reviewer sees the pin go green over the tunnel", poll(lambda: "1:green" in r.evaluate(PINS), timeout=10), r.evaluate(PINS))
    check("...with the host's name in the toast", poll(lambda: "Chip resolved note 1" in r.evaluate(TOASTS)), r.evaluate(TOASTS))
    shot(r, "21_tunnel_green.png")

    # -- reviewers cannot reopen it, because Cloudflare stamps their requests
    denied = r.evaluate("""async () => (await fetch('/__ft/api/comments/1/status', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({status:'open'})})).status""")
    check("reviewer over the tunnel cannot change status (403)", denied == 403, denied)
    check("note is still resolved", "## Resolved (1)" in FEEDBACK_MD.read_text())

    # -- the documented 200-in-flight cap on quick tunnels
    if CAP_PROBE:
        def hit(_):
            try:
                with urllib.request.urlopen(PUBLIC + "/__slow", timeout=30) as resp:
                    return resp.status
            except urllib.error.HTTPError as e:
                return e.code
            except Exception:
                return "err"
        with ThreadPoolExecutor(max_workers=CAP_PROBE) as ex:
            codes = list(ex.map(hit, range(CAP_PROBE)))
        tally = {c: codes.count(c) for c in sorted(set(codes), key=str)}
        print(f"  cap probe: {CAP_PROBE} concurrent requests held open 4 s each -> {tally}")
        check("tunnel survives the burst and still serves", api.get(PUBLIC + "/").status == 200)

    check("no page errors", errs == [], errs[:3])
    b.close()
finish()
