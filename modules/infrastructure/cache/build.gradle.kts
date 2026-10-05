plugins {
    id("java-module")
}

dependencies {
    // Audio-video persistence entities used by transcription cache serialization
    api(project(":services:media:modules:infrastructure:persistence"))

    // Platform cache abstractions are owned by the cache module.
    implementation("com.ghatana.platform:cache:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // Platform observability
    implementation("com.ghatana.platform:observability:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // Redis client
    implementation(libs.lettuce.core)
    
    // JSON serialization
    implementation(libs.jackson.databind)
    // Caffeine for local cache (as used in AEP)
    implementation(libs.caffeine)
    
    // Logging
    implementation(libs.slf4j.api)
    
    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.testcontainers.core)
    testImplementation(libs.testcontainers.junit.jupiter)
    testImplementation(libs.testcontainers.redis)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
}

tasks.test {
    useJUnitPlatform()
    // Exclude integration tests (ending in IT) as they require Docker/Testcontainers
    exclude("**/*IT.class", "**/*IT$*.class")
}
