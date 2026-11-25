plugins {
    id("java-module")
}

dependencies {
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
}

tasks.test {
    useJUnitPlatform()
    // The real-FFmpeg tests can skip when these are absent. Fingerprint the tool
    // selectors so adding/removing a tool cannot reuse a previously skipped result.
    inputs.property("GHATANA_MEDIA_FFMPEG", providers.environmentVariable("GHATANA_MEDIA_FFMPEG").orElse(""))
    inputs.property("GHATANA_MEDIA_FFPROBE", providers.environmentVariable("GHATANA_MEDIA_FFPROBE").orElse(""))
    inputs.property("ghatana.media.ffmpeg", providers.systemProperty("ghatana.media.ffmpeg").orElse(""))
    inputs.property("ghatana.media.ffprobe", providers.systemProperty("ghatana.media.ffprobe").orElse(""))
}
