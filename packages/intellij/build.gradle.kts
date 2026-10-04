import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
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

// The integration test (src/integrationTest): a real IDE with the plugin, driven by Starter + Driver.
val integrationTest by sourceSets.creating

dependencies {
    intellijPlatform {
        val platformPath = providers.gradleProperty("platformPath").orNull
        // -PplatformType=IU -PplatformVersion=2026.1.3 downloads another IDE instead, e.g. IntelliJ IDEA.
        val platformType = providers.gradleProperty("platformType").getOrElse("GO")
        val platformVersion = providers.gradleProperty("platformVersion").getOrElse("2026.1.3")
        if (platformPath != null) local(platformPath) else create(platformType, platformVersion)
        bundledPlugin("org.jetbrains.plugins.terminal")
        bundledModule("intellij.terminal.frontend")
        testFramework(TestFrameworkType.Starter, configurationName = integrationTest.implementationConfigurationName)
    }
    // Unit tests (src/test): plain functions, no IDE.
    testImplementation("org.junit.jupiter:junit-jupiter:5.13.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.13.4")
    integrationTest.implementationConfigurationName(kotlin("stdlib"))
    integrationTest.implementationConfigurationName("org.junit.jupiter:junit-jupiter:5.13.4")
    integrationTest.runtimeOnlyConfigurationName("org.junit.platform:junit-platform-launcher:1.13.4")
    integrationTest.implementationConfigurationName("org.kodein.di:kodein-di-jvm:7.26.1")
    integrationTest.implementationConfigurationName("org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.10.2")
    integrationTest.implementationConfigurationName("com.google.code.gson:gson:2.13.1")
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

tasks.test {
    useJUnitPlatform()
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

// ./gradlew integrationTest: starts the IDE the plugin builds against (-PplatformPath, or the downloaded one).
intellijPlatformTesting.testIdeUi.register("integrationTest") {
    task {
        testClassesDirs = integrationTest.output.classesDirs
        classpath = integrationTest.runtimeClasspath
        useJUnitPlatform()
        // The test installs the plugin from the built zip, the task's path.to.build.plugin.
        val ide = intellijPlatform.platformPath
        doFirst { systemProperty("ai.pair.ide", ide.toString()) }
        // Starter's copy of the IDE and its test runs go to build/out/ide-tests (otherwise the repo's out/).
        val build = layout.buildDirectory.get().asFile
        systemProperty("ai.pair.build", build.path)
        systemProperty("allure.results.directory", File(build, "allure-results").path)
        testLogging {
            showStandardStreams = true
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
    }
}

tasks.withType<PrepareSandboxTask>().configureEach {
    from(buildHost) {
        into(intellijPlatform.projectName.map { "$it/host" })
    }
}
