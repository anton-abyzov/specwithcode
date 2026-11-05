import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    api(project(":wire"))
    api(libs.kotlinx.coroutines.core)
    api(libs.okhttp)
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

tasks.test {
    // DPOP_VECTORS_OUT=<file> makes DpopTest write proofs for Tools/verify-dpop-vectors.mjs.
    environment("DPOP_VECTORS_OUT", System.getenv("DPOP_VECTORS_OUT") ?: "")
    outputs.upToDateWhen { System.getenv("DPOP_VECTORS_OUT").isNullOrEmpty() }
}
