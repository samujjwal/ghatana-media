plugins {
    id("java-module")
}

dependencies {
    implementation("com.ghatana.platform:core:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform workflow module for RunLedger
    implementation("com.ghatana.platform:workflow:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // Jackson for JSON
    implementation(libs.jackson.databind)
    
    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
}
