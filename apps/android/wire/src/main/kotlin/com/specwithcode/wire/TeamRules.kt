package com.specwithcode.wire

import kotlinx.serialization.Serializable

/**
 * `TeamRulesSummary`: the limits a company set on a machine, as clients read them. Absent
 * with no rules and on servers that predate them. Every field is read on its own, so one a
 * newer server changed costs only that field.
 */
@Serializable(with = TeamRulesSummarySerializer::class)
data class TeamRulesSummary(
    /** `active` or `hold`, when a broken rules file pauses agents. */
    val status: String = "active",
    val owner: String? = null,
    val contact: String? = null,
    val fingerprint: String? = null,
    val ceiling: RuntimeMode? = null,
    val routinesCeiling: RuntimeMode? = null,
    val providers: List<String>? = null,
    val models: List<String>? = null,
    val pinnedProviders: List<String>? = null,
    val ownsProviderLaunch: Boolean? = null,
    val telemetryExport: Boolean? = null,
    val reach: Reach? = null,
    val tools: Tools? = null,
    /** Why the rules are on hold. */
    val issues: List<String>? = null,
) {
    @Serializable
    data class Reach(
        @Serializable(with = LenientBool::class) val phones: Boolean? = null,
        @Serializable(with = LenientBool::class) val connect: Boolean? = null,
        /** `any`, `same-rules` or `none`. */
        @Serializable(with = LenientString::class) val machines: String? = null,
        @Serializable(with = LenientBool::class) val webhooks: Boolean? = null,
    )

    @Serializable
    data class Tools(
        @Serializable(with = LenientBool::class) val chrome: Boolean? = null,
        @Serializable(with = LenientBool::class) val computerUse: Boolean? = null,
        @Serializable(with = LenientBool::class) val google: Boolean? = null,
        @Serializable(with = LenientBool::class) val telegram: Boolean? = null,
    )
}

object TeamRulesSummarySerializer : ObjectSerializer<TeamRulesSummary>("TeamRulesSummary") {
    override fun JsonReader.read() = TeamRulesSummary(
        status = string("status"),
        owner = lenient("owner"),
        contact = lenient("contact"),
        fingerprint = lenient("fingerprint"),
        ceiling = lenient("ceiling"),
        routinesCeiling = lenient("routinesCeiling"),
        providers = lenient("providers"),
        models = lenient("models"),
        pinnedProviders = lenient("pinnedProviders"),
        ownsProviderLaunch = lenient("ownsProviderLaunch"),
        telemetryExport = lenient("telemetryExport"),
        reach = lenient("reach"),
        tools = lenient("tools"),
        issues = lenient("issues"),
    )

    override fun JsonWriter.write(value: TeamRulesSummary) {
        put("status", value.status)
        put("owner", value.owner)
        put("contact", value.contact)
        put("fingerprint", value.fingerprint)
        put("ceiling", value.ceiling)
        put("routinesCeiling", value.routinesCeiling)
        put("providers", value.providers)
        put("models", value.models)
        put("pinnedProviders", value.pinnedProviders)
        put("ownsProviderLaunch", value.ownsProviderLaunch)
        put("telemetryExport", value.telemetryExport)
        put("reach", value.reach)
        put("tools", value.tools)
        put("issues", value.issues)
    }
}

/** The ceiling a thread brought from another machine, from `origin.carried`. */
@Serializable
data class TeamRulesCarried(
    val ceiling: RuntimeMode,
    val owner: String,
    val contact: String? = null,
    val from: String? = null,
)

object LenientTeamRulesCarried : LenientSerializer<TeamRulesCarried>(TeamRulesCarried.serializer())

/** `OrchestrationV2ThreadOrigin`: only the part the app reads. */
@Serializable
data class ThreadOriginSummary(
    @Serializable(with = LenientTeamRulesCarried::class) val carried: TeamRulesCarried? = null,
)
