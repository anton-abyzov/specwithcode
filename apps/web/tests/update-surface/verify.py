#!/usr/bin/env python3
"""Headless update-surface fixtures; the bridge, update agent and server are in-memory mocks."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--node", default=str(Path.home() / ".local/share/specweave-studio/toolchains/node-v24.13.1-darwin-arm64/bin/node"))
parser.add_argument("--chromium", default=str(Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"))
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
log = (args.output / "server.log").open("w")
env = dict(os.environ, PWDEBUG="0", PLAYWRIGHT_HTML_OPEN="never", UPDATE_SURFACE_PORT="0")
server = subprocess.Popen([args.node, str(Path(__file__).with_name("serve.mjs"))], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
receipt = {"synthetic": True, "installs": 0, "sourceRoot": str(root), "ownedServerPid": server.pid, "checks": [], "screenshots": [], "pageErrors": [], "blockedExternalRequests": []}
# The sidebar footer and the dialog sit in the bottom-left and centre; crops keep them legible.
FOOTER = {"x": 0, "y": 560, "width": 620, "height": 340}
try:
    deadline = time.monotonic() + 30
    info = None
    while time.monotonic() < deadline:
        for line in (args.output / "server.log").read_text().splitlines():
            if line.startswith('{"fixture"'):
                info = json.loads(line)
                break
        if info:
            break
        if server.poll() is not None:
            raise RuntimeError("Fixture server exited; inspect server.log")
        time.sleep(0.1)
    if info is None:
        raise RuntimeError("Fixture server did not become ready")
    origin = info["origin"]
    receipt["origin"] = origin
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=args.chromium)
        try:
            for theme in ["light", "dark"]:
                dark = theme == "dark"

                def open_scene(scene):
                    context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2, color_scheme=theme)
                    page = context.new_page()
                    page.on("pageerror", lambda error: receipt["pageErrors"].append(str(error)))

                    def route_request(route):
                        if route.request.url.startswith(origin + "/") or route.request.url.startswith(("data:", "blob:")):
                            route.continue_()
                        else:
                            receipt["blockedExternalRequests"].append(route.request.url)
                            route.abort()
                    page.route("**/*", route_request)

                    def route_socket(route):
                        if route.url.startswith(origin.replace("http:", "ws:") + "/"):
                            route.connect_to_server()
                        else:
                            receipt["blockedExternalRequests"].append(route.url)
                            route.close()
                    page.route_web_socket("**/*", route_socket)
                    page.goto(f"{origin}/?scene={scene}", wait_until="domcontentloaded")
                    page.evaluate("dark => document.documentElement.classList.toggle('dark', dark)", dark)
                    expect(page.get_by_test_id("sidebar-footer")).to_be_attached(timeout=60_000)
                    return context, page

                def capture(page, name, clip=None):
                    path = args.output / f"{name}-{theme}.png"
                    page.screenshot(path=str(path), animations="disabled", **({"clip": clip} if clip else {}))
                    receipt["screenshots"].append(str(path))

                # 1-3. Restart to update: idle, tooltip, three-choice dialog, waiting for idle.
                context, page = open_scene("restart")
                button = page.get_by_test_id("sidebar-restart-to-update")
                expect(button).to_be_visible(timeout=60_000)
                expect(button).to_have_text("Restart to update")
                sparkle = page.get_by_role("button", name="What's new in 1.0.25", exact=True)
                expect(sparkle).to_be_visible()
                capture(page, "1-restart-idle")
                capture(page, "1-restart-idle-footer", FOOTER)
                button.hover()
                tooltip = page.get_by_text("Warns before an update restart cuts off running jobs", exact=True)
                expect(tooltip).to_be_visible()
                expect(page.get_by_text("and 1 more", exact=True)).to_be_visible()
                page.wait_for_timeout(300)
                capture(page, "1-restart-tooltip")
                capture(page, "1-restart-tooltip-footer", FOOTER)
                page.mouse.move(900, 200)
                button.click()
                dialog = page.get_by_role("alertdialog")
                expect(dialog).to_be_visible()
                expect(dialog.get_by_text("Restart to install SpecWithCode 1.0.25 now?", exact=True)).to_be_visible()
                for label in ["Restart when idle", "Restart now", "Cancel"]:
                    expect(dialog.get_by_role("button", name=label, exact=True)).to_be_visible()
                description = dialog.inner_text()
                assert "3 jobs are still running" in description and "1 message is queued" in description, description
                page.wait_for_timeout(300)
                capture(page, "2-restart-dialog")
                dialog.get_by_role("button", name="Restart when idle", exact=True).click()
                expect(dialog).not_to_be_visible()
                expect(button).to_have_text("Restarts when idle")
                page.mouse.move(900, 200)
                page.wait_for_timeout(300)
                capture(page, "3-restarts-when-idle")
                capture(page, "3-restarts-when-idle-footer", FOOTER)
                data = page.evaluate("window.__updateSurfaceReceipts")
                assert data["installCalls"] == [], "Restart when idle must not install yet"
                assert any(call["input"] == {"stopWork": False} for call in data["prepareCalls"]), data["prepareCalls"]
                receipt["checks"].append({"scene": "restart", "theme": theme, "sparkleButton": True, "tooltipReleaseNotes": True, "threeChoiceDialog": True, "waitingLabel": "Restarts when idle", "installCalls": 0, "prepareCalls": len(data["prepareCalls"])})
                context.close()

                # 4. Remote server behind the client with one-click self-update.
                context, page = open_scene("server")
                row = page.get_by_test_id("sidebar-server-update")
                expect(row).to_be_visible(timeout=60_000)
                expect(row.get_by_text("Server update", exact=True)).to_be_visible()
                expect(row.get_by_role("button", name="Update", exact=True)).to_be_enabled()
                capture(page, "4-server-update")
                capture(page, "4-server-update-footer", FOOTER)
                row.get_by_text("Server update", exact=True).hover()
                expect(page.get_by_text("1.0.20", exact=False)).to_be_visible()
                page.wait_for_timeout(300)
                capture(page, "4-server-update-tooltip-footer", FOOTER)
                receipt["checks"].append({"scene": "server", "theme": theme, "selfUpdate": "boot-service", "row": True, "updateButton": True})
                context.close()

                # A server with no self-update path renders nothing.
                context, page = open_scene("server-none")
                page.wait_for_timeout(1500)
                assert page.get_by_test_id("sidebar-server-update").count() == 0
                assert page.get_by_test_id("sidebar-footer").inner_text().strip() == ""
                receipt["checks"].append({"scene": "server-none", "theme": theme, "selfUpdate": None, "rendersNothing": True})
                context.close()
            assert receipt["pageErrors"] == [], receipt["pageErrors"]
            assert receipt["blockedExternalRequests"] == [], receipt["blockedExternalRequests"]
            receipt["passed"] = True
        finally:
            browser.close()
finally:
    if server.poll() is None:
        server.terminate()  # Only the exact Node process launched by this runner.
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
    log.close()
    receipt["ownedServerExitCode"] = server.returncode
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"passed": receipt.get("passed", False), "checks": len(receipt["checks"]), "screenshots": len(receipt["screenshots"]), "receipt": str(args.output / "receipt.json")}))
