#!/usr/bin/env python3
"""Headless update-surface fixtures; the bridge, update agent and server are in-memory mocks."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--node", default=str(Path.home() / ".local/share/specweave-studio/toolchains/node-v24.13.1-darwin-arm64/bin/node"))
parser.add_argument("--chromium", default=str(Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"))
args = parser.parse_args()
# Hover delays and renders stretch on a busy machine; assertions still fail on wrong text.
expect.set_options(timeout=20_000)
root = Path(__file__).resolve().parents[4]
args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
log = (args.output / "server.log").open("w")
env = dict(os.environ, PWDEBUG="0", PLAYWRIGHT_HTML_OPEN="never", UPDATE_SURFACE_PORT="0")
server = subprocess.Popen([args.node, str(Path(__file__).with_name("serve.mjs"))], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
receipt = {"synthetic": True, "installs": 0, "sourceRoot": str(root), "ownedServerPid": server.pid, "checks": [], "screenshots": [], "pageErrors": [], "blockedExternalRequests": []}
# The sidebar footer and the dialog sit in the bottom-left and centre; crops keep them legible.
FOOTER = {"x": 0, "y": 560, "width": 620, "height": 340}
# What Update changes, word for word, per server update scene.
SERVER_TOOLTIPS = {
    "server": "SpecWithCode on the server runs 1.0.20; this app runs 1.0.25. Update installs 1.0.25 on the server and restarts it. Threads running there stop for the restart. Nothing else on the server changes: no settings, no other software.",
    "server-desktop": "SpecWithCode on ministorm runs 1.0.20; this app runs 1.0.25. Update installs the newest SpecWithCode release on ministorm and relaunches the app there. Threads running there stop for the relaunch. Nothing else on ministorm changes: no settings, no other software.",
    "server-continue": "SpecWithCode on Office Mac mini build box runs 1.0.20; this app runs 1.0.25. Update installs 1.0.25 on Office Mac mini build box and restarts its server. Threads running there continue after the restart. Nothing else on Office Mac mini build box changes: no settings, no other software.",
    "server-nightly": "SpecWithCode on Build box runs 1.0.66; this app runs 1.0.67-nightly.20261021.882. Update installs 1.0.67-nightly.20261021.882 on Build box and restarts its server. Threads running there stop for the restart. Nothing else on Build box changes: no settings, no other software.",
}
# Each row's server version and the version Update installs.
SERVER_VERSIONS = {
    "server": ("1.0.20", "1.0.25"),
    "server-desktop": ("1.0.20", "1.0.25"),
    "server-continue": ("1.0.20", "1.0.25"),
    "server-nightly": ("1.0.66", "1.0.67-nightly.20261021.882"),
}
SERVER_NAMES = {
    "server": "Server",
    "server-desktop": "ministorm",
    "server-continue": "Office Mac mini build box",
    "server-nightly": "Build box",
}
# The row's text as written, and the accessible name screen readers hear ("to", not the arrow).
SERVER_ROWS = {scene: f"{name} {SERVER_VERSIONS[scene][0]} → {SERVER_VERSIONS[scene][1]}" for scene, name in SERVER_NAMES.items()}
SERVER_LABELS = {scene: f"{name} {SERVER_VERSIONS[scene][0]} to {SERVER_VERSIONS[scene][1]}" for scene, name in SERVER_NAMES.items()}
# The app sidebar's width before anyone resizes it, and the narrowest it can be dragged to at the
# default text size (src/components/threadSidebarWidth.ts). A larger text size can raise that
# minimum (the brand must fit), so the fixture reports it per size.
DEFAULT_WIDTH = 256
MINIMUM_WIDTH = 208
# Settings > Appearance text sizes measured: the default and the largest offered
# (packages/contracts/src/settings.ts); the app sets it as the root font size.
TEXT_SIZES = [16, 20]
STABLE_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
# Update states the runner switches the `server` row through (client-runtime ServerUpdateState).
UPDATE_STATES = {
    "idle": {"status": "idle"},
    "running": {"status": "running", "stage": "downloading", "fromVersion": "1.0.20", "targetVersion": "1.0.25"},
    "failed": {"status": "failed", "stage": "downloading", "fromVersion": "1.0.20", "targetVersion": "1.0.25", "message": "Download failed."},
}
# Measures the idle row in the fixture column. Each glyph of the name, current version and target
# is drawn whole, hidden (behind an ellipsis or outside its clipping ancestors) or sliced by a clip
# edge; `shown` lists the glyphs drawn whole and `visible` adds the ellipsis of a cut part.
ROW_LAYOUT = """row => {
    const box = (element) => element.getBoundingClientRect();
    const column = row.closest('[data-testid="sidebar-column"]');
    const name = row.querySelector('[data-testid="sidebar-server-update-name"]');
    const versions = row.querySelector('[data-testid="sidebar-server-update-versions"]');
    const current = row.querySelector('[data-testid="sidebar-server-update-current"]');
    const target = row.querySelector('[data-testid="sidebar-server-update-target"]');
    const trigger = name.closest('button');
    const icon = trigger.querySelector('svg');
    const buttons = [...row.querySelectorAll('button')];
    const update = buttons.find((button) => button.textContent === 'Update');
    const dismiss = buttons.find((button) => button.getAttribute('aria-label') === 'Dismiss update notice');
    const probe = document.createElement('span');
    probe.textContent = '…';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
    trigger.append(probe);
    const ellipsis = box(probe).width;
    probe.remove();
    // The box an element's glyphs are clipped to: its own and its ancestors' up to the row.
    const clipOf = (element) => {
        const clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
        for (let node = element; node !== row.parentElement; node = node.parentElement) {
            const style = getComputedStyle(node);
            const b = box(node);
            if (style.overflowX !== 'visible') {
                clip.left = Math.max(clip.left, b.left);
                clip.right = Math.min(clip.right, b.right);
            }
            if (style.overflowY !== 'visible') {
                clip.top = Math.max(clip.top, b.top);
                clip.bottom = Math.min(clip.bottom, b.bottom);
            }
        }
        return clip;
    };
    const part = (element) => {
        const style = getComputedStyle(element);
        const cut = element.scrollWidth > element.clientWidth;
        const ellipsized = cut && style.textOverflow === 'ellipsis' && style.overflowX === 'hidden' && style.whiteSpace === 'nowrap';
        // Glyphs that would reach under a drawn ellipsis are left out by the browser.
        const limit = ellipsized ? box(element).left + element.clientWidth - ellipsis + 0.5 : Infinity;
        const clip = clipOf(element);
        const range = document.createRange();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let shown = '';
        let hidden = 0;
        let sliced = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (let index = 0; index < node.length; index++) {
                range.setStart(node, index);
                range.setEnd(node, index + 1);
                const glyph = range.getBoundingClientRect();
                const inside = glyph.right <= Math.min(limit, clip.right + 0.5) && glyph.left >= clip.left - 0.5 && glyph.top >= clip.top - 0.5 && glyph.bottom <= clip.bottom + 0.5;
                const outside = glyph.right > limit || glyph.left >= clip.right - 0.5 || glyph.right <= clip.left + 0.5 || glyph.top >= clip.bottom - 0.5 || glyph.bottom <= clip.top + 0.5;
                if (inside) shown += node.data[index];
                else if (outside) hidden++;
                else sliced++;
            }
        }
        return {
            text: element.textContent,
            chars: element.textContent.length,
            shown,
            shownChars: shown.length,
            hidden,
            sliced,
            cut,
            ellipsis: ellipsized,
            visible: shown + (ellipsized ? '…' : ''),
        };
    };
    const [r, t, n, v, c, g, i, u, d] = [row, trigger, name, versions, current, target, icon, update, dismiss].map(box);
    const nameText = part(name);
    const currentText = part(current);
    const targetText = part(target);
    // The current version is drawn whole on the versions line, left of the target, or not at all:
    // wrapped onto the line's second flex line, which the line clips away.
    const currentState = currentText.shownChars === currentText.chars && c.top >= v.top - 0.5 && c.bottom <= v.bottom + 0.5 && c.right <= g.left + 0.5
        ? 'shown'
        : currentText.shownChars === 0 && currentText.sliced === 0 && c.top >= v.bottom - 0.5
            ? 'hidden'
            : 'cut';
    const versionsStyle = getComputedStyle(versions);
    const firstDrawn = currentState === 'shown' ? c : g;
    return {
        columnWidth: box(column).width,
        columnOverflows: column.scrollWidth > column.clientWidth,
        rowWidth: r.width,
        rowHeight: r.height,
        rowMinHeight: parseFloat(getComputedStyle(row).minHeight),
        rowOverflows: row.scrollWidth > row.clientWidth,
        textColumnWidth: Math.round(v.width * 10) / 10,
        textColumnBeforeUpdate: t.right <= u.left + 0.5,
        ellipsisWidth: Math.round(ellipsis * 10) / 10,
        // Line 1 holds the icon and the machine; the versions line runs from under the icon.
        iconBesideName: i.right <= n.left + 0.5 && i.top >= n.top - 0.5 && i.bottom <= n.bottom + 0.5,
        nameAboveVersions: n.bottom <= v.top + 0.5,
        versionsUnderIcon: Math.abs(v.left - i.left) <= 0.5,
        versionsClip: versionsStyle.overflowX === 'hidden' && versionsStyle.overflowY === 'hidden',
        versionsLeftAligned: Math.abs(firstDrawn.left - v.left) <= 0.5,
        name: nameText,
        target: targetText,
        targetInsideTextColumn: g.left >= v.left - 0.5 && g.right <= v.right + 0.5 && g.top >= v.top - 0.5 && g.bottom <= v.bottom + 0.5,
        current: { ...currentText, state: currentState, width: Math.round(c.width * 10) / 10 },
        versionsText: versions.textContent,
        versionsVisible: (currentState === 'shown' ? currentText.visible + ' ' : '') + targetText.visible,
        updateInsideRow: u.left >= r.left - 0.5 && u.right <= r.right + 0.5 && u.top >= r.top - 0.5 && u.bottom <= r.bottom + 0.5,
        dismissInsideRow: d.left >= u.right - 0.5 && d.right <= r.right + 0.5 && d.top >= r.top - 0.5 && d.bottom <= r.bottom + 0.5,
        updateWidth: Math.round(u.width * 10) / 10,
    };
}"""


def check_row_layout(scene, size, width, narrowest, layout):
    """The idle row at one text size and sidebar width: the machine named, the target whole when
    stable, the current version drawn whole or clipped away, nothing sliced mid-glyph, the row as
    tall as the one-line running and failed rows, and Update and × inside it."""
    server_version, target_version = SERVER_VERSIONS[scene]
    name, target, current = layout["name"], layout["target"], layout["current"]
    stable = STABLE_VERSION.match(server_version) and STABLE_VERSION.match(target_version)
    assert layout["columnWidth"] == width, layout
    assert name["text"] == SERVER_NAMES[scene], layout
    assert current["text"] == server_version and target["text"] == f"→ {target_version}", layout
    assert layout["versionsText"] == f"{server_version} → {target_version}", layout
    # Two lines: the icon and the machine, then the versions from under the icon.
    assert layout["iconBesideName"] and layout["nameAboveVersions"] and layout["versionsUnderIcon"], layout
    # The machine stays named: whole, or at least five characters before its ellipsis.
    assert name["shownChars"] >= min(5, name["chars"]), layout
    assert name["shownChars"] == name["chars"] or name["ellipsis"], layout
    # What Update installs: a stable version whole; a long prerelease keeps at least its x.y.z.
    if STABLE_VERSION.match(target_version):
        assert not target["cut"] and target["shownChars"] == target["chars"], layout
    else:
        assert target["shownChars"] >= len("→ " + target_version.split("-")[0]), layout
    assert layout["targetInsideTextColumn"], layout
    # The versions line clips, so the current version is drawn whole on it or not at all, and it
    # goes before the target is cut; whatever is drawn starts at the line's left edge.
    assert layout["versionsClip"] and layout["versionsLeftAligned"], layout
    assert current["state"] in ("shown", "hidden"), layout
    assert not target["cut"] or current["state"] == "hidden", layout
    # A stable row shows both versions, except at the largest text size where the sidebar is
    # narrowest: there the current version gives way.
    if stable:
        squeezed = size == TEXT_SIZES[-1] and width == narrowest
        assert layout["versionsVisible"] == (f"→ {target_version}" if squeezed else f"{server_version} → {target_version}"), layout
    # Every cut part ends in an ellipsis, and no glyph is sliced by a clip edge.
    assert all(part["ellipsis"] for part in (name, target) if part["cut"]), layout
    assert name["sliced"] == current["sliced"] == target["sliced"] == 0, layout
    # As tall as the one-line running and failed rows (min-h-7).
    assert abs(layout["rowHeight"] - layout["rowMinHeight"]) < 0.5, layout
    # Update and the dismiss button stay inside the row, and nothing scrolls sideways.
    assert layout["updateInsideRow"] and layout["dismissInsideRow"] and layout["textColumnBeforeUpdate"], layout
    assert not layout["rowOverflows"] and not layout["columnOverflows"], layout


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
                    # Vite serves the source module graph unbundled; on a busy machine the
                    # first load can take minutes, well past Playwright's 30s default.
                    page.goto(f"{origin}/?scene={scene}", wait_until="domcontentloaded", timeout=300_000)
                    page.evaluate("dark => document.documentElement.classList.toggle('dark', dark)", dark)
                    expect(page.get_by_test_id("sidebar-footer")).to_be_attached(timeout=60_000)
                    # Measure with the real font, not its fallback.
                    page.evaluate("() => document.fonts.ready.then(() => true)")
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
                expect(dialog.get_by_text("Restart to install SpecWithCode 1.0.25?", exact=True)).to_be_visible()
                for label in ["Restart when idle", "Restart now", "Cancel"]:
                    expect(dialog.get_by_role("button", name=label, exact=True)).to_be_visible()
                description = dialog.inner_text()
                # The running work, summarized and then listed by project and thread.
                for text in ["3 running, 1 queued in 2 threads", "EasyChamp", "Fix login", "Docs"]:
                    assert text in description, description
                page.wait_for_timeout(300)
                capture(page, "2-restart-dialog")
                dialog.get_by_role("button", name="Restart when idle", exact=True).click()
                expect(dialog).not_to_be_visible()
                # Waiting counts down to the forced restart set in preferences (2 minutes by default).
                expect(button).to_have_text(re.compile(r"^Restarts when idle, or in \d+:\d{2}$"))
                page.mouse.move(900, 200)
                page.wait_for_timeout(300)
                capture(page, "3-restarts-when-idle")
                capture(page, "3-restarts-when-idle-footer", FOOTER)
                data = page.evaluate("window.__updateSurfaceReceipts")
                assert data["installCalls"] == [], "Restart when idle must not install yet"
                assert any(call["input"] == {"stopWork": False} for call in data["prepareCalls"]), data["prepareCalls"]
                receipt["checks"].append({"scene": "restart", "theme": theme, "sparkleButton": True, "tooltipReleaseNotes": True, "threeChoiceDialog": True, "waitingLabel": button.inner_text(), "installCalls": 0, "prepareCalls": len(data["prepareCalls"])})
                context.close()

                def set_text_size(page, size):
                    """Sets the text size the way Settings > Appearance does, on the root element
                    (appearanceFonts.ts), and returns the narrowest the sidebar can then be dragged to."""
                    page.evaluate("size => { document.documentElement.style.fontSize = `${size}px`; }", size)
                    return page.evaluate("() => window.__sidebarMinimumWidth()")

                def set_width(page, width):
                    page.get_by_test_id("sidebar-column").evaluate("(column, width) => { column.style.width = `${width}px`; }", width)

                def row_crop(row, width):
                    box = row.bounding_box()
                    return {"x": 0, "y": box["y"] - 24, "width": width + 24, "height": box["height"] + 48}

                def text_sizes_and_widths(page):
                    """Each text size with the sidebar at its default width, then at its narrowest."""
                    for size in TEXT_SIZES:
                        narrowest = set_text_size(page, size)
                        assert narrowest == MINIMUM_WIDTH if size == TEXT_SIZES[0] else narrowest >= MINIMUM_WIDTH, (size, narrowest)
                        for width in [DEFAULT_WIDTH, narrowest]:
                            set_width(page, width)
                            yield size, width, narrowest
                    set_text_size(page, TEXT_SIZES[0])
                    set_width(page, DEFAULT_WIDTH)

                def open_server_row(scene, prefix):
                    """The idle row: its text and accessible name, one tooltip on the text and on
                    Update, and its fit at each text size, at the sidebar's default and narrowest widths."""
                    context, page = open_scene(scene)
                    row = page.get_by_test_id("sidebar-server-update")
                    expect(row).to_be_visible(timeout=60_000)
                    expect(row).to_have_count(1)
                    assert page.get_by_test_id("sidebar-column").evaluate("column => Number(column.dataset.defaultWidth)") == DEFAULT_WIDTH
                    # Screen readers hear the versions with "to", and the description once, on Update.
                    label = row.get_by_role("button", name=SERVER_LABELS[scene], exact=True)
                    expect(label).to_have_text(SERVER_ROWS[scene])
                    assert label.get_attribute("aria-description") is None, "The row text must not repeat Update's description"
                    update = row.get_by_role("button", name="Update", exact=True)
                    expect(update).to_be_enabled()
                    expect(update).to_have_attribute("aria-description", SERVER_TOOLTIPS[scene])
                    expect(row.get_by_role("button", name="Dismiss update notice", exact=True)).to_be_visible()
                    capture(page, prefix)
                    capture(page, f"{prefix}-footer", FOOTER)
                    tooltip = page.get_by_text(SERVER_TOOLTIPS[scene], exact=True)
                    layouts = {}
                    for size, width, narrowest in text_sizes_and_widths(page):
                        layout = row.evaluate(ROW_LAYOUT)
                        check_row_layout(scene, size, width, narrowest, layout)
                        layouts[f"{size}px@{width}"] = layout
                        capture(page, f"{prefix}-row-{size}px-{width}", row_crop(row, width))
                        if size != TEXT_SIZES[0]:
                            continue
                        # Hovering the row text and hovering Update both show the whole description.
                        for trigger, name in [(label, "tooltip"), (update, "button-tooltip")]:
                            trigger.hover()
                            expect(tooltip).to_be_visible()
                            page.wait_for_timeout(300)
                            capture(page, f"{prefix}-{name}-{width}-footer", FOOTER)
                            page.mouse.move(900, 200)
                            expect(tooltip).to_have_count(0)
                    return context, page, row, update, layouts

                def check_update_states(page, row, prefix):
                    """The idle row is as tall as the one-line running and failed rows, which keep
                    their look: the status, then Retry and × once the update failed."""
                    heights = {}
                    for size, width, _ in text_sizes_and_widths(page):
                        at = f"{size}px@{width}"
                        for state, value in UPDATE_STATES.items():
                            page.evaluate("state => window.__setServerUpdateState('remote', state)", value)
                            if state == "running":
                                expect(row.get_by_role("status")).to_contain_text("Updating server")
                                expect(row.get_by_role("status")).to_contain_text("Downloading…")
                                expect(row.get_by_role("button", name="Dismiss update notice", exact=True)).to_have_count(0)
                            elif state == "failed":
                                expect(row.get_by_role("alert")).to_contain_text("Could not update server")
                                expect(row.get_by_role("button", name="Retry", exact=True)).to_be_visible()
                                expect(row.get_by_role("button", name="Dismiss update notice", exact=True)).to_be_visible()
                            else:
                                expect(row.get_by_role("button", name=SERVER_LABELS["server"], exact=True)).to_be_visible()
                            heights[f"{at} {state}"] = row.bounding_box()["height"]
                            capture(page, f"{prefix}-{state}-{size}px-{width}", row_crop(row, width))
                        assert len({heights[f"{at} {state}"] for state in UPDATE_STATES}) == 1, heights
                    return heights

                # 4. The only remote server, behind the client, with one-click self-update.
                context, page, row, update, layouts = open_server_row("server", "4-server-update")
                assert not any(layout["name"]["cut"] for layout in layouts.values()), layouts
                heights = check_update_states(page, row, "4-server-update-state")
                receipt["checks"].append({"scene": "server", "theme": theme, "selfUpdate": "boot-service", "row": SERVER_ROWS["server"], "accessibleName": SERVER_LABELS["server"], "tooltipOnTextAndButton": True, "rowHeightsByState": heights, "layouts": layouts})
                context.close()

                # 5. A desktop-managed server, named because another (current) server is connected.
                context, page, row, update, layouts = open_server_row("server-desktop", "5-server-desktop")
                update.click()
                dialog = page.get_by_role("alertdialog")
                expect(dialog).to_be_visible()
                # The confirm dialog keeps naming the machine's server.
                expect(dialog.get_by_text("Update the SpecWithCode desktop app that runs the ministorm server?", exact=True)).to_be_visible()
                page.wait_for_timeout(300)
                capture(page, "5-server-desktop-confirm")
                dialog.get_by_role("button", name="Cancel", exact=True).click()
                expect(dialog).not_to_be_visible()
                data = page.evaluate("window.__updateSurfaceReceipts")
                assert data["updateServerCalls"] == [], "Cancel must not update the desktop app"
                receipt["checks"].append({"scene": "server-desktop", "theme": theme, "selfUpdate": "desktop-managed", "row": SERVER_ROWS["server-desktop"], "accessibleName": SERVER_LABELS["server-desktop"], "tooltipOnTextAndButton": True, "confirmNamesServer": True, "updateServerCalls": 0, "layouts": layouts})
                context.close()

                # 6. Thread continuation on, with a long machine name: the name truncates, the versions stay.
                context, page, row, update, layouts = open_server_row("server-continue", "6-server-continue")
                assert all(layout["name"]["cut"] for layout in layouts.values()), layouts
                receipt["checks"].append({"scene": "server-continue", "theme": theme, "selfUpdate": "respawn", "row": SERVER_ROWS["server-continue"], "accessibleName": SERVER_LABELS["server-continue"], "tooltipOnTextAndButton": True, "threadsContinue": True, "layouts": layouts})
                context.close()

                # 7. A nightly client: the current version gives way, then the long target truncates.
                context, page, row, update, layouts = open_server_row("server-nightly", "7-server-nightly")
                assert all(layout["target"]["cut"] and layout["current"]["state"] == "hidden" for layout in layouts.values()), layouts
                receipt["checks"].append({"scene": "server-nightly", "theme": theme, "selfUpdate": "boot-service", "row": SERVER_ROWS["server-nightly"], "accessibleName": SERVER_LABELS["server-nightly"], "tooltipOnTextAndButton": True, "layouts": layouts})
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
