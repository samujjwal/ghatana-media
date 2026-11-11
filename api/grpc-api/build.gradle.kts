import com.google.protobuf.gradle.id

plugins {
    `java-library`
    `maven-publish`
    id("com.google.protobuf")
}

group = rootProject.group
version = rootProject.version

val grpcVersion = libs.versions.grpc.get()
val protobufVersion = libs.versions.protobuf.get()
val javaTarget = libs.versions.java.get().toInt()

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(javaTarget))
    withSourcesJar()
}

sourceSets.named("main") {
    proto {
        // These are the canonical wire-contract sources. Do not copy them into
        // this artifact project or edit them here.
        srcDir(rootProject.file("modules/speech/stt-service/src/main/proto"))
        srcDir(rootProject.file("modules/speech/tts-service/src/main/proto"))
        srcDir(rootProject.file("modules/vision/vision-service/src/main/proto"))
        srcDir(rootProject.file("modules/intelligence/multimodal-service/src/main/proto"))
    }
}

protobuf {
    protoc { artifact = "com.google.protobuf:protoc:$protobufVersion" }
    plugins {
        id("grpc") { artifact = "io.grpc:protoc-gen-grpc-java:$grpcVersion" }
    }
    generateProtoTasks {
        all().configureEach {
            plugins { id("grpc") }
        }
    }
}

dependencies {
    api("com.google.protobuf:protobuf-java:$protobufVersion")
    api("io.grpc:grpc-protobuf:$grpcVersion")
    api("io.grpc:grpc-stub:$grpcVersion")
    compileOnly(libs.javax.annotation.api)
    compileOnly(libs.lombok)
    annotationProcessor(libs.lombok)
}

publishing {
    publications {
        create<MavenPublication>("grpcApi") {
            from(components["java"])
            // The artifact name follows the module name: com.ghatana.audio-video:grpc-api.
            artifactId = project.name
            pom {
                name.set("Ghatana Media gRPC API")
                description.set("Generated Media gRPC messages and clients from the existing Media protos")
            }
        }
    }
    repositories {
        maven {
            name = "isolatedLocal"
            url = rootProject.layout.buildDirectory.dir("grpc-api-maven-repository").get().asFile.toURI()
        }
    }
}
