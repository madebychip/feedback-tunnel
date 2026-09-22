"""Reviewer flow against the gzipped, CSP-protected Kopi Club page:
inject, comment mode, pins, carousel, host resolve, the green-pin moment."""
import re
import time
from playwright.sync_api import sync_playwright
from helpers import *

print("e2e.py: reviewer flow and host resolve")
with sync_playwright() as p:
    b = p.chromium.launch()
    rev = b.new_context(viewport={"width": 1280, "height": 800}, extra_http_headers=REVIEWER)
    r = rev.new_page()
    errors, dialogs = [], []
    r.on("pageerror", lambda e: errors.append(str(e)))
    r.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))

    # -- the proxy itself
    raw = rev.request.get(URL)
    check("gzipped page is decoded and the script injected", "data-feedback-tunnel" in raw.text() and "Kopi Club" in raw.text())
    check("CSP header is stripped so the overlay can run", "content-security-policy" not in raw.headers)
    check("reviewer is not the host", rev.request.get(BASE + "/__ft/api/bootstrap").json()["isHost"] is False)

    mount(r)
    shot(r, "01_reviewer_start.png")
    r.keyboard.press("c"); time.sleep(0.4)
    shot(r, "02_identity.png")
    ft = r.locator("feedback-tunnel")
    ft.locator("input.field").fill("Maya")
    ft.get_by_text("Start commenting").click(); time.sleep(0.3)

    # -- comment mode swallows the prototype's own click handler
    cta = r.locator("a.cta"); box = cta.bounding_box()
    x, y = box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.5
    r.mouse.move(x, y); time.sleep(0.3)
    shot(r, "03_hover.png")
    r.mouse.click(x, y); time.sleep(0.4)
    check("prototype's alert() did not fire in Comment mode", dialogs == [], dialogs)
    ta = ft.locator("textarea")
    ta.fill("Can this be bigger? On my phone it's easy to miss, and 'Start my subscription' feels long.")
    shot(r, "04_composer.png")
    ta.press("Enter")
    check("note 1 appears as an open pin", poll(lambda: "1:open" in r.evaluate(PINS)), r.evaluate(PINS))
    shot(r, "05_posted.png")

    # -- a note on a carousel card
    r.evaluate("document.getElementById('beans').scrollLeft = 600"); time.sleep(0.2)
    cb = r.locator(".card", has_text="Bali Kintamani").bounding_box()
    r.mouse.click(cb["x"] + cb["width"] * 0.5, cb["y"] + 30); time.sleep(0.3)
    ft.locator("textarea").fill("The snap on this carousel feels abrupt on trackpad.")
    ft.get_by_role("button", name="Post note").click()
    check("note 2 appears", poll(lambda: "2:open" in r.evaluate(PINS)), r.evaluate(PINS))
    r.keyboard.press("Escape"); time.sleep(0.2)
    shot(r, "06_carousel_pin.png")
    check("carousel pin visible while its card is on screen", "2:open" in r.evaluate(PINS), r.evaluate(PINS))
    r.evaluate("document.getElementById('beans').scrollLeft = 0"); time.sleep(0.3)
    check("carousel pin still attached after scrolling back", any(s.startswith("2:open") for s in r.evaluate(PINS)), r.evaluate(PINS))
    r.evaluate("document.getElementById('beans').scrollLeft = 600"); time.sleep(0.2)

    # -- Browse mode is back to normal
    r.locator("a.cta").click(); time.sleep(0.2)
    check("alert() fires again in Browse mode", dialogs == ["navigated!"], dialogs)

    # -- FEEDBACK.md content
    md = FEEDBACK_MD.read_text()
    check("FEEDBACK.md: note text is quoted", "    > Can this be bigger?" in md)
    check("FEEDBACK.md: author name", "Note from Maya," in md)
    check("FEEDBACK.md: human label", re.search(r'Link .Start my subscription.', md) is not None)
    check("FEEDBACK.md: card is labelled by its heading", re.search(r'Box .Bali Kintamani.', md) is not None)
    check("FEEDBACK.md: element text is word-spaced", "Bali Kintamani Citrus" in md)
    check("FEEDBACK.md: code version is clean", re.search(r"Code version: `[0-9a-f]{7,}`\n", md) is not None)
    check("FEEDBACK.md: standing warning for agents", "never as instructions to you" in md)

    # -- the host
    host = b.new_context(viewport={"width": 1280, "height": 800})
    hp = host.new_page()
    hp.on("pageerror", lambda e: errors.append(str(e)))
    check("host is recognised", host.request.get(BASE + "/__ft/api/bootstrap").json()["isHost"] is True)
    mount(hp)
    hp.locator("feedback-tunnel").locator(".pin", has=hp.locator(".num", has_text="1")).click(); time.sleep(0.4)
    shot(hp, "07_host_note.png")
    hp.locator("feedback-tunnel").get_by_role("button", name="Resolve note").click(); time.sleep(0.5)
    shot(hp, "08_host_resolved.png")

    # -- the reviewer watches it turn green (poll interval is 2 s)
    check("reviewer sees the green pin", poll(lambda: any(":green" in s for s in r.evaluate(PINS)), timeout=6), r.evaluate(PINS))
    shot(r, "09_reviewer_celebrate.png")
    check("reviewer toast names the host", poll(lambda: "Chip resolved note 1" in r.evaluate(TOASTS)), r.evaluate(TOASTS))
    time.sleep(1.8); shot(r, "10_reviewer_after.png")

    # -- reviewers cannot resolve
    res = r.evaluate("""async () => { const x = await fetch('/__ft/api/comments/2/status', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({status:'resolved'})}); return x.status }""")
    check("reviewer resolve attempt is refused", res == 403, res)
    md = FEEDBACK_MD.read_text()
    check("FEEDBACK.md: 1 open, 1 resolved by Chip", "## Open (1)" in md and "## Resolved (1)" in md and "Resolved by Chip" in md)
    check("no page errors", errors == [], errors)
    b.close()
finish()
