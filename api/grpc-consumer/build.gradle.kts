plugins {
    application
}

val grpcApiVersion = providers.gradleProperty("grpcApiVersion").orNull
    ?: error("Pass -PgrpcApiVersion=<staged Media gRPC API version>")

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(27))
}

dependencies {
    implementation("com.ghatana.audio-video:grpc-api:$grpcApiVersion")
    // Local transport used only by this isolated consumer smoke check. The Media
    // source projects and generated sources are deliberately absent from this build.
    implementation("io.grpc:grpc-inprocess:1.83.1")
}

application {
    mainClass.set("com.ghatana.media.consumer.GrpcApiConsumerSmoke")
}
