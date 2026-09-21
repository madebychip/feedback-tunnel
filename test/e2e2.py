import time, re
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:4000/"; SH = "/home/claude/shots/"; MD = "/home/claude/testproj/FEEDBACK.md"
PINS = """() => [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.pin')].map(p => (p.querySelector('.num')?.textContent||'✓') + (p.classList.contains('resolved')?':green':':open') + (p.hidden?':hidden':''))"""
TOASTS = """() => [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.toast strong')].map(t=>t.textContent)"""
with sync_playwright() as p:
    b = p.chromium.launch()
    # --- Agent ticks the box while the reviewer watches
    ctx = b.new_context(viewport={"width":1280,"height":800}, extra_http_headers={"cf-connecting-ip":"203.0.113.9"})
    r = ctx.new_page(); errs = []
    r.on("pageerror", lambda e: errs.append(str(e)))
    r.goto(URL); r.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(1)
    r.evaluate("document.getElementById('beans').scrollLeft = 600"); time.sleep(0.3)
    print("before agent:", r.evaluate(PINS))
    md = open(MD).read()
    open(MD, "w").write(md.replace("- [ ] **#2**", "- [x] **#2**"))   # what Claude Code would do
    time.sleep(3.2)
    print("after agent:", r.evaluate(PINS), r.evaluate(TOASTS))
    r.screenshot(path=SH+"11_agent_resolved.png")
    print("FEEDBACK.md now:", re.findall(r"## (Open|Resolved) \((\d+)\)", open(MD).read()), "| resolved-by line:", re.findall(r"Resolved by [^,\n]+", open(MD).read()))

    # --- Hot-reload wipe: reopen #2, reviewer reloads, then #2 gets resolved while page is gone
    md = open(MD).read(); open(MD, "w").write(md.replace("- [x] **#2**", "- [ ] **#2**")); time.sleep(2.5)
    r.reload(); r.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(1)
    print("reopened, reviewer sees:", r.evaluate(PINS))
    r.close()
    md = open(MD).read(); open(MD, "w").write(md.replace("- [ ] **#2**", "- [x] **#2**")); time.sleep(1.5)
    r = ctx.new_page(); r.on("pageerror", lambda e: errs.append(str(e)))
    r.goto(URL); r.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(1.2)
    print("after reload, toasts:", r.evaluate(TOASTS))

    # --- Narrow carousel: pins must hide when their card scrolls out of the clip
    r.evaluate("""() => { const c = document.getElementById('beans'); c.style.width='560px'; c.style.margin='0 auto'; c.scrollLeft = 0; }"""); time.sleep(0.3)
    print("narrow carousel at 0:", r.evaluate(PINS))
    r.evaluate("document.getElementById('beans').scrollLeft = 700"); time.sleep(0.3)
    print("narrow carousel at 700:", r.evaluate(PINS))
    r.screenshot(path=SH+"12_narrow_carousel.png")
    ctx.close()

    # --- Phone
    iphone = p.devices["iPhone 13"]
    m = b.new_context(**iphone, extra_http_headers={"cf-connecting-ip":"203.0.113.10"})
    mp = m.new_page(); mp.on("pageerror", lambda e: errs.append(str(e)))
    mp.goto(URL); mp.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(1)
    mp.screenshot(path=SH+"13_phone_start.png")
    mp.locator("feedback-tunnel").locator(".bar .comment").tap(); time.sleep(0.3)
    mp.locator("feedback-tunnel").locator(".opt[data-id=owl]").tap()
    mp.locator("feedback-tunnel").get_by_text("Start commenting").tap(); time.sleep(0.3)
    btn = mp.get_by_text("Choose Pair"); btn.scroll_into_view_if_needed(); time.sleep(0.3)
    bb = btn.bounding_box(); mp.touchscreen.tap(bb["x"]+bb["width"]/2, bb["y"]+bb["height"]/2); time.sleep(0.4)
    mp.locator("feedback-tunnel").locator("textarea").fill("Pair is the plan most people pick. Could it be highlighted?")
    mp.screenshot(path=SH+"14_phone_composer.png")
    print("visual viewport:", mp.evaluate("[visualViewport.offsetLeft, visualViewport.offsetTop, visualViewport.scale, innerWidth]"))
    mp.locator("feedback-tunnel").get_by_text("Post note").dispatch_event("click"); time.sleep(0.5)
    mp.screenshot(path=SH+"15_phone_posted.png")
    print("phone pins:", mp.evaluate(PINS))
    print("errors:", errs or "none")
    b.close()
