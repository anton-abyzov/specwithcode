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
    api(project(":transport"))
    api(libs.kotlinx.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

// The reducer tests read the wire module's recorded fixtures.
sourceSets {
    test {
        resources.srcDir("../wire/src/test/resources")
    }
}

// The transcript detail tests run the cases web, desktop and iOS share (docs/transcript-detail.md).
val transcriptDetailCases = rootProject.file("../../packages/shared/src/transcriptDetail.cases.json")
tasks.named<Test>("test") {
    inputs.file(transcriptDetailCases).withPropertyName("transcriptDetailCases")
    systemProperty("swc.transcriptDetailCases", transcriptDetailCases.absolutePath)
}
