"""Runs after e2e.py (note 1 resolved, note 2 open): the agent ticks a box while
a reviewer watches, hot-reload wipes, clipped carousels, and a phone."""
import re
import time
from playwright.sync_api import sync_playwright
from helpers import *

print("e2e2.py: agent tick, reload, narrow carousel, phone")
with sync_playwright() as p:
    b = p.chromium.launch()
    errs = []

    # -- the agent ticks the box while the reviewer watches
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, extra_http_headers=REVIEWER)
    r = ctx.new_page()
    r.on("pageerror", lambda e: errs.append(str(e)))
    mount(r)
    r.evaluate("document.getElementById('beans').scrollLeft = 600"); time.sleep(0.3)
    check("before the agent: note 2 is open", "2:open" in r.evaluate(PINS), r.evaluate(PINS))
    edit_md("- [ ] **#2**", "- [x] **#2**")  # what Claude Code does
    check("agent's tick turns the pin green", poll(lambda: "2:green" in r.evaluate(PINS), timeout=8), r.evaluate(PINS))
    toasts = r.evaluate(TOASTS)
    check("reviewer gets a resolved toast", any(re.search(r"note 2 resolved", t, re.I) for t in toasts), toasts)
    shot(r, "11_agent_resolved.png")
    md = FEEDBACK_MD.read_text()
    check("FEEDBACK.md: note 2 moved to Resolved", "## Resolved (2)" in md and "## Open (0)" in md)
    check("FEEDBACK.md: says it was ticked in the file", "Ticked in FEEDBACK.md" in md)

    # -- the agent un-ticks it again; the reviewer sees it reopen
    edit_md("- [x] **#2**", "- [ ] **#2**")
    check("un-ticking reopens the pin", poll(lambda: "2:open" in r.evaluate(PINS), timeout=8), r.evaluate(PINS))

    # -- hot reload wipes the page while a note gets resolved: the moment still plays afterwards
    r.reload(); r.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(1)
    check("after reload the note is still open", "2:open" in r.evaluate(PINS), r.evaluate(PINS))
    r.close()
    edit_md("- [ ] **#2**", "- [x] **#2**")
    check("server picked up the tick while nobody was watching",
          poll(lambda: "## Resolved (2)" in FEEDBACK_MD.read_text(), timeout=4))
    r = ctx.new_page(); r.on("pageerror", lambda e: errs.append(str(e)))
    mount(r)
    toasts = poll(lambda: r.evaluate(TOASTS), timeout=4)
    check("green-pin toast plays on the fresh page", any(re.search(r"note 2 resolved", t, re.I) for t in toasts), toasts)

    # -- pins hide when their card scrolls out of a clipped carousel
    r.evaluate("""() => { const c = document.getElementById('beans'); c.style.width='560px'; c.style.margin='0 auto'; c.scrollLeft = 0; }"""); time.sleep(0.4)
    hidden = r.evaluate(PINS)
    check("narrow carousel at 0: pin 2 hidden (card clipped)", "2:green:hidden" in hidden, hidden)
    r.evaluate("document.getElementById('beans').scrollLeft = 700"); time.sleep(0.4)
    shown = r.evaluate(PINS)
    check("narrow carousel at 700: pin 2 visible", "2:green" in shown, shown)
    shot(r, "12_narrow_carousel.png")
    ctx.close()

    # -- phone
    m = b.new_context(**p.devices["iPhone 13"], extra_http_headers={"cf-connecting-ip": "203.0.113.10"})
    mp = m.new_page(); mp.on("pageerror", lambda e: errs.append(str(e)))
    mount(mp)
    shot(mp, "13_phone_start.png")
    bar_in_view = """() => { const r = document.querySelector('feedback-tunnel').shadowRoot.querySelector('.bar').getBoundingClientRect();
      const v = window.visualViewport; return r.left >= v.offsetLeft - 1 && r.right <= v.offsetLeft + v.width + 1 && r.bottom <= v.offsetTop + v.height + 1 }"""
    check("toolbar starts inside the visual viewport", mp.evaluate(bar_in_view))
    ft = mp.locator("feedback-tunnel")
    ft.locator(".bar .comment").tap(); time.sleep(0.3)
    ft.get_by_text("Start commenting").tap(); time.sleep(0.3)
    btn = mp.get_by_text("Choose Pair"); btn.scroll_into_view_if_needed(); time.sleep(0.3)
    bb = btn.bounding_box(); mp.touchscreen.tap(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2); time.sleep(0.4)
    ft.locator("textarea").fill("Pair is the plan most people pick. Could it be highlighted?")
    shot(mp, "14_phone_composer.png")
    composer_top = mp.evaluate("""() => { const c = document.querySelector('feedback-tunnel').shadowRoot.querySelector('.note, .composer'); return c ? c.getBoundingClientRect().top : null }""")
    check("composer sits near the top on a phone (keyboard-safe)", composer_top is not None and composer_top < 200, composer_top)
    ft.get_by_role("button", name="Post note").dispatch_event("click")
    check("phone note appears as a pin", poll(lambda: any(s.startswith("3:open") for s in mp.evaluate(PINS)), timeout=5), mp.evaluate(PINS))
    shot(mp, "15_phone_posted.png")
    check("toolbar still inside the visual viewport", mp.evaluate(bar_in_view))
    md = FEEDBACK_MD.read_text()
    check("FEEDBACK.md: phone note records the device", re.search(r"Viewport: 390×\d+, .*iPhone", md) is not None)
    check("FEEDBACK.md: anonymous attribution", "Note from Anonymous," in md)
    check("no page errors", errs == [], errs)
    b.close()
finish()
