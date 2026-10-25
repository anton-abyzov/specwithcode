import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  NodeId,
  RunId,
  type OrchestrationV2Checkpoint,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import { deriveThreadCheckpointSummaries } from "./threadCheckpoints.ts";

const checkpoint: OrchestrationV2Checkpoint = {
  id: CheckpointId.make("checkpoint-1"),
  threadId: v2Projection.thread.id,
  scopeId: CheckpointScopeId.make("scope-1"),
  runId: RunId.make("run-1"),
  nodeId: NodeId.make("root"),
  parentCheckpointId: null,
  ordinalWithinScope: 1,
  appRunOrdinal: 1,
  ref: CheckpointRef.make("refs/studio/checkpoints/1"),
  status: "ready",
  files: [{ path: "apps/web/src/App.tsx", kind: "modified", additions: 2, deletions: 1 }],
  capturedAt: v2Now,
};

describe("deriveThreadCheckpointSummaries", () => {
  it("copies the capture stamp", () => {
    const [summary] = deriveThreadCheckpointSummaries({
      ...v2Projection,
      checkpoints: [
        {
          ...checkpoint,
          cwd: "/repo/apps/web",
          repoRoot: "/repo",
          branch: null,
          headOid: "0123456789abcdef0123456789abcdef01234567",
          capturedOnEnvironmentId: EnvironmentId.make("environment-m4"),
          notGitRepository: false,
        },
      ],
    });
    expect(summary).toMatchObject({
      runId: checkpoint.runId,
      checkpointTurnCount: 1,
      cwd: "/repo/apps/web",
      repoRoot: "/repo",
      branch: null,
      headOid: "0123456789abcdef0123456789abcdef01234567",
      capturedOnEnvironmentId: EnvironmentId.make("environment-m4"),
      notGitRepository: false,
    });
  });

  it("leaves the stamp out for older checkpoints", () => {
    const [summary] = deriveThreadCheckpointSummaries({
      ...v2Projection,
      checkpoints: [checkpoint],
    });
    for (const key of [
      "cwd",
      "repoRoot",
      "branch",
      "headOid",
      "capturedOnEnvironmentId",
      "notGitRepository",
    ]) {
      expect(summary).not.toHaveProperty(key);
    }
  });
});
