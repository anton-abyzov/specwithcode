// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TooltipProvider } from "../ui/tooltip";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});
function render(value: string) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <TooltipProvider>
        <RedactedSensitiveText
          value={value}
          ariaLabel="Toggle account email visibility"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
        />
      </TooltipProvider>,
    ),
  );
  return host.querySelector("button")!;
}

describe("RedactedSensitiveText", () => {
  it("shows an email's ends and domain unblurred, and the whole address on click", () => {
    const button = render("antonabyzov@gmail.com");
    expect(button.textContent).toBe("an••••ov@gmail.com");
    expect(button.className).not.toContain("blur");
    act(() => button.click());
    expect(button.textContent).toBe("antonabyzov@gmail.com");
    act(() => button.click());
    expect(button.textContent).toBe("an••••ov@gmail.com");
  });

  it("still blurs a value that is not an email", () => {
    const button = render("octocat");
    expect(button.textContent).not.toBe("octocat");
    expect(button.className).toContain("blur-xs");
    act(() => button.click());
    expect(button.textContent).toBe("octocat");
  });
});
