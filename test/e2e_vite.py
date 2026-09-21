import time, re
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:4100/"; APP = "/home/claude/viteapp/src/App.jsx"; MD = "/home/claude/viteapp/FEEDBACK.md"
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width":1100,"height":700}, extra_http_headers={"cf-connecting-ip":"203.0.113.9"})
    r = ctx.new_page(); errs = []; ws = []
    r.on("pageerror", lambda e: errs.append(str(e)))
    r.on("websocket", lambda w: ws.append(w.url))
    r.goto(URL); r.wait_for_selector("feedback-tunnel", state="attached"); r.wait_for_selector("text=Choose Pair"); time.sleep(0.8)
    r.evaluate("localStorage.setItem('feedback-tunnel:me', JSON.stringify({name:'Farah',avatar:'fox',custom:true}))")
    r.reload(); r.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(0.8)
    print("websockets:", ws)
    r.keyboard.press("c")
    bb = r.get_by_text("Choose Pair").bounding_box()
    r.mouse.click(bb["x"]+bb["width"]*0.5, bb["y"]+bb["height"]*0.5); time.sleep(0.3)
    r.locator("feedback-tunnel").locator("textarea").fill("Make this the recommended plan, with a filled button.")
    r.locator("feedback-tunnel").locator("textarea").press("Control+Enter"); time.sleep(0.8)
    r.keyboard.press("Escape")
    md = open(MD).read()
    print(re.search(r"- \[ \] \*\*#1\*\*.*?(?=\n\n|\n## )", md, re.S).group(0))
    # A coding agent edits the component: HMR should update in place, and the pin should stay put
    src = open(APP).read()
    open(APP, "w").write(src.replace("<button>Choose {name}</button>", "<button style={{background: name === 'Pair' ? '#1a73e8' : 'white', color: name === 'Pair' ? 'white' : 'black', padding: '8px 14px', border: '1px solid #1a73e8', borderRadius: 6}}>Choose {name}</button>"))
    time.sleep(1.5)
    bg = r.evaluate("getComputedStyle([...document.querySelectorAll('button')].find(b => b.textContent === 'Choose Pair')).backgroundColor")
    print("button background after HMR (no reload):", bg, "| overlay still mounted:", r.evaluate("!!document.querySelector('feedback-tunnel')"))
    print("pin after HMR:", r.evaluate("""() => [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.pin')].map(p => p.hidden ? 'hidden' : p.style.transform)"""))
    # Agent ticks the box
    open(MD, "w").write(open(MD).read().replace("- [ ] **#1**", "- [x] **#1**")); time.sleep(3)
    r.screenshot(path="/home/claude/shots/16_vite_after_fix.png")
    print("toasts:", r.evaluate("""() => [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.toast strong')].map(t=>t.textContent)"""))
    print("errors:", errs or "none")
    b.close()
