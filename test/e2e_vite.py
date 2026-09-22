"""React + Vite dev server through the proxy: HMR websocket, component names
in FEEDBACK.md, a hot update that must not wipe the overlay or move the pin."""
import os
import re
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from helpers import *

APP = Path(os.environ["FT_APP"])  # run.mjs restores this file afterwards

print("e2e_vite.py: React + Vite hot reload")
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1100, "height": 700}, extra_http_headers=REVIEWER)
    r = ctx.new_page()
    errs, ws = [], []
    r.on("pageerror", lambda e: errs.append(str(e)))
    r.on("websocket", lambda w: ws.append(w.url))
    r.goto(URL); r.wait_for_selector("feedback-tunnel", state="attached"); r.wait_for_selector("text=Choose Pair"); time.sleep(0.8)
    r.evaluate("localStorage.setItem('feedback-tunnel:me', JSON.stringify({name:'Farah',color:'#f97316',custom:true}))")
    r.reload(); r.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(0.8)
    check("React app rendered through the proxy", r.get_by_text("Choose Pair").count() == 1)
    check("Vite HMR websocket goes through the proxy", any(URL.split("//")[1].rstrip("/") in u for u in ws), ws)

    r.keyboard.press("c")
    bb = r.get_by_text("Choose Pair").bounding_box()
    r.mouse.click(bb["x"] + bb["width"] * 0.5, bb["y"] + bb["height"] * 0.5); time.sleep(0.3)
    r.locator("feedback-tunnel").locator("textarea").fill("Make this the recommended plan, with a filled button.")
    r.locator("feedback-tunnel").locator("textarea").press("Enter")
    check("note posted", poll(lambda: "1:open" in r.evaluate(PINS)), r.evaluate(PINS))
    r.keyboard.press("Escape")
    md = FEEDBACK_MD.read_text()
    check("FEEDBACK.md: React component path captured", "Component: `PlanCard" in md and "App`" in md, re.findall(r"Component: .*", md))
    check("FEEDBACK.md: button labelled for humans", re.search(r'Button .Choose Pair.', md) is not None)

    # A coding agent edits the component: HMR must update in place.
    r.evaluate("window.__noReload = 42")
    src = APP.read_text()
    changed = src.replace("<button>Choose {name}</button>",
                          "<button style={{background: name === 'Pair' ? '#1a73e8' : 'white', color: name === 'Pair' ? 'white' : 'black', padding: '8px 14px', border: '1px solid #1a73e8', borderRadius: 6}}>Choose {name}</button>")
    assert changed != src, "App.jsx no longer has the button this test edits"
    APP.write_text(changed)
    bg = lambda: r.evaluate("getComputedStyle([...document.querySelectorAll('button')].find(b => b.textContent === 'Choose Pair')).backgroundColor")
    check("hot update applied", poll(lambda: bg() == "rgb(26, 115, 232)", timeout=8), bg())
    check("...without a page reload", r.evaluate("window.__noReload") == 42)
    check("...and the overlay is still mounted", r.evaluate("!!document.querySelector('feedback-tunnel')"))

    # The pin's tip must still sit on the button after it changed size.
    tip = r.evaluate("""() => {
      const pin = [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.pin')][0];
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Choose Pair');
      const p = pin.getBoundingClientRect(), t = btn.getBoundingClientRect();
      return { hidden: pin.hidden, x: p.left + p.width / 2, y: p.bottom, box: [t.left, t.top, t.right, t.bottom] } }""")
    bx = tip["box"]
    on_button = bx[0] - 6 <= tip["x"] <= bx[2] + 6 and bx[1] - 6 <= tip["y"] <= bx[3] + 6
    check("pin stays on its button after the hot update", (not tip["hidden"]) and on_button, tip)

    # The agent ticks the box.
    edit_md("- [ ] **#1**", "- [x] **#1**")
    check("agent's tick turns the pin green", poll(lambda: "1:green" in r.evaluate(PINS), timeout=8), r.evaluate(PINS))
    shot(r, "16_vite_after_fix.png")
    toasts = r.evaluate(TOASTS)
    check("reviewer sees the resolved toast", any(re.search(r"note 1 resolved", t, re.I) for t in toasts), toasts)
    check("no page errors", errs == [], errs)
    b.close()
finish()
