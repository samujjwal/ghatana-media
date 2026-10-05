plugins {
    id("java-module")
}

dependencies {
    // Platform security
    implementation("com.ghatana.platform:security:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // Platform governance for tenant context
    implementation("com.ghatana.platform:governance:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // Platform observability for metrics
    implementation("com.ghatana.platform:observability:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // Audio-video messaging module
    implementation(project(":services:media:modules:infrastructure:messaging"))
    
    // gRPC for interceptors
    implementation(libs.grpc.api)
    implementation(libs.grpc.stub)
    
    // ActiveJ for HTTP security filter (if needed)
    implementation(libs.activej.http)
    
    // Logging
    implementation(libs.slf4j.api)
    
    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
}

tasks.test {
    useJUnitPlatform()
}
