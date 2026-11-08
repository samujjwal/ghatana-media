plugins {
    id("java-module")
}

dependencies {
    implementation(libs.jackson.databind)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
}

tasks.test { useJUnitPlatform() }
