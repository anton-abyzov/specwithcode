#!/usr/bin/env python3
"""Headless visual fixtures; every provider/native mutation is an in-memory mock."""
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
env = dict(os.environ, PWDEBUG="0", PLAYWRIGHT_HTML_OPEN="never", COORDINATOR_REVIEW_PORT="0")
server = subprocess.Popen([args.node, str(Path(__file__).with_name("serve.mjs"))], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
receipt = {"synthetic": True, "providerCalls": 0, "nativeRuntime": "mocked", "sourceRoot": str(root), "ownedServerPid": server.pid, "checks": [], "screenshots": [], "pageErrors": [], "blockedExternalRequests": []}
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
            for label, width, height, dark in [("desktop-light", 1440, 1000, False), ("390-dark", 390, 844, True)]:
                for scenario in ["approval", "file-approval", "file-approval-no-patch", "question", "plan", "activity"]:
                    context = browser.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", is_mobile=width == 390, has_touch=width == 390)
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
                    page.goto(f"{origin}/?request={scenario}", wait_until="domcontentloaded")
                    page.evaluate("dark => document.documentElement.classList.toggle('dark', dark)", dark)
                    expect(page.locator("#project-prompt")).to_be_visible(timeout=60_000)
                    page.locator("#project-prompt").fill("Preserve this coordinator draft.")
                    permission = page.get_by_role("combobox", name="Project permissions", exact=True)
                    expect(permission).to_be_visible()
                    permission.select_option("full-access")
                    calls = page.evaluate("window.__projectCalls")
                    assert any(call.get("args", {}).get("input", {}).get("patch", {}).get("projectSettingsOverrides") for call in calls), "Project permission must save through project settings"

                    if scenario == "activity":
                        page.locator("[data-timeline-detail]").click()
                        page.get_by_role("menuitemradio", name="Verbose", exact=False).click()
                        trigger = page.get_by_role("button", name="View tool output", exact=True)
                    else:
                        trigger = page.get_by_role("button", name={"approval": "Review the request", "file-approval": "Review the request", "file-approval-no-patch": "Review the request", "question": "Answer the coordinator", "plan": "Review the plan"}[scenario], exact=True)
                    trigger.focus()
                    trigger.click()
                    dialog = page.get_by_role("dialog", name="Coordinator activity" if scenario == "activity" else "Coordinator requests", exact=True)
                    expect(dialog).to_be_visible()
                    close_name = "Close activity" if scenario == "activity" else "Close review"
                    expect(dialog.get_by_role("button", name=close_name, exact=True)).to_be_focused()
                    assert page.locator("form.project-composer").count() == 1
                    assert dialog.locator("form").count() == 0
                    assert page.get_by_role("button", name="Back to coordinator", exact=True).count() == 0
                    box = dialog.bounding_box()
                    assert box is not None and box["x"] >= -1 and box["y"] >= -1 and box["x"] + box["width"] <= width + 1 and box["y"] + box["height"] <= height + 1
                    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
                    def capture(suffix):
                        path = args.output / f"{scenario}-{label}{suffix}.png"
                        page.screenshot(path=str(path), full_page=True, animations="disabled")
                        receipt["screenshots"].append(str(path))
                    if scenario in ("approval", "file-approval", "file-approval-no-patch"):
                        expect(dialog.get_by_role("button", name="Approve", exact=True)).to_have_attribute("data-slot", "button")
                        if scenario.startswith("file-approval"):
                            path = dialog.get_by_label("File path", exact=True)
                            expect(path).to_have_text("/workspace/long directory/selected project/source/value.cjs")
                            path.focus()
                            expect(path).to_be_focused()
                            assert path.evaluate("node => node.scrollWidth <= node.clientWidth + 1")
                            if scenario == "file-approval":
                                patch = dialog.get_by_label("Supplied patch", exact=True)
                                expect(patch).to_have_text("--- a/value.cjs\n+++ b/value.cjs\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;")
                                patch.focus()
                                expect(patch).to_be_focused()
                                expect(dialog.get_by_text("Preview unavailable", exact=True)).to_have_count(0)
                            else:
                                expect(dialog.get_by_text("Preview unavailable", exact=True)).to_be_visible()
                                expect(dialog.get_by_label("Supplied patch", exact=True)).to_have_count(0)
                            expect(dialog.get_by_text("Provider process is gone", exact=False)).to_have_count(0)
                        capture("")
                        dialog.get_by_role("button", name="Approve", exact=True).click()
                        expect(dialog).not_to_be_visible()
                        data = page.evaluate("window.__coordinatorReviewReceipts.approvals")
                        assert len(data) == 1 and data[0]["threadId"] == "coord" and data[0]["environmentId"] == "host"
                        assert data[0]["requestId"] == ("fixture-edit-approval" if scenario.startswith("file-approval") else "fixture-approval")
                        assert data[0]["decision"] == "accept"
                    elif scenario == "question":
                        expect(dialog.get_by_role("button", name="Next question", exact=True)).to_be_disabled()
                        capture("-choices")
                        dialog.get_by_role("button", name="Project reports", exact=False).click()
                        expect(dialog.get_by_text("What should the review focus on? You can attach supporting files.", exact=True)).to_be_visible()
                        answer = dialog.get_by_label("Your answer", exact=True)
                        expect(answer).to_be_visible()
                        answer.fill("Check the recovery flow and preserve the draft.")
                        picker = dialog.get_by_label("Choose answer attachments", exact=True)
                        picker.set_input_files({"name": "supporting-notes.txt", "mimeType": "text/plain", "buffer": b"Synthetic local fixture notes."})
                        expect(dialog.get_by_text("Ready", exact=True)).to_be_visible()
                        expect(dialog.get_by_role("button", name="Attach to answer", exact=True)).to_have_attribute("data-slot", "button")
                        capture("-answer")
                        dialog.get_by_role("button", name="Remove supporting-notes.txt", exact=True).click()
                        expect(dialog.get_by_role("list", name="Attached to this answer", exact=True)).to_have_count(0)
                        picker.set_input_files({"name": "supporting-notes.txt", "mimeType": "text/plain", "buffer": b"Synthetic local fixture notes."})
                        expect(dialog.get_by_text("Ready", exact=True)).to_be_visible()
                        dialog.get_by_role("button", name="Send answer", exact=True).click()
                        expect(dialog).not_to_be_visible()
                        data = page.evaluate("window.__coordinatorReviewReceipts")
                        assert data["answers"][0]["requestId"] == "fixture-question"
                        assert data["answers"][0]["answers"]["destination"] == "Project reports"
                        assert data["answers"][0]["attachments"][1]["names"] == ["supporting-notes.txt"]
                        assert len(data["releases"]) == 1
                        assert all("fixture-question" in upload["draftTarget"] for upload in data["uploads"])
                    elif scenario == "plan":
                        expect(dialog.get_by_role("button", name="Implement plan", exact=True)).to_have_attribute("data-slot", "button")
                        capture("")
                        dialog.get_by_role("button", name="Implement plan", exact=True).click()
                        assert page.evaluate("window.__coordinatorReviewReceipts.plans") == [{"synthetic": True, "action": "implement"}]
                    else:
                        assert page.evaluate("window.__coordinatorReviewReceipts.outputReads") == []
                        capture("-collapsed")
                        dialog.locator("details summary").click()
                        expect(dialog.get_by_text("Synthetic fixture output. No command was executed.", exact=False)).to_be_visible()
                        capture("-output")
                        data = page.evaluate("window.__coordinatorReviewReceipts.outputReads")
                        assert len(data) > 0 and all(entry["itemId"] == "fixture-command" and entry["threadId"] == "coord" for entry in data)
                    if scenario != "activity":
                        expect(dialog).not_to_be_visible()
                        capture("-resolved")
                    page.keyboard.press("Escape")
                    expect(dialog).not_to_be_visible()
                    expect(trigger).to_be_focused()
                    expect(page.locator("#project-prompt")).to_have_value("Preserve this coordinator draft.")
                    trigger.click()
                    expect(dialog).to_be_visible()
                    dialog.get_by_role("button", name=close_name, exact=True).click()
                    expect(dialog).not_to_be_visible()
                    expect(trigger).to_be_focused()
                    receipt["checks"].append({"scenario": scenario, "layout": label, "namedDialog": True, "singleMessageComposer": True, "preservedDraft": True, "closeAndEscapeRestoreFocus": True, "fitsViewport": True, "decisions": "synthetic in-memory callbacks only"})
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
