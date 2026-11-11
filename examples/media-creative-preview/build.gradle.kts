plugins {
    id("java-module")
    application
}

val mediaPrefix = if (rootProject.findProject(":services:media:modules:production:animation") != null) {
    ":services:media"
} else {
    ":media"
}

dependencies {
    implementation(libs.jackson.databind)
    implementation(project("$mediaPrefix:modules:production:animation"))
    implementation(project("$mediaPrefix:modules:production:audio-mixing"))
    implementation(project("$mediaPrefix:modules:production:simulation"))
    implementation(project("$mediaPrefix:modules:production:spatial"))
}

application {
    mainClass.set("com.ghatana.media.examples.creativepreview.MediaCreativePreview")
}

tasks.register<JavaExec>("audioRepairPreview") {
    group = "application"
    description = "Create a bounded local A/B declip preview from a caller-provided PCM WAV."
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("com.ghatana.media.examples.creativepreview.AudioRepairPreview")
    val input = project.findProperty("audioRepairInput")
    val output = project.findProperty("audioRepairOutput")
    if (output != null && input == null) {
        throw GradleException("audioRepairOutput requires audioRepairInput")
    }
    if (input != null) args(input.toString())
    if (output != null) args(output.toString())
}

tasks.register<JavaExec>("foleyStemMasterPreview") {
    group = "application"
    description = "Mix caller-provided, exact-format WAV stems into a bounded local master preview."
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("com.ghatana.media.examples.creativepreview.FoleyStemMasterPreview")
    val request = project.findProperty("foleyMixRequest")
    val output = project.findProperty("foleyMixOutput")
    if (output != null && request == null) {
        throw GradleException("foleyMixOutput requires foleyMixRequest")
    }
    if (request != null) {
        if (output == null) throw GradleException("foleyMixRequest requires foleyMixOutput")
        args(request.toString(), output.toString())
    }
}
