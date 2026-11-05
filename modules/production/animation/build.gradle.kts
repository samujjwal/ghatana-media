plugins {
    id("java-module")
}

val commonLibrary = sequenceOf(
    ":services:media:libs:java:common",
    ":media:libs:java:common"
).mapNotNull(rootProject::findProject).firstOrNull()
    ?: throw GradleException("The Media Java common project is required by the animation renderer")

dependencies {
    api(commonLibrary)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
}

tasks.test {
    useJUnitPlatform()
}
