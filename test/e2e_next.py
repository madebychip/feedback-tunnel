"""Next.js App Router (dev) through the proxy: hydration with the overlay
injected, a server action (Next checks Origin against Host), the HMR
websocket, and a Fast Refresh edit that must not reload the page."""
import os
import re
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from helpers import *

APP = Path(os.environ["FT_APP"])  # run.mjs restores this file afterwards

print("e2e_next.py: Next.js App Router")
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1100, "height": 700}, extra_http_headers=REVIEWER)
    r = ctx.new_page()
    errs, ws = [], []
    r.on("pageerror", lambda e: errs.append(str(e)))
    # Hydration mismatches and server-action failures surface as console errors.
    r.on("console", lambda m: m.type == "error" and not m.text.startswith("Failed to load resource") and errs.append(m.text))
    r.on("websocket", lambda w: ws.append(w.url))

    r.goto(URL, timeout=90000)  # first hit compiles the route
    r.wait_for_selector("h1", timeout=90000)
    r.wait_for_selector("feedback-tunnel", state="attached", timeout=15000); time.sleep(1)
    check("page renders through the proxy", r.locator("h1").inner_text() == "Pricing v1")
    check("overlay injected into a streamed Next.js document", r.evaluate("!!document.querySelector('feedback-tunnel')"))

    r.locator("#count").click()
    check("hydration worked: client onClick runs", poll(lambda: r.locator("#count").inner_text() == "Clicked 1 times"), r.locator("#count").inner_text())
    r.locator("#save").click()
    check("server action succeeds through the proxy", poll(lambda: r.locator("#msg").inner_text() == "Saved plan (#1)", timeout=15), r.locator("#msg").inner_text())
    check("HMR websocket goes through the proxy", any("/_next/" in u and URL.split("//")[1].rstrip("/") in u for u in ws), ws)

    # Notes: one on the server-rendered heading, one on a client component's button.
    r.evaluate("localStorage.setItem('feedback-tunnel:me', JSON.stringify({name:'Farah',color:'#f97316',custom:true}))")
    r.reload(); r.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(1)
    r.keyboard.press("c")
    hb = r.locator("h1").bounding_box()
    r.mouse.click(hb["x"] + 20, hb["y"] + hb["height"] / 2); time.sleep(0.3)
    r.locator("feedback-tunnel").locator("textarea").fill("Heading should say the price, not just 'Pricing'.")
    r.locator("feedback-tunnel").locator("textarea").press("Control+Enter")
    check("note on the heading posted", poll(lambda: "1:open" in r.evaluate(PINS)), r.evaluate(PINS))
    bb = r.locator("#save").bounding_box()
    r.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2); time.sleep(0.3)
    r.locator("feedback-tunnel").locator("textarea").fill("Save should confirm with a toast.")
    r.locator("feedback-tunnel").locator("textarea").press("Control+Enter")
    check("note on the client button posted", poll(lambda: "2:open" in r.evaluate(PINS)), r.evaluate(PINS))
    r.keyboard.press("Escape")
    md = FEEDBACK_MD.read_text()
    check("FEEDBACK.md: heading labelled for humans", re.search(r'Heading .Pricing v1.', md) is not None)
    comps = re.findall(r"Component: `([^`]*)`", md)
    check("FEEDBACK.md: client component path captured", "Panel" in comps, comps)
    check("FEEDBACK.md: Next.js internals are left out of component paths", not any(re.search(r"Scroll|Router|Boundary|Handler", c) for c in comps), comps)
    shot(r, "18_next_notes.png")

    # Fast Refresh: edit the server component. The page must update in place.
    r.locator("#count").click(); time.sleep(0.2)
    r.evaluate("window.__noReload = 7")
    src = APP.read_text()
    assert "Pricing v1" in src
    APP.write_text(src.replace("Pricing v1", "Pricing v2"))
    check("hot update applied", poll(lambda: r.locator("h1").inner_text() == "Pricing v2", timeout=30), r.locator("h1").inner_text())
    time.sleep(1)
    check("...without a full page reload", r.evaluate("window.__noReload") == 7)
    check("...client state survived", r.locator("#count").inner_text() == "Clicked 1 times", r.locator("#count").inner_text())
    check("...overlay still mounted", r.evaluate("!!document.querySelector('feedback-tunnel')"))
    pins = r.evaluate(PINS)
    check("pins still attached after the edit", pins == ["1:open", "2:open"], pins)
    shot(r, "19_next_after_hmr.png")

    edit_md("- [ ] **#1**", "- [x] **#1**")
    check("agent's tick turns the pin green", poll(lambda: "1:green" in r.evaluate(PINS), timeout=8), r.evaluate(PINS))
    check("no console or page errors", errs == [], errs[:3])
    b.close()
finish()
