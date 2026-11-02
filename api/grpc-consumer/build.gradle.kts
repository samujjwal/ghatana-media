plugins {
    application
}

val grpcApiVersion = providers.gradleProperty("grpcApiVersion").orElse("0.1.0-SNAPSHOT")

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(27))
}

dependencies {
    implementation("com.ghatana.audio-video:grpc-api:${grpcApiVersion.get()}")
}

application {
    mainClass.set("com.ghatana.media.consumer.GrpcApiConsumerSmoke")
}
