package com.specwithcode.wire

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A newer server must never break decoding: unknown statuses, kinds and types, explicit nulls and extra keys all decode. */
class ToleranceTest {
    private val base = """"id":"ti_x","threadId":"thr_1","runId":null,"nodeId":null,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":4,"title":null,"startedAt":null,"completedAt":null,"updatedAt":"2026-10-18T06:00:05.000Z""""

    @Test fun unknownStatuses() {
        val item = decodeJSON<TurnItem>("""{$base,"status":"paused_by_moon","type":"reasoning","text":"t","streaming":false}""")
        assertEquals("paused_by_moon", item.status.rawValue)
        assertFalse(item.status.isKnown)
        assertFalse(item.isInFlight)

        val thread = Fixture.json("threadShell.min.json") as JsonObject
        val shell = JsonObject(thread + ("status" to JsonPrimitive("hibernating"))).decode<ThreadShell>()
        assertEquals(ThreadStatus("hibernating"), shell.status)
        assertFalse(shell.status.isWorking)
        assertEquals(JsonPrimitive("hibernating"), encodeToJSON(shell)["status"])

        assertFalse(decodeJSON<RunStatus>("\"teleporting\"").isKnown)
        assertEquals("yolo", decodeJSON<RuntimeMode>("\"yolo\"").rawValue)
        assertNotEquals(WorkspaceKind.Code, decodeJSON<WorkspaceKind>("\"team\""))
    }

    @Test fun unknownTurnItemType() {
        val json = """{$base,"status":"completed","type":"hologram","beam":{"power":9}}"""
        val item = decodeJSON<TurnItem>(json)
        assertTrue(item.isUnknown)
        assertEquals("hologram", item.type)
        assertEquals("ti_x", item.id)
        assertEquals(4, item.ordinal)
        val unknown = assertIs<TurnItem.Content.Unknown>(item.content)
        assertEquals(9, unknown.raw["beam"]["power"].intValue)
        assertEquals(parse(json), encodeToJSON(item))

        // Even a bare unknown item decodes.
        val bare = decodeJSON<TurnItem>("""{"type":"sparkle"}""")
        assertTrue(bare.isUnknown && bare.id.isEmpty())
    }

    @Test fun knownTurnItemMustDecodeInFull() {
        assertFailsWith<IllegalArgumentException> {
            decodeJSON<TurnItem>("""{$base,"status":"completed","type":"command_execution"}""")
        }
    }

    @Test fun unknownTurnItemInProjection() {
        val projection = Fixture.json("threadProjection.json") as JsonObject
        val unknownItem = parse("""{$base,"status":"completed","type":"hologram"}""")
        val row = obj(
            "position" to JsonPrimitive(1), "visibility" to JsonPrimitive("synthetic"), "sourceThreadId" to JsonPrimitive("thr_1"),
            "sourceItemId" to JsonPrimitive("ti_x"), "item" to unknownItem,
        )
        val patched = JsonObject(
            projection + mapOf(
                "turnItems" to JsonArray((projection["turnItems"].arrayValue ?: emptyList()) + unknownItem),
                "visibleTurnItems" to JsonArray((projection["visibleTurnItems"].arrayValue ?: emptyList()) + row),
                "futureArray" to JsonArray(listOf(obj("anything" to JsonPrimitive(true)))),
            ),
        )
        val decoded = patched.decode<ThreadProjection>()
        assertEquals(2, decoded.turnItems.size)
        assertEquals(2, decoded.visibleTurnItems.size)
        assertEquals(1, decoded.renderableTurnItems.size)
    }

    @Test fun nullOptionals() {
        // Optional keys sent as null decode as null, and defaults fill missing arrays.
        val shell = decodeJSON<ThreadShell>(
            """
            {"id":"thr_n","projectId":"p","title":"T","providerInstanceId":"codex","modelSelection":{"instanceId":"codex","model":"gpt-6"},
             "runtimeMode":"auto","interactionMode":null,"branch":null,"worktreePath":null,"lineage":{"parentThreadId":null,"relationshipToParent":null,"rootThreadId":"thr_n"},
             "forkedFrom":null,"activeProviderThreadId":null,"latestRunId":null,"activeRunId":null,"status":"idle","pendingRuntimeRequest":null,
             "latestVisibleMessage":null,"latestUserMessageAt":null,"hasActionableProposedPlan":false,"pendingBackgroundTasks":null,
             "providerInstanceHistory":null,"planProgress":null,"goal":null,"activeWork":null,"lastVisitedAt":null,"pinnedAt":null,
             "titleRegeneration":null,"limitRecovery":null,"itemCount":0,"visibleItemCount":0,"createdAt":"2026-10-18T06:00:00.000Z",
             "updatedAt":"2026-10-18T06:00:00.000Z","archivedAt":null,"settledOverride":null,"settledAt":null,"deletedAt":null}
            """.trimIndent(),
        )
        assertEquals(InteractionMode.Default, shell.interactionMode)
        assertTrue(shell.pendingBackgroundTasks.isEmpty())
        assertTrue(shell.providerInstanceHistory.isEmpty())
        assertTrue(shell.forkedFrom == null && shell.limitRecovery == null)
        assertEquals(ActorKind.User, shell.createdBy)

        val project = decodeJSON<ProjectShell>(
            """
            {"id":"p","title":"P","workspaceRoot":"/w","repositoryIdentity":null,"defaultModelSelection":null,"defaultThreadEnvMode":null,
             "faviconPath":null,"projectIcon":null,"scripts":[],"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z",
             "workspaceSettings":{"revision":1,"coordinatorThreadId":null,"coordinatorModelSelection":null,"environment":null}}
            """.trimIndent(),
        )
        assertNull(project.projectIcon)
        assertEquals(WorkspaceKind.Code, project.workspaceSettings?.kind)
        assertEquals(ProjectEnvironment(), project.workspaceSettings?.environment)
        assertEquals("project-coordinator:p", project.coordinatorThreadId)

        val descriptor = decodeJSON<EnvironmentDescriptor>(
            """{"environmentId":"e","label":"Mac","platform":{"os":"darwin","arch":"arm64"},"serverVersion":null,"capabilities":null}""",
        )
        assertNull(descriptor.orchestrationProtocolVersion)
        assertEquals(EnvironmentDescriptor.Compatibility.ServerTooOld(1), descriptor.compatibility)
        assertEquals("macOS · arm64", descriptor.platform.displayName)
    }

    @Test fun extraKeys() {
        val message = decodeJSON<ConversationMessage>(
            """
            {"id":"m","threadId":"t","runId":null,"nodeId":null,"role":"assistant","text":"hi","attachments":[],"streaming":false,
             "createdAt":"2026-10-18T06:00:00.000Z","updatedAt":"2026-10-18T06:00:00.000Z","createdBy":"agent","creationSource":"provider",
             "reactions":[{"emoji":"x"}],"futureFlag":true}
            """.trimIndent(),
        )
        assertEquals(MessageRole.Assistant, message.role)
        assertEquals(ActorKind.Agent, message.createdBy)

        val settings = decodeJSON<ServerSettings>(
            """{"defaultRuntimeMode":"auto","brandNewSetting":{"deep":[1,2,3]},"providerInstances":{"codex":{"driver":"codex","enabled":true,"apiKeyRef":"x"},"bad":5}}""",
        )
        assertEquals(RuntimeMode.Auto, settings.defaultRuntimeMode)
        assertEquals(listOf("codex"), settings.providerInstances.keys.sorted())

        val item = decodeJSON<TurnItem>("""{$base,"status":"completed","type":"system_notice","message":"Hi","severity":"loud"}""")
        assertEquals("Hi", assertIs<TurnItem.Content.SystemNoticeContent>(item.content).value.message)
    }

    @Test fun legacyModelSelection() {
        val legacy = decodeJSON<ModelSelection>(
            """{"provider":"codex","model":"gpt-6","options":{"reasoningEffort":" high ","fastMode":true,"empty":""}}""",
        )
        assertEquals("codex", legacy.instanceId)
        assertEquals(ModelOption.Value.Text("high"), legacy.option("reasoningEffort"))
        assertEquals(ModelOption.Value.Flag(true), legacy.option("fastMode"))
        assertNull(legacy.option("empty"))
        val encoded = encodeToJSON(legacy)
        assertNull(encoded["provider"])
        assertEquals(JsonPrimitive("codex"), encoded["instanceId"])
        assertEquals(2, encoded["options"].arrayValue?.size)

        assertFailsWith<IllegalArgumentException> { decodeJSON<ModelSelection>("""{"model":"x"}""") }
    }

    @Test fun unknownProjectIcon() {
        val icon = decodeJSON<ProjectIconOverride>("""{"kind":"photo","url":"https://example.com/a.png"}""")
        val unknown = assertIs<ProjectIconOverride.Unknown>(icon)
        assertEquals("https://example.com/a.png", unknown.raw["url"].stringValue)
        assertEquals(unknown.raw, encodeToJSON<ProjectIconOverride>(icon))

        // Older servers sent monograms as lucide icons carrying the text.
        val legacy = decodeJSON<ProjectIconOverride>("""{"kind":"lucide","name":"type","color":"teal","monogramText":"SW"}""")
        assertEquals(ProjectIconOverride.Monogram("SW", "teal"), legacy)
    }

    @Test fun unknownShellKind() {
        val item = decodeJSON<ShellStreamItem>("""{"kind":"machine.renamed","sequence":77,"name":"M5"}""")
        assertEquals("machine.renamed", item.kind)
        assertEquals(77, item.sequence)
        assertIs<ShellStreamItem.Unknown>(item)
    }

    @Test fun unknownThreadStreamItems() {
        val event = decodeJSON<ThreadStreamItem>(
            """{"kind":"event","sequence":300,"event":{"id":"ev","threadId":"thr_1","occurredAt":"2026-10-18T06:00:00.000Z","type":"thread.teleported","payload":{"to":"mars"}}}""",
        )
        val typed = assertIs<ThreadStreamItem.Event>(event)
        assertEquals(300, typed.sequence)
        assertTrue(typed.event.isUnknown)
        assertEquals("thread.teleported", typed.event.type)

        // A turn-item.updated with an unknown item type is skipped like an unknown event.
        val item = decodeJSON<ThreadStreamItem>(
            """{"kind":"event","sequence":301,"event":{"id":"ev2","threadId":"thr_1","occurredAt":"2026-10-18T06:00:00.000Z","type":"turn-item.updated","payload":{$base,"status":"completed","type":"hologram"}}}""",
        )
        assertTrue(assertIs<ThreadStreamItem.Event>(item).event.isUnknown)

        val kind = decodeJSON<ThreadStreamItem>("""{"kind":"history-page","sequence":5}""")
        assertEquals(5, kind.sequence)
        assertIs<ThreadStreamItem.Unknown>(kind)

        // A known event type with a malformed payload still fails.
        assertFailsWith<IllegalArgumentException> {
            decodeJSON<ThreadStreamItem>(
                """{"kind":"event","sequence":1,"event":{"id":"e","threadId":"t","occurredAt":"2026-10-18T06:00:00.000Z","type":"run.updated","payload":{"id":"r"}}}""",
            )
        }
    }

    @Test fun teamRulesAreOptional() {
        val env = """"environment":{"environmentId":"e","label":"Mac","platform":{"os":"darwin","arch":"arm64"},"orchestrationProtocolVersion":2,"capabilities":{}}"""
        assertNull(decodeJSON<ServerConfig>("{$env}").teamRules)
        // Malformed rules read as absent instead of losing the whole config.
        assertNull(decodeJSON<ServerConfig>("""{$env,"teamRules":"soon"}""").teamRules)
        assertNull(decodeJSON<ServerConfig>("""{$env,"teamRules":{"owner":"no status"}}""").teamRules)

        val rules = assertNotNull(
            decodeJSON<ServerConfig>(
                """
                {$env,"teamRules":{"status":"active","owner":"Acme","fingerprint":"abc","ceiling":"auto","providers":["codex"],
                 "reach":{"phones":false,"machines":"same-rules","teleport":true},"tools":{"chrome":false,"futureTool":false},"brandNew":{"a":1}}}
                """.trimIndent(),
            ).teamRules,
        )
        assertEquals("Acme", rules.owner)
        assertEquals(RuntimeMode.Auto, rules.ceiling)
        assertEquals(false, rules.reach?.phones)
        assertEquals("same-rules", rules.reach?.machines)
        assertNull(rules.reach?.connect)
        assertEquals(false, rules.tools?.chrome)

        // One field in a newer shape costs only that field.
        val lossy = decodeJSON<TeamRulesSummary>("""{"status":"hold","owner":7,"issues":["broken"],"reach":"none"}""")
        assertEquals("hold", lossy.status)
        assertNull(lossy.owner)
        assertNull(lossy.reach)
        assertEquals(listOf("broken"), lossy.issues)
    }

    @Test fun providerStatusesCarryTheRules() {
        val on = decodeJSON<ServerConfigStreamItem>(
            """{"version":1,"type":"providerStatuses","payload":{"providers":[{"instanceId":"codex","driver":"codex"},{"nope":1}],"teamRules":{"status":"active","owner":"Acme"}}}""",
        )
        val statuses = assertIs<ServerConfigStreamItem.ProviderStatuses>(on)
        assertEquals(listOf("codex"), statuses.providers.map { it.instanceId })
        assertEquals("Acme", statuses.teamRules?.owner)

        val off = decodeJSON<ServerConfigStreamItem>("""{"version":1,"type":"providerStatuses","payload":{"providers":[]}}""")
        assertNull(assertIs<ServerConfigStreamItem.ProviderStatuses>(off).teamRules)
    }

    @Test fun aTeamRulesRefusalIsReadable() {
        val refused = obj(
            "_tag" to JsonPrimitive("ServerSettingsError"),
            "settingsPath" to JsonPrimitive("settings.json"),
            "operation" to JsonPrimitive("update"),
            "teamRulesRefusal" to obj(
                "reason" to JsonPrimitive("ceiling"),
                "message" to JsonPrimitive("Acme's rules allow up to Auto, so Full access is not available."),
            ),
        )
        val error = ServerError.from(listOf(RpcCause.Fail(refused)))
        assertEquals(ServerError.Kind.ServerSettings, error.kind)
        assertEquals("Acme's rules allow up to Auto, so Full access is not available.", error.message)

        val plain = obj("_tag" to JsonPrimitive("ServerSettingsError"), "settingsPath" to JsonPrimitive("settings.json"))
        assertEquals("The setting could not be saved.", ServerError.from(listOf(RpcCause.Fail(plain))).message)
    }

    @Test fun forwardCompatibleArrays() {
        val config = decodeJSON<ServerConfig>(
            """
            {"environment":{"environmentId":"e","label":"Mac","platform":{"os":"darwin","arch":"arm64"},"orchestrationProtocolVersion":2,"capabilities":{"threadPinning":true,"fileAttachments":{"maxUploadBytes":1024}}},
             "directEndpoints":[{"kind":"lan","httpBaseUrl":"http://10.0.0.2:8431"},{"kind":7}],
             "providers":[{"instanceId":"codex","driver":"codex","enabled":true,"installed":true,"status":"ready","models":[{"slug":"gpt-6","name":"GPT-6"},{"bad":true}]},{"nope":1}]}
            """.trimIndent(),
        )
        assertEquals(1, config.directEndpoints.size)
        assertEquals(1, config.providers.size)
        assertEquals(1, config.provider("codex")?.models?.size)
        assertEquals("GPT-6", config.provider("codex")?.modelName("gpt-6"))
        assertTrue(config.environment.capabilities.threadPinning)
        assertEquals(1024, config.environment.capabilities.maxUploadBytes)
        assertEquals(EnvironmentDescriptor.Compatibility.Compatible, config.environment.compatibility)
    }

    @Test fun unknownBackgroundAndNotificationKinds() {
        assertEquals(BackgroundTaskKind.BackgroundTask, decodeJSON<PendingBackgroundTask>("""{"taskId":"t1"}""").kind)
        assertEquals("cron", decodeJSON<PendingBackgroundTask>("""{"taskId":"t2","kind":"cron"}""").kind.rawValue)

        val command = decodeJSON<NotificationSource>("""{"kind":"background_command"}""")
        assertTrue(command.isCommand && command.normalizedKind == "command")
        assertEquals("background_task", decodeJSON<NotificationSource>("""{"kind":"satellite"}""").normalizedKind)
    }

    @Test fun unknownCapabilityAndStrategy() {
        val request = decodeJSON<RuntimeRequest>(
            """{"id":"r","nodeId":"n","kind":"telepathy","status":"pending","responseCapability":{"type":"carrier_pigeon"},"createdAt":"2026-10-18T06:00:00.000Z","resolvedAt":null}""",
        )
        assertEquals("telepathy", request.kind.rawValue)
        assertFalse(request.responseCapability.canRespond)

        assertIs<WorkspaceStrategy.Unknown>(decodeJSON<WorkspaceStrategy>("""{"type":"container","image":"node"}"""))

        val plan = decodeJSON<PlanArtifact>("""{"id":"p","threadId":"t","runId":null,"nodeId":"n","status":"draft","kind":"mindmap","nodes":[]}""")
        assertEquals("mindmap", plan.kind)
    }

    @Test fun datesRoundTripWithMilliseconds() {
        val date = assertNotNull(WireDates.parse("2026-10-18T06:00:05.123Z"))
        val event = decodeJSON<DomainEvent>("""{"id":"e","threadId":"t","occurredAt":"2026-10-18T06:00:05.123Z","type":"future.thing"}""")
        assertEquals(date, event.occurredAt)
        assertEquals(JsonPrimitive("2026-10-18T06:00:05.123Z"), encodeToJSON(event)["occurredAt"])
        assertEquals(DomainEvent.Payload.Unknown(JsonNull), event.payload)
    }
}
