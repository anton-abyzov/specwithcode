"""Run against the isolated fixture, never a live SpecWithCode service."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

os.environ["PWDEBUG"] = "0"
os.environ["PLAYWRIGHT_HTML_OPEN"] = "never"
out = Path(os.environ.get("PHONE_SETUP_EVIDENCE", "/Users/you/.specwithcode/m4/evidence/phone-setup-1014"))
out.mkdir(parents=True, exist_ok=True)
checks = []

def check(label, condition):
    assert condition, label
    checks.append(label)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get("PLAYWRIGHT_EXECUTABLE", "/Users/you/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"))
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    def reset(theme="light"):
        page.goto(f"http://127.0.0.1:4394/?theme={theme}")
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("button", name="Pair a phone", exact=True)).to_be_visible()
    def open_setup():
        page.get_by_role("button", name="Pair a phone", exact=True).click()
        expect(page.get_by_role("dialog")).to_be_visible()
        page.wait_for_function("document.getAnimations().every(a => a.playState !== 'running')")
    reset()
    open_setup()
    check("Opening setup does not mint a credential", page.evaluate("phoneFixture.calls === 0"))
    expect(page.get_by_text("Install Tailscale on your iPhone.", exact=False)).to_be_visible()
    check("Preflight has no QR", page.get_by_role("img", name="Pairing code for the SpecWithCode iPhone app").count() == 0)
    page.screenshot(path=str(out / "setup-light.png"), full_page=True)
    page.get_by_role("button", name="Generate pairing code", exact=True).click()
    expect(page.get_by_role("img", name="Pairing code for the SpecWithCode iPhone app")).to_be_visible()
    check("Generate mints once using only delegated scopes", page.evaluate("phoneFixture.calls === 1 && phoneFixture.scopes.length === 2"))
    page.wait_for_function("document.getAnimations().every(a => a.playState !== 'running')")
    page.screenshot(path=str(out / "qr-light.png"), full_page=True)
    # Let the actual component clock cross the fixture's five-second server deadline.
    expect(page.get_by_text("This code expired.", exact=False)).to_be_visible(timeout=8000)
    check("Expired QR and copy action are hidden", page.get_by_role("img").count() == 0 and page.get_by_role("button", name="Copy pairing link").count() == 0)
    page.get_by_role("button", name="Generate new code", exact=True).click()
    expect(page.get_by_role("img", name="Pairing code for the SpecWithCode iPhone app")).to_be_visible()
    check("Expired code can be renewed in place", page.evaluate("phoneFixture.calls === 2"))
    # Simulate an external endpoint update while the modal is open.
    page.evaluate("document.querySelector('aside button').click()")
    expect(page.get_by_text("The computer address changed.", exact=False)).to_be_visible()
    check("Route change hides existing QR and copy action", page.get_by_role("img").count() == 0 and page.get_by_role("button", name="Copy pairing link").count() == 0)
    page.get_by_role("button", name="Generate new code", exact=True).click()
    expect(page.get_by_role("img", name="Pairing code for the SpecWithCode iPhone app")).to_be_visible()
    check("New route uses a fresh credential", page.evaluate("phoneFixture.calls === 3"))
    page.evaluate("[...document.querySelectorAll('aside button')].find(b=>b.textContent==='Revoke permission').click()")
    expect(page.get_by_role("alert")).to_be_visible()
    check("Permission loss hides credential controls", page.get_by_role("img").count() == 0 and page.get_by_role("button", name="Copy pairing link").count() == 0)
    reset()
    page.get_by_role("button", name="Remove route", exact=True).click()
    open_setup()
    check("Missing route cannot mint a credential", page.get_by_role("button", name="Generate pairing code").count() == 0 and page.evaluate("phoneFixture.calls === 0"))
    page.get_by_role("button", name="Set up Tailscale HTTPS", exact=True).click()
    expect(page.get_by_text("Access settings opened", exact=True)).to_be_visible()
    expect(page.get_by_role("dialog")).not_to_be_visible()
    checks.append("Access action closes setup and opens existing settings")
    reset()
    open_setup()
    page.evaluate("phoneFixture.reject = true")
    page.get_by_role("button", name="Generate pairing code", exact=True).click()
    expect(page.get_by_role("alert")).to_have_text("Synthetic credential failure")
    page.evaluate("phoneFixture.reject = false")
    page.get_by_role("button", name="Generate pairing code", exact=True).click()
    expect(page.get_by_role("img", name="Pairing code for the SpecWithCode iPhone app")).to_be_visible()
    check("Credential errors are recoverable without leaving setup", page.evaluate("phoneFixture.calls === 2"))
    reset()
    open_setup()
    page.evaluate("phoneFixture.delay = true")
    page.get_by_role("button", name="Generate pairing code", exact=True).click()
    page.get_by_role("button", name="Close", exact=True).first.click()
    page.evaluate("phoneFixture.resolve()")
    open_setup()
    check("Cancelled in-flight response does not reopen or expose a code", page.get_by_role("img").count() == 0)
    reset("dark")
    open_setup()
    page.screenshot(path=str(out / "setup-dark.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path=str(out / "setup-narrow.png"), full_page=True)
    check("Narrow setup has no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    check("No browser page errors", not errors)
    browser.close()
(out / "browser-results.json").write_text(json.dumps({"headless": True, "checks": checks, "count": len(checks), "pageErrors": errors}, indent=2))
print(f"PASS: {len(checks)} checks; {out / 'browser-results.json'}")
