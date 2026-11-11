plugins {
    id("java-module")
    application
}

val mediaPrefix = if (rootProject.findProject(":services:media:modules:production:timeline") != null) {
    ":services:media"
} else {
    ":media"
}

dependencies {
    implementation(libs.jackson.databind)
    implementation(project("$mediaPrefix:modules:production:timeline"))
}

application {
    mainClass.set("com.ghatana.media.examples.storyboarddraft.StoryboardDraftCommand")
}
