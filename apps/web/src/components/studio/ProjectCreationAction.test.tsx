import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectCreationAction } from "./ProjectCreationAction";

const props = {
  kind: "code" as const,
  hasName: true,
  hasFolder: true,
  canCreate: true,
  connected: true,
  busy: false,
  onCreate: vi.fn(),
};
describe("project creation readiness", () => {
  it("prioritizes reconnection over missing scopes when the machine is unavailable", () => {
    const html = renderToStaticMarkup(
      <ProjectCreationAction {...props} connected={false} canCreate={false} />,
    );
    expect(html).toContain("Connect the selected machine");
    expect(html).not.toContain("needs permission");
    expect(html).toContain(' disabled=""');
  });
  it("explains a missing name and folder while keeping creation disabled", () => {
    const name = renderToStaticMarkup(<ProjectCreationAction {...props} hasName={false} />);
    expect(name).toContain("Enter a project name");
    expect(name).toContain(' disabled=""');
    const folder = renderToStaticMarkup(<ProjectCreationAction {...props} hasFolder={false} />);
    expect(folder).toContain("Use this folder");
    expect(folder).toContain(' disabled=""');
  });
  it("enables the assistant without a repository folder and prevents duplicate submissions", () => {
    const ready = renderToStaticMarkup(
      <ProjectCreationAction {...props} kind="personal" hasFolder={false} />,
    );
    expect(ready).toContain("Create personal assistant");
    expect(ready).not.toContain(' disabled=""');
    const busy = renderToStaticMarkup(<ProjectCreationAction {...props} busy />);
    expect(busy).toContain(' disabled=""');
    expect(busy).toContain("Creating your project");
  });
  it("keeps a connected read-only account disabled with permission guidance", () => {
    const html = renderToStaticMarkup(<ProjectCreationAction {...props} canCreate={false} />);
    expect(html).toContain("needs permission");
    expect(html).toContain(' disabled=""');
  });
});
