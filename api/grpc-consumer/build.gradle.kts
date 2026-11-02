plugins {
    application
}

val grpcApiVersion = providers.gradleProperty("grpcApiVersion").orElse("0.1.0-SNAPSHOT")

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(27))
}

dependencies {
    implementation("com.ghatana.audio-video:grpc-api:${grpcApiVersion.get()}")
    // Local transport used only by this isolated consumer smoke check. The Media
    // source projects and generated sources are deliberately absent from this build.
    implementation("io.grpc:grpc-inprocess:1.83.1")
}

application {
    mainClass.set("com.ghatana.media.consumer.GrpcApiConsumerSmoke")
}
