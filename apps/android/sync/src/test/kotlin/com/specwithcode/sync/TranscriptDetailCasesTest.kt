package com.specwithcode.sync

import com.specwithcode.sync.TranscriptRow.Kind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The shared transcript detail rule (docs/transcript-detail.md). Web, desktop and iOS run the
 * same cases from packages/shared/src/transcriptDetail.cases.json; the Gradle test task passes
 * its path.
 */
class TranscriptDetailCasesTest {
    private val cases: List<JsonObject> by lazy {
        val path = System.getProperty("swc.transcriptDetailCases") ?: "../../../packages/shared/src/transcriptDetail.cases.json"
        val file = File(path)
        assertTrue(file.isFile, "Missing shared cases at ${file.absolutePath}")
        Json.parseToJsonElement(file.readText()).jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
    }

    private fun transcript(rows: JsonArray): List<TranscriptRow> = rows.map { element ->
        val row = element.jsonObject
        val id = row.getValue("id").jsonPrimitive.content
        val kind = row.getValue("kind").jsonPrimitive.content
        val running = row["running"]?.jsonPrimitive?.booleanOrNull == true
        val status = if (running) ToolStatus.Running else ToolStatus.Completed
        TranscriptRow(
            id,
            when (kind) {
                "user" -> Kind.User("Do it")
                "note", "reply" -> Kind.Assistant("$kind $id", streaming = false)
                "thinking" -> Kind.Reasoning("Thinking", streaming = false)
                "command" -> Kind.Tool("Ran ls", null, "terminal", status)
                "tool" -> Kind.Tool("Chrome snapshot", null, "wrench.and.screwdriver", status)
                "failed" -> Kind.Tool("Ran ls", "exit 1", "terminal", ToolStatus.Failed)
                "approval" -> Kind.Approval(requestId = id, prompt = "npm publish", resolved = false)
                "subagent" -> Kind.Subagent("Review", null, isRunning = running)
                else -> fail("Unknown row kind $kind")
            },
        )
    }

    private fun tokens(rows: List<TranscriptRow>): List<String> = rows.map { row ->
        val fold = row.kind as? Kind.Fold ?: return@map row.id
        (if (fold.running) "live" else "fold") + (if (fold.expanded) "-open" else "")
    }

    private fun appliesToAndroid(case: JsonObject): Boolean {
        val platforms = case["platforms"] as? JsonArray ?: return true
        // Android draws approvals as timeline rows, like iOS.
        return platforms.any { it.jsonPrimitive.content == "android" || it.jsonPrimitive.content == "ios" }
    }

    @Test fun everyCaseHoldsAtEveryLevel() {
        assertTrue(cases.isNotEmpty())
        var checked = 0
        for (case in cases.filter(::appliesToAndroid)) {
            val name = case.getValue("name").jsonPrimitive.content
            val running = case.getValue("running").jsonPrimitive.boolean
            val rows = transcript(case.getValue("rows").jsonArray)
            for ((detail, key) in listOf(TimelineDetail.Normal to "normal", TimelineDetail.Concise to "concise")) {
                val expected = case.getValue(key).jsonArray.map { it.jsonPrimitive.content }
                assertEquals(expected, tokens(TranscriptFolding.rows(rows, detail, isRunning = running)), "${detail.rawValue}: $name")
            }
            assertEquals(rows, TranscriptFolding.rows(rows, TimelineDetail.Verbose, isRunning = running), "verbose: $name")
            checked += 1
        }
        assertEquals(cases.count(::appliesToAndroid), checked)
    }
}
