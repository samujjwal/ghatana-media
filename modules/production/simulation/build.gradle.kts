plugins {
    id("java-module")
}

dependencies {
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
}

tasks.test { useJUnitPlatform() }
