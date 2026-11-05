package com.specwithcode.sync

import com.specwithcode.wire.ModelSelection
import com.specwithcode.wire.ServerProviderSummary
import java.net.URI
import java.time.Instant

/** Machine names as rows show them. */
object MachineNickname {
    private val possessive = Regex("^[^\\s'’]+['’]s\\s+")

    /**
     * Drops a possessive owner prefix: "Sam's MacBook M4MAX" reads "MacBook M4MAX". Every
     * machine is the user's own, so the owner adds nothing.
     */
    fun shortName(label: String): String {
        val trimmed = label.trim()
        val match = possessive.find(trimmed) ?: return trimmed
        val rest = trimmed.substring(match.range.last + 1)
        return rest.ifEmpty { trimmed }
    }
}

/** Where a thread lives and runs, by machine nickname. */
data class ThreadPlacement(
    /** The machine the thread lives on. */
    val owner: String,
    /** The machine it runs on, when that is another machine. */
    val runsOn: String? = null,
    /** Set when the machine that answers for the thread is unreachable: its state is unknown. */
    val unknown: Unknown? = null,
) {
    data class Unknown(
        /** The unreachable machine. */
        val machine: String,
        /** When the phone last had it connected; null when it never did. */
        val lastSeenAt: Instant?,
    )

    /** "M4", or "M4 → Minis" when it lives on M4 and runs on Minis. */
    val label: String get() = runsOn?.let { "$owner → $it" } ?: owner
}

/**
 * Saved provider and model identity, enriched by that machine's catalog when available.
 * Unknown or custom ids stay visible; display names never decide a brand.
 */
data class ThreadIdentity(
    val provider: String,
    val model: String,
    val providerBrand: String? = null,
    val modelBrand: String? = null,
) {
    val label: String get() = "$provider · $model"

    /**
     * The agent's short name for sentences such as "Claude wants to use Notes": the provider
     * without a trailing "Code" or "CLI". Null when the provider is unknown.
     */
    val agentName: String?
        get() {
            var name = provider.trim()
            if (name.isEmpty() || name == Unknown.provider) return null
            for (suffix in listOf(" Code", " CLI")) {
                if (name.endsWith(suffix) && name.length > suffix.length) name = name.dropLast(suffix.length)
            }
            return name
        }

    companion object {
        val Unknown = ThreadIdentity(provider = "Unknown provider", model = "Unknown model")

        private val names = mapOf(
            "claudeAgent" to "Claude Code", "codex" to "Codex", "githubCopilot" to "GitHub Copilot", "copilot" to "GitHub Copilot",
            "gemini" to "Gemini CLI", "grok" to "Grok", "opencode" to "OpenCode", "pi" to "Pi", "muse" to "Muse",
        )

        fun from(selection: ModelSelection, providers: List<ServerProviderSummary>): ThreadIdentity {
            val catalog = providers.firstOrNull { it.instanceId == selection.instanceId }
            val id = catalog?.driver ?: selection.instanceId
            val brand = if (id == "acpRegistry") {
                registryBrand(catalog?.iconUrl) ?: localAcpBrand(selection.instanceId)
            } else {
                providerBrand(id)
            }
            val provider = catalog?.displayName?.trim()?.ifEmpty { null } ?: names[id] ?: selection.instanceId
            val model = catalog?.models?.firstOrNull { it.slug == selection.model || (it.aliases ?: emptyList()).contains(selection.model) }?.name
                ?: modelName(selection.model)
            return ThreadIdentity(provider, model, brand, modelBrand(selection.model))
        }

        internal fun registryBrand(icon: String?): String? {
            if (icon == null) return null
            val url = try {
                URI(icon)
            } catch (_: Exception) {
                return null
            }
            val path = url.path ?: return null
            val prefix = "/registry/v1/latest/"
            if (url.scheme != "https" || url.host != "cdn.agentclientprotocol.com" || url.userInfo != null || url.port != -1) return null
            if (!path.startsWith(prefix) || !path.endsWith(".svg")) return null
            val agent = path.removePrefix(prefix).dropLast(4)
            if (agent == "github-copilot" || agent == "github-copilot-cli") return "copilot"
            if (agent == "droid" || agent == "factory-droid") return "factory"
            val brands = listOf(
                "claude" to "claude", "codex" to "openai", "openai" to "openai", "gemini" to "gemini", "grok" to "grok",
                "cursor" to "cursor", "qwen" to "qwen", "kimi" to "kimi", "mistral" to "mistral", "kiro" to "kiro", "deepseek" to "deepseek",
            )
            for ((start, brand) in brands) {
                if (agent == start || agent.startsWith("$start-")) return brand
            }
            return agent.takeIf { it in setOf("opencode", "goose", "cline", "auggie", "amp", "junie") }
        }

        /** A local DeepSeek Harness instance has no icon URL; its instance id is all that names it. */
        internal fun localAcpBrand(instanceId: String): String? =
            if (instanceId.lowercase().startsWith("acpregistry_deepseek")) "deepseek" else null

        fun providerBrand(id: String): String? = when (val lower = id.lowercase()) {
            "claudeagent", "claude", "claude-code", "acpregistry_claude-acp" -> "claude"
            "codex", "openai" -> "openai"
            "githubcopilot", "githubcopilotacp", "copilot", "acpregistry_github-copilot" -> "copilot"
            "gemini", "acpregistry_gemini" -> "gemini"
            "grok", "acpregistry_grok" -> "grok"
            "opencode", "acpregistry_opencode" -> "opencode"
            "pi" -> "pi"
            "muse" -> "meta"
            "cursor", "antigravity", "ollama" -> lower
            else -> null
        }

        fun modelBrand(slug: String): String? {
            val value = slug.lowercase().split('/').last()
            return when {
                value.startsWith("claude") || value.startsWith("opus") || value.startsWith("sonnet") || value.startsWith("haiku") -> "claude"
                value.startsWith("gpt-") || value.startsWith("o3") || value.startsWith("o4") -> "openai"
                value.startsWith("gemini") -> "gemini"
                value.startsWith("grok") -> "grok"
                else -> null
            }
        }

        /** Known family and version ids only; a custom model keeps its exact identifier. */
        internal fun modelName(slug: String): String {
            val lower = slug.lowercase()
            for (family in listOf("opus", "sonnet", "haiku")) {
                val prefix = "claude-$family-"
                if (lower.startsWith(prefix)) {
                    val version = slug.drop(prefix.length)
                    if (version.all { it.isDigit() || it == '-' || it == '.' }) {
                        return family.replaceFirstChar { it.uppercase() } + " " + version.replace('-', '.')
                    }
                }
            }
            if (lower.startsWith("gpt-")) return "GPT-" + slug.drop(4)
            if (lower == "auto") return "Auto"
            return slug.ifEmpty { "Unknown model" }
        }
    }
}
