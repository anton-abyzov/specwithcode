import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ResetAnnouncementMonitor from "../../../resetAnnouncements/ResetAnnouncementMonitor.ts";
import { announcementToRecord } from "../../../resetAnnouncements/recordTool.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Access from "../../McpToolAccess.ts";
import { ResetAnnouncementToolkit } from "./tools.ts";

export const layer = Access.toLayer(ResetAnnouncementToolkit, {
  studio_reset_announcement_record: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const on = yield* settings.getSettings.pipe(
        Effect.map((value) => value.resetAnnouncementsEnabled !== false),
        Effect.orElseSucceed(() => false),
      );
      if (!on) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            'Reset announcements are turned off in Settings > Models ("Read reset announcements"). Nothing was recorded.',
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const checked = announcementToRecord(input, now);
      if ("refused" in checked) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: checked.refused,
        });
      }
      const monitor = yield* ResetAnnouncementMonitor.ResetAnnouncementMonitor;
      const { recorded, saved } = yield* monitor.record(checked.announcement);
      if (!saved) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message:
            "The post could not be saved on this machine. Nothing was recorded; try again later.",
        });
      }
      return { recorded, id: checked.announcement.id, sourceUrl: checked.announcement.sourceUrl };
    }),
  ),
});
