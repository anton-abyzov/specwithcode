package com.specwithcode.transport

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Public settings for SpecWithCode Connect. A build without its own values uses the hosted
 * service, so no build lands on pairing with no way to sign in.
 */
data class ConnectConfig(
    /** Clerk publishable key (`pk_live_…` or `pk_test_…`). Public by design. */
    val publishableKey: String,
    /** The relay origin without a trailing slash. It is also the token-exchange `resource`. */
    val relayUrl: String,
    /** Clerk JWT template whose audience is the relay. */
    val jwtTemplate: String = DEFAULT_JWT_TEMPLATE,
    /** Sign-in providers, e.g. `google`, `github`. */
    val oauthProviders: List<String> = emptyList(),
) {
    companion object {
        const val DEFAULT_JWT_TEMPLATE = "studio-relay"

        /** The hosted service. All of it is public by design. */
        val hosted = ConnectConfig(
            publishableKey = "pk_live_Y2xlcmsuc3BlYy13ZWF2ZS5jb20k",
            relayUrl = "https://relay.spec-weave.com",
            oauthProviders = listOf("google"),
        )

        /**
         * Reads build values. Unset values arrive as null, empty strings or the literal `$(NAME)`;
         * all count as absent. Null when the key or relay is missing or unusable.
         */
        fun fromValues(publishableKey: String?, relayUrl: String?, jwtTemplate: String? = null, oauthProviders: String? = null): ConnectConfig? {
            fun value(raw: String?) = raw?.trim()?.takeIf { it.isNotEmpty() && !it.startsWith("$(") }
            val key = value(publishableKey)?.takeIf { it.startsWith("pk_") } ?: return null
            val relay = value(relayUrl)?.trimEnd('/') ?: return null
            val url = relay.toHttpUrlOrNull() ?: return null
            if (url.scheme != "https" && url.host != "localhost" && url.host != "127.0.0.1") return null
            return ConnectConfig(
                publishableKey = key,
                relayUrl = relay,
                jwtTemplate = value(jwtTemplate) ?: DEFAULT_JWT_TEMPLATE,
                oauthProviders = value(oauthProviders).orEmpty()
                    .split(',', ' ')
                    .map { it.lowercase() }
                    .filter { it.isNotEmpty() },
            )
        }

        /** The build's own values, else the hosted service. */
        fun resolve(publishableKey: String?, relayUrl: String?, jwtTemplate: String? = null, oauthProviders: String? = null): ConnectConfig =
            fromValues(publishableKey, relayUrl, jwtTemplate, oauthProviders) ?: hosted
    }
}
