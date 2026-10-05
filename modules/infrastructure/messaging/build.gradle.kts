plugins {
    id("java-module")
}

dependencies {
    // Platform messaging
    implementation("com.ghatana.platform:messaging:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // Platform observability
    implementation("com.ghatana.platform:observability:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // Platform core
    implementation("com.ghatana.platform:core:${providers.gradleProperty("ghatana.shared.version").get()}")
    
    // RabbitMQ client
    implementation(libs.rabbitmq.amqp.client)
    
    // JSON serialization
    implementation(libs.jackson.databind)
    // Logging
    implementation(libs.slf4j.api)
    
    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.testcontainers.core)
    testImplementation(libs.testcontainers.junit.jupiter)
    testImplementation(libs.testcontainers.rabbitmq)
    testImplementation(libs.activej.promise)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")
    testRuntimeOnly(libs.log4j.slf4j.impl)
}

tasks.test {
    useJUnitPlatform()
    // Exclude integration tests (ending in IT) as they require Docker/Testcontainers
    exclude("**/*IT.class", "**/*IT$*.class")
}
