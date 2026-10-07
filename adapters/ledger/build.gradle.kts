plugins {
    id("java-module")
}

dependencies {
    implementation("com.ghatana.platform:core:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Ghatana-owned run-ledger values shared with runtime service adapters.
    implementation(project(":services:data-cloud:delivery:api"))
    
    // Jackson for JSON
    implementation(libs.jackson.databind)
    
    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
}
