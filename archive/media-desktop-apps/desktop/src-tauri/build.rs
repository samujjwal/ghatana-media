fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path()
        .expect("Failed to resolve vendored protoc binary");
    std::env::set_var("PROTOC", protoc);

    // Compile proto files
    tonic_build::configure()
        .build_server(false)
        .compile_protos(
            &[
                "proto/stt.proto",
                "proto/tts.proto",
                "proto/vision.proto",
                "proto/multimodal.proto",
                "proto/ai_voice.proto",
            ],
            &["proto"],
        )
        .expect("Failed to compile protos");
    
    tauri_build::build()
}
