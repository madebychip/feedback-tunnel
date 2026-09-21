import time, re
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:4000/"
SH = "/home/claude/shots/"
with sync_playwright() as p:
    b = p.chromium.launch()
    rev = b.new_context(viewport={"width":1280,"height":800}, extra_http_headers={"cf-connecting-ip":"203.0.113.9"})
    r = rev.new_page()
    logs = []
    r.on("console", lambda m: logs.append(f"[rev {m.type}] {m.text}"))
    r.on("pageerror", lambda e: logs.append(f"[rev pageerror] {e}"))
    dialogs = []
    r.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    r.goto(URL); r.wait_for_selector("feedback-tunnel", state="attached", timeout=5000); time.sleep(0.6)
    r.screenshot(path=SH+"01_reviewer_start.png")
    r.keyboard.press("c"); time.sleep(0.4)
    r.screenshot(path=SH+"02_identity.png")
    r.locator("feedback-tunnel").locator(".opt[data-id=otter]").click()
    r.locator("feedback-tunnel").locator("input.field").fill("Maya")
    r.locator("feedback-tunnel").get_by_text("Start commenting").click(); time.sleep(0.3)
    cta = r.locator("a.cta"); box = cta.bounding_box()
    r.mouse.move(box["x"]+box["width"]*0.8, box["y"]+box["height"]*0.5); time.sleep(0.3)
    r.screenshot(path=SH+"03_hover.png")
    r.mouse.click(box["x"]+box["width"]*0.8, box["y"]+box["height"]*0.5); time.sleep(0.4)
    print("alert fired during comment mode:", dialogs)
    ta = r.locator("feedback-tunnel").locator("textarea")
    ta.fill("Can this be bigger? On my phone it's easy to miss, and 'Start my subscription' feels long.")
    r.screenshot(path=SH+"04_composer.png")
    ta.press("Control+Enter"); time.sleep(0.6)
    r.screenshot(path=SH+"05_posted.png")
    # carousel card 4
    r.evaluate("document.getElementById('beans').scrollLeft = 600"); time.sleep(0.2)
    card = r.locator(".card", has_text="Bali Kintamani"); cb = card.bounding_box()
    r.mouse.click(cb["x"]+cb["width"]*0.5, cb["y"]+30); time.sleep(0.3)
    r.locator("feedback-tunnel").locator("textarea").fill("The snap on this carousel feels abrupt on trackpad.")
    r.locator("feedback-tunnel").get_by_text("Post note").click(); time.sleep(0.5)
    r.keyboard.press("Escape"); time.sleep(0.2)
    r.screenshot(path=SH+"06_carousel_pin.png")
    vis = lambda: r.evaluate("""() => { const s = document.querySelector('feedback-tunnel').shadowRoot; return [...s.querySelectorAll('.pin')].map(p => ({n: p.querySelector('.num')?.textContent, hidden: p.hidden})) }""")
    print("pins while carousel scrolled:", vis())
    r.evaluate("document.getElementById('beans').scrollLeft = 0"); time.sleep(0.3)
    print("pins after carousel scrolled back:", vis())
    r.evaluate("document.getElementById('beans').scrollLeft = 600"); time.sleep(0.2)
    # browse mode works again
    r.locator("a.cta").click(); time.sleep(0.2)
    print("alert in browse mode:", dialogs)

    # Host
    host = b.new_context(viewport={"width":1280,"height":800})
    hp = host.new_page()
    hp.on("pageerror", lambda e: logs.append(f"[host pageerror] {e}"))
    hp.goto(URL); hp.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(0.8)
    hp.locator("feedback-tunnel").locator(".pin", has=hp.locator(".num", has_text="1")).click(); time.sleep(0.4)
    hp.screenshot(path=SH+"07_host_note.png")
    hp.locator("feedback-tunnel").get_by_role("button", name="Resolve").click(); time.sleep(0.5)
    hp.screenshot(path=SH+"08_host_resolved.png")
    # Reviewer sees green pin (poll every 2s)
    time.sleep(1.6); r.screenshot(path=SH+"09_reviewer_celebrate_mid.png")
    time.sleep(1.8); r.screenshot(path=SH+"10_reviewer_after.png")
    print("reviewer pin classes:", r.evaluate("""() => [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.pin')].map(p=>p.className)"""))
    print("reviewer toasts:", r.evaluate("""() => [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.toast strong')].map(t=>t.textContent)"""))
    # reviewer cannot resolve
    import json
    res = r.evaluate("""async () => { const x = await fetch('/__ft/api/comments/2/status', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({status:'resolved'})}); return [x.status, await x.text()] }""")
    print("reviewer resolve attempt:", res)
    open(SH+"state.txt","w").write("ok")
    print("\n".join(logs) or "no console errors")
    b.close()
