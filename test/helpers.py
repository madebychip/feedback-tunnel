"""Shared bits for the Playwright suites. test/run.mjs sets the FT_* variables;
run a script by hand and it falls back to sensible defaults."""
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
URL = os.environ.get("FT_URL", "http://127.0.0.1:4000/")
BASE = URL.rstrip("/")
PROJECT = Path(os.environ.get("FT_PROJECT", HERE / ".work" / "project"))
SHOTS = Path(os.environ.get("FT_SHOTS", HERE / ".work" / "shots"))
FEEDBACK_MD = PROJECT / "FEEDBACK.md"
SHOTS.mkdir(parents=True, exist_ok=True)

# Every reviewer request in production arrives with Cloudflare's headers; this is the one that matters.
REVIEWER = {"cf-connecting-ip": "203.0.113.9"}

# Compact state of the overlay, read from inside its shadow root.
PINS = """() => [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.pin')]
  .map(p => (p.querySelector('.num')?.textContent || '✓') + (p.classList.contains('resolved') ? ':green' : ':open') + (p.hidden ? ':hidden' : ''))"""
TOASTS = """() => [...document.querySelector('feedback-tunnel').shadowRoot.querySelectorAll('.toast strong')].map(t => t.textContent)"""

_failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail != "" else ""))
    if not ok:
        _failures.append(name)
    return ok


def poll(fn, timeout=6.0, every=0.15):
    """Call fn until it returns something truthy; returns that value, or the last falsy one."""
    end = time.time() + timeout
    val = fn()
    while not val and time.time() < end:
        time.sleep(every)
        val = fn()
    return val


def shot(page, name):
    page.screenshot(path=str(SHOTS / name))


def mount(page, url=None):
    page.goto(url or URL)
    page.wait_for_selector("feedback-tunnel", state="attached", timeout=8000)
    time.sleep(0.8)  # overlay mounts 250 ms after load


def edit_md(old, new):
    """What a coding agent does: change a checkbox in FEEDBACK.md."""
    text = FEEDBACK_MD.read_text()
    assert old in text, f"{old!r} not in FEEDBACK.md"
    FEEDBACK_MD.write_text(text.replace(old, new))


def finish():
    print(f"\n  {len(_failures)} failed" if _failures else "\n  all checks passed")
    sys.exit(1 if _failures else 0)
