plugins {
    id("java-module")
}

dependencies {
    // Platform database - use the JpaRepository abstraction
    implementation("com.ghatana.platform:database:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform governance for tenant context
    implementation("com.ghatana.platform:governance:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform core utilities
    implementation("com.ghatana.platform:core:${providers.gradleProperty("ghatana.shared.version").get()}")

    // JPA/Hibernate (implementation only, no Spring)
    api(libs.jakarta.persistence.api)
    implementation(libs.hibernate.core)

    // Database drivers
    implementation(libs.postgresql)

    // Connection pooling
    implementation(libs.hikaricp)

    // Migration
    implementation(libs.flyway.core)

    // JSON handling
    implementation(libs.jackson.databind)

    // Logging
    implementation(libs.slf4j.api)

    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.testcontainers.junit.jupiter)
    testImplementation(libs.testcontainers.postgresql)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation(libs.h2)
}

tasks.test {
    useJUnitPlatform()
    // Exclude integration tests as they require Docker/Testcontainers
    exclude("**/*IT.class", "**/*IT$*.class", "**/*IntegrationTest.class", "**/*IntegrationTest$*.class")
}
