// Copies of Tests/SWCWireTests/Fixtures; this target has no resources.

enum FixtureJSON {
  /// threadStreamItem.snapshot.json
  static let threadSnapshot = #"""
{
  "kind": "snapshot",
  "snapshotSequence": 99,
  "projection": {
    "thread": {
      "createdBy": "user",
      "creationSource": "mobile",
      "id": "thr_1",
      "projectId": "proj_1",
      "title": "Fix login",
      "providerInstanceId": "claude",
      "modelSelection": {
        "instanceId": "claude",
        "model": "claude-opus-4-5"
      },
      "runtimeMode": "full-access",
      "interactionMode": "default",
      "branch": null,
      "worktreePath": null,
      "activeProviderThreadId": null,
      "lineage": {
        "parentThreadId": null,
        "relationshipToParent": null,
        "rootThreadId": "thr_1"
      },
      "forkedFrom": null,
      "createdAt": "2026-10-18T06:00:00.000Z",
      "updatedAt": "2026-10-18T04:00:01.500Z",
      "archivedAt": null,
      "settledOverride": null,
      "settledAt": null,
      "lastVisitedAt": null,
      "deletedAt": null
    },
    "runs": [
      {
        "id": "run_1",
        "threadId": "thr_1",
        "ordinal": 1,
        "providerInstanceId": "claude",
        "modelSelection": {
          "instanceId": "claude",
          "model": "claude-opus-4-5"
        },
        "providerThreadId": null,
        "userMessageId": "msg_1",
        "rootNodeId": null,
        "activeAttemptId": null,
        "status": "running",
        "requestedAt": "2026-10-18T06:00:02.000Z",
        "startedAt": "2026-10-18T06:00:03.000Z",
        "completedAt": null,
        "checkpointId": null,
        "contextHandoffId": null
      }
    ],
    "attempts": [],
    "nodes": [],
    "subagents": [],
    "providerSessions": [],
    "providerThreads": [],
    "providerTurns": [],
    "runtimeRequests": [],
    "messages": [
      {
        "createdBy": "user",
        "creationSource": "mobile",
        "id": "msg_1",
        "threadId": "thr_1",
        "runId": "run_1",
        "nodeId": null,
        "role": "user",
        "text": "hi",
        "attachments": [],
        "streaming": false,
        "createdAt": "2026-10-18T06:00:02.000Z",
        "updatedAt": "2026-10-18T06:00:02.000Z"
      }
    ],
    "plans": [
      {
        "id": "plan_1",
        "threadId": "thr_1",
        "runId": "run_1",
        "nodeId": "node_1",
        "status": "active",
        "kind": "todo_list",
        "steps": [
          {
            "id": "s1",
            "text": "Do it",
            "status": "running"
          }
        ]
      }
    ],
    "turnItems": [
      {
        "id": "ti_1",
        "threadId": "thr_1",
        "runId": "run_1",
        "nodeId": null,
        "providerThreadId": null,
        "providerTurnId": null,
        "nativeItemRef": null,
        "parentItemId": null,
        "ordinal": 0,
        "status": "completed",
        "title": null,
        "startedAt": null,
        "completedAt": "2026-10-18T06:00:05.000Z",
        "updatedAt": "2026-10-18T06:00:05.000Z",
        "type": "command_execution",
        "input": "ls",
        "output": "a\nb",
        "exitCode": 0
      }
    ],
    "checkpointScopes": [],
    "checkpoints": [],
    "contextHandoffs": [],
    "contextTransfers": [],
    "visibleTurnItems": [
      {
        "position": 0,
        "visibility": "local",
        "sourceThreadId": "thr_1",
        "sourceItemId": "ti_1",
        "item": {
          "id": "ti_1",
          "threadId": "thr_1",
          "runId": "run_1",
          "nodeId": null,
          "providerThreadId": null,
          "providerTurnId": null,
          "nativeItemRef": null,
          "parentItemId": null,
          "ordinal": 0,
          "status": "completed",
          "title": null,
          "startedAt": null,
          "completedAt": "2026-10-18T06:00:05.000Z",
          "updatedAt": "2026-10-18T06:00:05.000Z",
          "type": "command_execution",
          "input": "ls",
          "output": "a\nb",
          "exitCode": 0
        }
      }
    ],
    "updatedAt": "2026-10-18T06:00:05.000Z"
  }
}
"""#

  /// threadEvents.json
  static let threadEvents = #"""
[
  {
    "kind": "event",
    "sequence": 200,
    "event": {
      "id": "ev_pin",
      "threadId": "thr_1",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "thread.pinned",
      "payload": {
        "createdBy": "user",
        "creationSource": "mobile",
        "id": "thr_1",
        "projectId": "proj_1",
        "title": "Fix login",
        "providerInstanceId": "claudeAgent",
        "modelSelection": {
          "instanceId": "claudeAgent",
          "model": "claude-opus-5-5"
        },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "branch": "fix/login",
        "worktreePath": null,
        "activeProviderThreadId": null,
        "lineage": {
          "parentThreadId": null,
          "relationshipToParent": null,
          "rootThreadId": "thr_1"
        },
        "forkedFrom": null,
        "createdAt": "2026-10-18T06:00:00.000Z",
        "updatedAt": "2026-10-18T06:10:00.000Z",
        "archivedAt": null,
        "settledOverride": null,
        "settledAt": null,
        "pinnedAt": "2026-10-18T06:09:00.000Z",
        "pinOrderKey": "a0",
        "lastVisitedAt": "2026-10-18T06:05:00.000Z",
        "deletedAt": null
      }
    }
  },
  {
    "kind": "event",
    "sequence": 201,
    "event": {
      "id": "ev_meta",
      "threadId": "thr_1",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "thread.metadata-updated",
      "payload": {
        "createdBy": "user",
        "creationSource": "mobile",
        "id": "thr_1",
        "projectId": "proj_1",
        "title": "Fix login flow",
        "providerInstanceId": "claudeAgent",
        "modelSelection": {
          "instanceId": "claudeAgent",
          "model": "claude-opus-5-5"
        },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "branch": "fix/login",
        "worktreePath": null,
        "activeProviderThreadId": null,
        "lineage": {
          "parentThreadId": null,
          "relationshipToParent": null,
          "rootThreadId": "thr_1"
        },
        "forkedFrom": null,
        "createdAt": "2026-10-18T06:00:00.000Z",
        "updatedAt": "2026-10-18T06:10:00.000Z",
        "archivedAt": null,
        "settledOverride": null,
        "settledAt": null,
        "pinnedAt": "2026-10-18T06:09:00.000Z",
        "pinOrderKey": "a0",
        "lastVisitedAt": "2026-10-18T06:05:00.000Z",
        "deletedAt": null
      }
    }
  },
  {
    "kind": "event",
    "sequence": 202,
    "event": {
      "id": "ev_run_c",
      "threadId": "thr_1",
      "runId": "run_2",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "run.created",
      "payload": {
        "id": "run_2",
        "threadId": "thr_1",
        "ordinal": 2,
        "providerInstanceId": "claudeAgent",
        "modelSelection": {
          "instanceId": "claudeAgent",
          "model": "claude-opus-5-5",
          "options": [
            {
              "id": "effort",
              "value": "high"
            },
            {
              "id": "fastMode",
              "value": true
            }
          ]
        },
        "providerThreadId": "pt_1",
        "userMessageId": "msg_3",
        "rootNodeId": "node_r",
        "activeAttemptId": null,
        "status": "queued",
        "queuePosition": 1,
        "requestedAt": "2026-10-18T06:11:00.000Z",
        "startedAt": null,
        "completedAt": null,
        "checkpointId": null,
        "contextHandoffId": null
      }
    }
  },
  {
    "kind": "event",
    "sequence": 203,
    "event": {
      "id": "ev_run_u",
      "threadId": "thr_1",
      "runId": "run_2",
      "driver": "claudeAgent",
      "providerInstanceId": "claudeAgent",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "run.updated",
      "payload": {
        "id": "run_2",
        "threadId": "thr_1",
        "ordinal": 2,
        "providerInstanceId": "claudeAgent",
        "modelSelection": {
          "instanceId": "claudeAgent",
          "model": "claude-opus-5-5",
          "options": [
            {
              "id": "effort",
              "value": "high"
            },
            {
              "id": "fastMode",
              "value": true
            }
          ]
        },
        "providerThreadId": "pt_1",
        "userMessageId": "msg_3",
        "rootNodeId": "node_r",
        "activeAttemptId": null,
        "status": "running",
        "queuePosition": null,
        "requestedAt": "2026-10-18T06:11:00.000Z",
        "startedAt": "2026-10-18T06:11:02.000Z",
        "completedAt": null,
        "checkpointId": null,
        "contextHandoffId": null
      }
    }
  },
  {
    "kind": "event",
    "sequence": 204,
    "event": {
      "id": "ev_msg",
      "threadId": "thr_1",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "message.updated",
      "payload": {
        "createdBy": "agent",
        "creationSource": "mcp",
        "senderThreadId": "thr_coord",
        "id": "msg_4",
        "threadId": "thr_1",
        "runId": "run_2",
        "nodeId": null,
        "role": "assistant",
        "text": "Done.",
        "attachments": [
          {
            "type": "image",
            "id": "att_1",
            "name": "shot.png",
            "mimeType": "image/png",
            "sizeBytes": 2048
          }
        ],
        "streaming": false,
        "createdAt": "2026-10-18T06:12:00.000Z",
        "updatedAt": "2026-10-18T06:12:01.000Z"
      }
    }
  },
  {
    "kind": "event",
    "sequence": 205,
    "event": {
      "id": "ev_item",
      "threadId": "thr_1",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "turn-item.updated",
      "payload": {
        "id": "ti_asst",
        "threadId": "thr_1",
        "runId": "run_1",
        "nodeId": null,
        "providerThreadId": null,
        "providerTurnId": null,
        "nativeItemRef": null,
        "parentItemId": null,
        "ordinal": 1,
        "status": "running",
        "title": null,
        "startedAt": "2026-10-18T06:00:03.000Z",
        "completedAt": null,
        "updatedAt": "2026-10-18T06:00:05.123Z",
        "type": "assistant_message",
        "messageId": "msg_2",
        "text": "Looking at **auth.ts** now.",
        "streaming": true
      }
    }
  },
  {
    "kind": "event",
    "sequence": 206,
    "event": {
      "id": "ev_plan",
      "threadId": "thr_1",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "plan.updated",
      "payload": {
        "id": "plan_p",
        "threadId": "thr_1",
        "runId": "run_2",
        "nodeId": "node_p",
        "status": "draft",
        "kind": "proposed_plan",
        "markdown": "# Plan\n- step"
      }
    }
  },
  {
    "kind": "event",
    "sequence": 207,
    "event": {
      "id": "ev_req",
      "threadId": "thr_1",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "runtime-request.updated",
      "payload": {
        "id": "req_1",
        "nodeId": "node_a",
        "providerTurnId": null,
        "nativeRequestRef": null,
        "kind": "command",
        "status": "pending",
        "responseCapability": {
          "type": "live",
          "providerSessionId": "ps_1"
        },
        "createdAt": "2026-10-18T06:13:00.000Z",
        "resolvedAt": null
      }
    }
  },
  {
    "kind": "event",
    "sequence": 208,
    "event": {
      "id": "ev_req2",
      "threadId": "thr_1",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "runtime-request.updated",
      "payload": {
        "id": "req_2",
        "nodeId": "node_a",
        "providerTurnId": null,
        "nativeRequestRef": null,
        "kind": "user_input",
        "status": "resolved",
        "responseCapability": {
          "type": "not_resumable",
          "reason": "Session ended"
        },
        "createdAt": "2026-10-18T06:13:00.000Z",
        "resolvedAt": "2026-10-18T06:14:00.000Z",
        "answers": {
          "q1": "Postgres"
        }
      }
    }
  },
  {
    "kind": "event",
    "sequence": 209,
    "event": {
      "id": "ev_att",
      "threadId": "thr_1",
      "occurredAt": "2026-10-18T06:15:00.250Z",
      "type": "run-attempt.created",
      "payload": {
        "id": "att_r1",
        "runId": "run_2",
        "attemptOrdinal": 1,
        "rootNodeId": "node_r",
        "providerInstanceId": "claudeAgent",
        "providerThreadId": "pt_1",
        "providerTurnId": null,
        "reason": "initial",
        "status": "running",
        "startedAt": "2026-10-18T06:11:01.000Z",
        "completedAt": null
      }
    }
  },
  {
    "kind": "synchronized"
  }
]
"""#

  /// turnItems.json
  static let turnItems = #"""
[
  {
    "id": "ti_user",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 0,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "createdBy": "user",
    "creationSource": "mobile",
    "type": "user_message",
    "messageId": "msg_1",
    "inputIntent": "turn_start",
    "text": "Fix the login bug",
    "attachments": []
  },
  {
    "id": "ti_asst",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 1,
    "status": "running",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": null,
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "assistant_message",
    "messageId": "msg_2",
    "text": "Looking at **auth.ts** now.",
    "streaming": true
  },
  {
    "id": "ti_reason",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 2,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "reasoning",
    "text": "The token check runs before refresh.",
    "streaming": false
  },
  {
    "id": "ti_plan",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 3,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "proposed_plan",
    "planId": "plan_p",
    "markdown": "1. Read\n2. Fix",
    "streaming": false
  },
  {
    "id": "ti_todo",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 4,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "todo_list",
    "planId": "plan_t",
    "steps": [
      {
        "id": "s1",
        "text": "Read code",
        "status": "completed",
        "durationMs": 1200
      },
      {
        "id": "s2",
        "text": "Write fix",
        "status": "running",
        "durationAnchorAt": "2026-10-18T06:00:04Z"
      },
      {
        "id": "s3",
        "text": "Test",
        "status": "pending"
      }
    ],
    "explanation": "Three steps"
  },
  {
    "id": "ti_cmd",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 5,
    "status": "failed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "command_execution",
    "input": "npm test",
    "outputOmitted": true,
    "outputIndicatesFailure": true,
    "exitCode": 1
  },
  {
    "id": "ti_file",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 6,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "file_change",
    "fileName": "src/auth.ts",
    "additions": 12,
    "deletions": 3,
    "changes": [
      {
        "operation": "update",
        "path": "src/auth.ts"
      }
    ]
  },
  {
    "id": "ti_fsearch",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 7,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "file_search",
    "pattern": "refreshToken",
    "results": [
      {
        "fileName": "src/auth.ts",
        "line": 40,
        "preview": "refreshToken()"
      }
    ]
  },
  {
    "id": "ti_wsearch",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 8,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "web_search",
    "patterns": [
      "oauth refresh race"
    ],
    "results": [
      {
        "title": "RFC 6749",
        "url": "https://example.com/rfc6749"
      }
    ]
  },
  {
    "id": "ti_approval",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 9,
    "status": "waiting",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": null,
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "approval_request",
    "requestId": "req_1",
    "requestKind": "command",
    "prompt": "Run npm install?",
    "options": [
      {
        "decision": "accept",
        "label": "Allow"
      },
      {
        "decision": "acceptForSession",
        "label": "Allow for session"
      },
      {
        "decision": "decline",
        "label": "Deny"
      }
    ]
  },
  {
    "id": "ti_input",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 10,
    "status": "waiting",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": null,
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "user_input_request",
    "requestId": "req_2",
    "questions": [
      {
        "id": "q1",
        "header": "Database",
        "question": "Which database?",
        "options": [
          {
            "label": "Postgres",
            "description": "Use Postgres",
            "recommended": true
          },
          {
            "label": "SQLite",
            "description": "Use SQLite"
          }
        ],
        "multiSelect": false
      }
    ]
  },
  {
    "toolSurface": "browser",
    "toolSource": {
      "key": "chrome",
      "name": "Chrome",
      "kind": "browser"
    },
    "id": "ti_tool",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 11,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "dynamic_tool",
    "toolName": "studio_thread_launch",
    "input": {
      "machine": "m4",
      "prompt": "Run tests"
    },
    "output": {
      "threadId": "thr_9"
    }
  },
  {
    "id": "ti_sub",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 12,
    "status": "running",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": null,
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "subagent",
    "subagentId": "node_sub",
    "origin": "app_owned",
    "driver": "claudeAgent",
    "providerInstanceId": "claudeAgent",
    "childThreadId": "thr_child",
    "prompt": "Audit the API",
    "progress": "Reading files",
    "result": null
  },
  {
    "id": "ti_err",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 13,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "error",
    "failure": {
      "class": "usage_limit",
      "message": "Usage limit reached",
      "code": "rate_limited",
      "retryable": true,
      "resetAt": "2026-10-18T09:00:00Z"
    }
  },
  {
    "id": "ti_notice",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 14,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "system_notice",
    "message": "Context compacted"
  },
  {
    "id": "ti_note",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 15,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "notification",
    "source": {
      "kind": "background_task",
      "work": "subagent",
      "childThreadId": "thr_child"
    },
    "outcome": "completed",
    "summary": "Audit finished"
  },
  {
    "id": "ti_ckpt",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 16,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "checkpoint",
    "checkpointId": "ck_1",
    "scopeId": "scope_1",
    "files": []
  },
  {
    "id": "ti_intr",
    "threadId": "thr_1",
    "runId": "run_1",
    "nodeId": null,
    "providerThreadId": null,
    "providerTurnId": null,
    "nativeItemRef": null,
    "parentItemId": null,
    "ordinal": 17,
    "status": "completed",
    "title": null,
    "startedAt": "2026-10-18T06:00:03.000Z",
    "completedAt": "2026-10-18T06:00:05.000Z",
    "updatedAt": "2026-10-18T06:00:05.123Z",
    "type": "run_interrupt_request",
    "message": "Stopped by user",
    "cause": "user"
  }
]
"""#

  /// shellStreamItem.snapshot.json
  static let shellSnapshot = #"""
{
  "kind": "snapshot",
  "snapshot": {
    "schemaVersion": 1,
    "snapshotSequence": 42,
    "threads": [
      {
        "createdBy": "user",
        "creationSource": "mobile",
        "id": "thr_1",
        "projectId": "proj_1",
        "title": "Fix login",
        "providerInstanceId": "claude",
        "modelSelection": {
          "instanceId": "claude",
          "model": "claude-opus-4-5"
        },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "branch": null,
        "worktreePath": null,
        "lineage": {
          "parentThreadId": null,
          "relationshipToParent": null,
          "rootThreadId": "thr_1"
        },
        "forkedFrom": null,
        "activeProviderThreadId": null,
        "latestRunId": null,
        "activeRunId": null,
        "status": "idle",
        "pendingRuntimeRequest": null,
        "latestVisibleMessage": null,
        "latestUserMessageAt": null,
        "hasActionableProposedPlan": false,
        "pendingBackgroundTasks": [],
        "providerInstanceHistory": [],
        "itemCount": 0,
        "visibleItemCount": 0,
        "createdAt": "2026-10-18T06:00:00.000Z",
        "updatedAt": "2026-10-18T04:00:01.500Z",
        "archivedAt": null,
        "settledOverride": null,
        "settledAt": null,
        "deletedAt": null
      }
    ],
    "archivedThreads": [],
    "projects": [
      {
        "id": "proj_1",
        "title": "SpecWeave",
        "workspaceRoot": "/Users/x/specweave",
        "defaultModelSelection": null,
        "workspaceSettings": {
          "kind": "code",
          "environment": {
            "additionalFolders": [],
            "repositories": []
          },
          "revision": 3,
          "goal": "",
          "instructions": "",
          "coordinatorModelSelection": null,
          "coordinatorThreadId": "project-coordinator:proj_1",
          "paused": false,
          "archived": false,
          "autoResume": false
        },
        "scripts": [],
        "createdAt": "2026-10-01T00:00:00.000Z",
        "updatedAt": "2026-10-01T00:00:00.000Z"
      }
    ]
  }
}
"""#

  /// projectShell.json
  static let project = #"""
{
  "id": "proj_1",
  "title": "SpecWeave",
  "workspaceRoot": "/Users/x/specweave",
  "defaultModelSelection": null,
  "workspaceSettings": {
    "kind": "code",
    "environment": {
      "additionalFolders": [],
      "repositories": []
    },
    "revision": 3,
    "goal": "",
    "instructions": "",
    "coordinatorModelSelection": null,
    "coordinatorThreadId": "project-coordinator:proj_1",
    "paused": false,
    "archived": false,
    "autoResume": false
  },
  "scripts": [],
  "createdAt": "2026-10-01T00:00:00.000Z",
  "updatedAt": "2026-10-01T00:00:00.000Z"
}
"""#

  /// threadShell.min.json
  static let threadShell = #"""
{
  "createdBy": "user",
  "creationSource": "mobile",
  "id": "thr_1",
  "projectId": "proj_1",
  "title": "Fix login",
  "providerInstanceId": "claude",
  "modelSelection": {
    "instanceId": "claude",
    "model": "claude-opus-4-5"
  },
  "runtimeMode": "full-access",
  "interactionMode": "default",
  "branch": null,
  "worktreePath": null,
  "lineage": {
    "parentThreadId": null,
    "relationshipToParent": null,
    "rootThreadId": "thr_1"
  },
  "forkedFrom": null,
  "activeProviderThreadId": null,
  "latestRunId": null,
  "activeRunId": null,
  "status": "idle",
  "pendingRuntimeRequest": null,
  "latestVisibleMessage": null,
  "latestUserMessageAt": null,
  "hasActionableProposedPlan": false,
  "pendingBackgroundTasks": [],
  "providerInstanceHistory": [],
  "itemCount": 0,
  "visibleItemCount": 0,
  "createdAt": "2026-10-18T06:00:00.000Z",
  "updatedAt": "2026-10-18T04:00:01.500Z",
  "archivedAt": null,
  "settledOverride": null,
  "settledAt": null,
  "deletedAt": null
}
"""#
}
