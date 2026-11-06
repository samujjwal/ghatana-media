plugins {
    id("java-module")
}

dependencies {
    api(project(":services:media:runtime-contracts"))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
}

tasks.test { useJUnitPlatform() }
