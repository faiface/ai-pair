import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "ai.pair"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        val platformPath = providers.gradleProperty("platformPath").orNull
        if (platformPath != null) local(platformPath) else create("GO", "2026.1.3")
        bundledPlugin("org.jetbrains.plugins.terminal")
        bundledModule("intellij.terminal.frontend")
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "261"
        }
    }
    buildSearchableOptions = false
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
    }
}

// The Node host (packages/intellij-host), shipped next to the plugin's jars as host/intellij-host.cjs.
val hostDir = layout.projectDirectory.dir("../intellij-host")

val buildHost by tasks.registering(Exec::class) {
    workingDir = hostDir.asFile
    commandLine("node", "scripts/build.mjs", "--production")
    inputs.dir(hostDir.dir("src"))
    inputs.dir(layout.projectDirectory.dir("../core/src"))
    inputs.dir(layout.projectDirectory.dir("../protocol/src"))
    inputs.dir(layout.projectDirectory.dir("../relay/src"))
    // The panel's page and the demo script are VS Code's own (panelHtml.ts, demoScript.ts).
    inputs.dir(layout.projectDirectory.dir("../vscode/src"))
    outputs.files(hostDir.file("dist/intellij-host.cjs"), hostDir.file("dist/relay.cjs"))
}

// ./gradlew runIde -PopenProject=<folder> opens that folder in the sandbox IDE.
tasks.runIde {
    providers.gradleProperty("openProject").orNull?.let { args(it) }
    // -PaiPairHome=<dir>: keep the sandbox's discovery files and launcher away from the real ~/.ai-pair.
    providers.gradleProperty("aiPairHome").orNull?.let { environment("AI_PAIR_HOME", it) }
}

tasks.withType<PrepareSandboxTask>().configureEach {
    from(buildHost) {
        into(intellijPlatform.projectName.map { "$it/host" })
    }
}
