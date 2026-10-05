package com.ghatana.media.stt.api;

import java.util.List;
import java.util.Locale;

/**
 * User profile for personalized STT.
 *
 * @doc.type record
 * @doc.purpose User-specific STT adaptation profile
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record UserProfile(
    String profileId,
    String displayName,
    Locale primaryLanguage,
    List<String> customVocabulary,
    byte[] speakerEmbedding
) {}
