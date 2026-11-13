import { describe, expect, it } from "vite-plus/test";

import { roomierVolumeMoveSteps } from "./StorageUsageBreakdown";

describe("roomierVolumeMoveSteps", () => {
  it("stops the service, copies, links and starts again, keeping the old copy until checked", () => {
    expect(
      roomierVolumeMoveSteps({ homePath: "/home/anton/.specwithcode", volumePath: "/srv/" }),
    ).toBe(
      [
        "systemctl --user stop studio.service   # quit the desktop app first",
        'sudo install -d -o "$USER" -g "$USER" /srv/specwithcode',
        "rsync -a /home/anton/.specwithcode/ /srv/specwithcode/",
        "mv /home/anton/.specwithcode /home/anton/.specwithcode.old && ln -s /srv/specwithcode /home/anton/.specwithcode",
        "systemctl --user start studio.service",
        "# once it works: rm -rf /home/anton/.specwithcode.old",
      ].join("\n"),
    );
  });
});
