package com.specwithcode.wire

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ReplyStyleWireTest {
    @Test fun decodesTheReplyStyleAndEachProjectsOverride() {
        val settings = decodeJSON<ServerSettings>(
            """
            {"responseStyle":"detailed",
             "projectSettingsOverrides":{
               "p-1":{"responseStyle":"concise","agentBrowserAccess":"ask"},
               "p-2":{"autoPull":true},
               "p-bad":{"responseStyle":42}
             }}
            """.trimIndent(),
        )
        assertEquals("detailed", settings.responseStyle)
        assertEquals(ProjectSettingsOverrides(responseStyle = "concise"), settings.projectSettingsOverrides["p-1"])
        assertNull(settings.projectSettingsOverrides["p-2"]?.responseStyle)
        // A malformed entry is dropped rather than failing the whole snapshot.
        assertFalse("p-bad" in settings.projectSettingsOverrides)
    }

    @Test fun theRecordedDefaultIsConciseAndOlderServersHaveNone() {
        assertEquals("concise", Fixture.decode<ServerSettings>("serverSettings.default.json").responseStyle)
        val older = decodeJSON<ServerSettings>("""{"aideEnabled":true}""")
        assertNull(older.responseStyle)
        assertTrue(older.projectSettingsOverrides.isEmpty())
    }

    @Test fun encodesAPerKeyProjectChange() {
        val patch = ServerSettingsPatch(
            projectSettingsOverrideChanges = mapOf("p-1" to ProjectSettingsOverrideChange(set = ProjectSettingsOverrides(responseStyle = "detailed"))),
        )
        assertFalse(patch.isEmpty)
        val expected = buildJsonObject {
            putJsonObject("patch") {
                putJsonObject("projectSettingsOverrideChanges") {
                    putJsonObject("p-1") { putJsonObject("set") { put("responseStyle", "detailed") } }
                }
            }
        }
        assertEquals(expected, encodeToJSON(UpdateServerSettingsInput(patch)))
        assertEquals(patch, decodeJSON<ServerSettingsPatch>(encodeToJSON(patch).toString()))
    }

    @Test fun encodesAClear() {
        val change = ProjectSettingsOverrideChange(clear = listOf("responseStyle"))
        val expected = buildJsonObject { putJsonArray("clear") { add(JsonPrimitive("responseStyle")) } }
        assertEquals(expected, encodeToJSON(change))
        assertTrue(ServerSettingsPatch(projectSettingsOverrideChanges = emptyMap()).isEmpty)
    }

    @Test fun readsTheCapability() {
        val on = EnvironmentCapabilities(mapOf("projectSettingsOverrideChanges" to JsonPrimitive(true)))
        assertTrue(on.projectSettingsOverrideChanges)
        assertFalse(EnvironmentCapabilities(mapOf("projectSettingsOverrides" to JsonPrimitive(true))).projectSettingsOverrideChanges)
        assertFalse(EnvironmentCapabilities(JsonObject(emptyMap())).projectSettingsOverrideChanges)
    }
}
