plugins {
    id("java-module")
}

dependencies {
    implementation("com.ghatana.platform:core:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Ghatana-owned run-ledger values shared with runtime service adapters.
    // RunLedger appears in this adapter's public method signatures, so consumers
    // need the canonical Data Cloud API on their compile classpath as well.
    api(project(":services:data-cloud:delivery:api"))
    
    // Jackson for JSON
    implementation(libs.jackson.databind)
    
    // Testing
    testImplementation(project(":services:media:runtime-contracts"))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
}
