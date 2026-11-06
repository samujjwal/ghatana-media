plugins {
    id("java-module")
}

dependencies {
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.jackson.databind)
}

tasks.test { useJUnitPlatform() }
