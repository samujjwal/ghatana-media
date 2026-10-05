package com.ghatana.media.tts.api;

import java.util.List;

/**
 * TTS user profile.
 *
 * @doc.type record
 * @doc.purpose User-specific TTS profile and preferences
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record TtsProfile(
    String profileId,
    String displayName,
    String preferredVoiceId,
    ProfileSettings settings,
    List<String> recentSyntheses
) {}
