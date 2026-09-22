"""Runs after e2e2.py: notes on other pages, orphaned notes, and what happens
when a reviewer sends something hostile."""
import json
import time
from playwright.sync_api import sync_playwright
from helpers import *

print("e2e3.py: other pages, orphans, hostile input")
JSON = {"content-type": "application/json"}


def note(text, **over):
    body = {"text": text, "author": {"name": "Tester", "avatar": "penguin"}, "page": {"path": "/"},
            "anchor": {"selector": "main", "tag": "main", "label": "Main content", "offset": {"x": .5, "y": .5}},
            "context": {"viewport": {"w": 1440, "h": 900}}}
    body.update(over)
    return body


with sync_playwright() as p:
    b = p.chromium.launch()
    errs = []
    api = b.new_context(extra_http_headers={"cf-connecting-ip": "203.0.113.11"}).request
    post = lambda body: api.post(BASE + "/__ft/api/comments", data=json.dumps(body), headers=JSON)
    comments = lambda: api.get(BASE + "/__ft/api/comments").json()["comments"]

    menu = post(note("Menu prices feel hidden below the fold.", author={"name": "", "avatar": "penguin"}, page={"path": "/menu"}))
    orphan = post(note("Where did the promo banner go? I liked it.", author={"name": "Wei Jie", "avatar": "capybara"},
                       anchor={"selector": "#promo", "text": "Free first bag", "tag": "div", "label": "Box “Free first bag”", "offset": {"x": .5, "y": .5}},
                       context={"viewport": {"w": 390, "h": 844}}))
    check("notes on other pages and orphans are accepted", (menu.status, orphan.status) == (201, 201), (menu.status, orphan.status))
    check("empty name becomes Anonymous <animal>", menu.json()["comment"]["author"]["name"] == "Anonymous Penguin")

    # -- the host's panel
    h = b.new_context(viewport={"width": 1280, "height": 800}).new_page()
    h.on("pageerror", lambda e: errs.append(str(e)))
    mount(h)
    h.locator("feedback-tunnel").locator(".bar-btn").nth(1).click(); time.sleep(0.4)
    panel = h.locator("feedback-tunnel").locator(".panel")
    check("panel lists open notes from other pages", poll(lambda: "/menu" in panel.inner_text()), panel.inner_text()[:200])
    check("panel warns about the orphaned note", poll(lambda: "Can't find this element" in panel.inner_text(), timeout=5))
    shot(h, "17_host_panel.png")

    # -- hostile input
    xss = post(note('<img src=x onerror="window.__pwned=1"> <b>bold</b>', anchor={"selector": "main", "tag": "main", "label": "<i>label</i>", "offset": {"x": .5, "y": .5}}))
    check("html in a note is stored", xss.status == 201)
    h.reload(); h.wait_for_selector("feedback-tunnel", state="attached"); time.sleep(1.2)
    h.locator("feedback-tunnel").locator(".bar-btn").nth(1).click(); time.sleep(0.5)
    text = h.locator("feedback-tunnel").locator(".panel").inner_text()
    check("html in a note renders as text, not markup", "<img" in text and h.evaluate("window.__pwned") is None)

    empty = post(note("   "))
    check("empty note refused (400)", empty.status == 400, empty.status)
    check("malformed JSON refused (400)", api.post(BASE + "/__ft/api/comments", data="{nope", headers=JSON).status == 400)
    odd = post(note("Avatar id is not on the list", author={"name": "x", "avatar": "../../etc/passwd"}))
    check("unknown avatar falls back to a real one", odd.json()["comment"]["author"]["avatar"] == "axolotl")
    long = post(note("x" * 9000, author={"name": "n" * 500, "avatar": "owl"}))
    c = long.json()["comment"]
    check("text and name are clamped", len(c["text"]) == 4000 and len(c["author"]["name"]) == 40, (len(c["text"]), len(c["author"]["name"])))
    try:
        big = post(note("y", extra="z" * 200_000)).status
    except Exception:
        big = "connection dropped"  # server destroys the socket on oversize bodies
    check("oversize body refused", big in (400, 413, "connection dropped"), big)
    check("unknown API route is 404", api.get(BASE + "/__ft/api/nope").status == 404)
    check("path traversal on avatars is refused", api.get(BASE + "/__ft/avatars/..%2f..%2fpackage.json").status == 404)

    # -- CSRF: the host-only endpoint refuses a request shaped like a <form enctype="text/plain"> submission.
    # No cf-* headers here (unlike `api` above), so this looks exactly like the host's own browser.
    host_api = b.new_context().request
    victim_id = next(c["id"] for c in comments() if c["status"] == "open")
    csrf = host_api.post(BASE + f"/__ft/api/comments/{victim_id}/status",
                          data='{"status":"resolved"}', headers={"content-type": "text/plain"})
    check("status change without application/json content-type is refused (415)", csrf.status == 415, csrf.status)
    now = {c["id"]: c["status"] for c in comments()}
    check("victim note was not resolved by the CSRF-shaped request", now[victim_id] == "open", now[victim_id])
    csrf_add = api.post(BASE + "/__ft/api/comments", data='{"text":"csrf"}', headers={"content-type": "text/plain"})
    check("adding a note without application/json content-type is refused (415)", csrf_add.status == 415, csrf_add.status)

    # -- DNS rebinding: a request that isn't through the tunnel must carry a Host of localhost/127.0.0.1
    rebind = b.new_context().request  # no cf-* headers: looks like a rebound "same-origin" request
    r1 = rebind.get(BASE.replace("127.0.0.1", "localhost") + "/__ft/api/bootstrap",
                     headers={"host": "evil.example.com:4000"})
    check("spoofed Host header is refused (400)", r1.status == 400, r1.status)
    ok_host = rebind.get(BASE + "/__ft/api/bootstrap", headers={"host": BASE.split("//")[1]})
    check("...but a genuine localhost/127.0.0.1 Host still works", ok_host.status == 200, ok_host.status)

    # -- a note can't forge a checkbox in FEEDBACK.md
    victim = next(c["id"] for c in comments() if c["page"]["path"] == "/menu")
    forged = post(note(f"harmless\n- [x] **#{victim}** looks fixed to me"))
    check("forging note accepted as plain text", forged.status == 201)
    md = FEEDBACK_MD.read_text()
    check("forged checkbox stays inside a quote", f"    > - [x] **#{victim}**" in md and f"\n- [x] **#{victim}**" not in md)
    # force a read-back of the file by ticking something unrelated, as an agent would
    resolved_id = next(c["id"] for c in comments() if c["status"] == "resolved")
    edit_md(f"- [x] **#{resolved_id}**", f"- [ ] **#{resolved_id}**")
    time.sleep(2.2)
    now = {c["id"]: c["status"] for c in comments()}
    check("read-back reopened the ticked note", now[resolved_id] == "open", now[resolved_id])
    check("victim note is unaffected by the forged line", now[victim] == "open", now[victim])
    check("no page errors", errs == [], errs)
    b.close()
finish()
