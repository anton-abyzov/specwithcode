import java.io.File
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Upload-key signing. The properties file (keys storeFile, storePassword, keyAlias, keyPassword) lives
 * outside the repo; its path comes from -PSWC_ANDROID_SIGNING_PROPERTIES, the SWC_ANDROID_SIGNING_PROPERTIES
 * environment variable, or ~/.config/specwithcode/specwithcode-android-upload.properties. When it is
 * missing or incomplete, release builds are unsigned so CI can still build them.
 */
val releaseSigning: Properties? = run {
    val home = System.getProperty("user.home")
    val raw = providers.gradleProperty("SWC_ANDROID_SIGNING_PROPERTIES").orNull
        ?: providers.environmentVariable("SWC_ANDROID_SIGNING_PROPERTIES").orNull
        ?: "$home/.config/specwithcode/specwithcode-android-upload.properties"
    val file = File(raw.replaceFirst(Regex("^~(?=/|$)"), home))
    if (!file.isFile) return@run null
    val props = Properties().apply { file.inputStream().use(::load) }
    val required = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
    if (required.any { props.getProperty(it).isNullOrBlank() }) {
        logger.warn("Signing properties at ${file.path} are missing a key; release builds will be unsigned.")
        return@run null
    }
    val store = File(props.getProperty("storeFile").replaceFirst(Regex("^~(?=/|$)"), home))
    val resolved = if (store.isAbsolute) store else File(file.parentFile, store.path)
    if (!resolved.isFile) {
        logger.warn("The keystore named in ${file.path} does not exist; release builds will be unsigned.")
        return@run null
    }
    props.setProperty("storeFile", resolved.absolutePath)
    props
}

/** -PswcVersionCode=N overrides the version code, for example from a CI run number. */
val swcVersionCode: Int = providers.gradleProperty("swcVersionCode").orNull?.toIntOrNull() ?: 2

android {
    namespace = "com.specwithcode.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.specwithcode.android"
        minSdk = 26
        targetSdk = 36
        // The Expo app shipped as versionCode 1; this native app replaces it.
        versionCode = swcVersionCode
        versionName = "0.2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["clearPackageData"] = "true"

        // SpecWithCode Connect. Empty values use the hosted service (ConnectConfig.hosted);
        // override with -PconnectPublishableKey=pk_... -PconnectRelayUrl=https://... for staging.
        buildConfigField("String", "CONNECT_PUBLISHABLE_KEY", "\"${providers.gradleProperty("connectPublishableKey").getOrElse("")}\"")
        buildConfigField("String", "CONNECT_RELAY_URL", "\"${providers.gradleProperty("connectRelayUrl").getOrElse("")}\"")
        buildConfigField("String", "CONNECT_JWT_TEMPLATE", "\"${providers.gradleProperty("connectJwtTemplate").getOrElse("")}\"")
        buildConfigField("String", "CONNECT_OAUTH_PROVIDERS", "\"${providers.gradleProperty("connectOauthProviders").getOrElse("")}\"")
    }

    signingConfigs {
        releaseSigning?.let { props ->
            create("release") {
                storeFile = File(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (releaseSigning != null) signingConfigs.getByName("release") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
        // Each instrumented test runs in its own process with cleared app data.
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":sync"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.browser)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestUtil(libs.androidx.test.orchestrator)
}
