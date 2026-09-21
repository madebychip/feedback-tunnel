import time, json
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    # a note on another page, and an orphan (element that no longer exists)
    api = b.new_context(extra_http_headers={"cf-connecting-ip":"203.0.113.11"}).request
    api.post("http://127.0.0.1:4000/__ft/api/comments", data=json.dumps({"text":"Menu prices feel hidden below the fold.","author":{"name":"","avatar":"penguin"},"page":{"path":"/menu"},"anchor":{"selector":"main","tag":"main","label":"Main content","offset":{"x":.5,"y":.5}},"context":{"viewport":{"w":1440,"h":900}}}), headers={"content-type":"application/json"})
    api.post("http://127.0.0.1:4000/__ft/api/comments", data=json.dumps({"text":"Where did the promo banner go? I liked it.","author":{"name":"Wei Jie","avatar":"capybara"},"page":{"path":"/"},"anchor":{"selector":"#promo","text":"Free first bag","tag":"div","label":"Box “Free first bag”","offset":{"x":.5,"y":.5}},"context":{"viewport":{"w":390,"h":844}}}), headers={"content-type":"application/json"})
    h = b.new_context(viewport={"width":1280,"height":800}).new_page()
    h.goto("http://127.0.0.1:4000/"); h.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(1)
    h.locator("feedback-tunnel").locator(".bar-btn").nth(1).click(); time.sleep(0.4)
    h.screenshot(path="/home/claude/shots/17_host_panel.png")
    b.close()
