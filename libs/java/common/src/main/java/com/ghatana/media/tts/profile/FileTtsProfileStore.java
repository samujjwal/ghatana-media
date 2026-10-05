/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.media.tts.profile;

import com.ghatana.media.tts.api.Emotion;
import com.ghatana.media.tts.api.ProfileSettings;
import com.ghatana.media.tts.api.TtsProfile;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Properties;

/**
 * Atomic local persistence for embedded TTS profiles.
 *
 * <p>Each profile is stored as one properties file under a configured directory. IDs are restricted
 * to safe filename characters, writes use a temporary file plus atomic replacement when supported,
 * and list fields are base64 encoded to preserve arbitrary Unicode without delimiter ambiguity.
 *
 * @doc.type class
 * @doc.purpose Durable embedded TTS profile persistence without external dependencies
 * @doc.layer platform
 * @doc.pattern Repository
 */
public final class FileTtsProfileStore {

    private static final String FORMAT_VERSION = "1";
    private final Path directory;

    public FileTtsProfileStore(Path directory) {
        this.directory = Objects.requireNonNull(directory, "directory").toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.directory);
        } catch (IOException failure) {
            throw new IllegalStateException(
                    "Unable to create TTS profile directory " + this.directory,
                    failure);
        }
        if (!Files.isDirectory(this.directory) || !Files.isWritable(this.directory)) {
            throw new IllegalStateException(
                    "TTS profile path must be a writable directory: " + this.directory);
        }
    }

    public Optional<TtsProfile> load(String profileId) {
        Path file = file(profileId);
        if (!Files.exists(file)) return Optional.empty();
        Properties properties = new Properties();
        try (InputStream input = Files.newInputStream(file)) {
            properties.load(input);
        } catch (IOException failure) {
            throw new IllegalStateException("Unable to read TTS profile " + profileId, failure);
        }
        if (!FORMAT_VERSION.equals(properties.getProperty("formatVersion"))) {
            throw new IllegalStateException("Unsupported TTS profile format for " + profileId);
        }
        ProfileSettings settings = new ProfileSettings(
                requiredDouble(properties, "defaultSpeed"),
                requiredDouble(properties, "defaultPitch"),
                requiredDouble(properties, "defaultVolume"),
                Emotion.valueOf(required(properties, "defaultEmotion")),
                readList(properties, "pronunciation"));
        return Optional.of(new TtsProfile(
                required(properties, "profileId"),
                required(properties, "displayName"),
                required(properties, "preferredVoiceId"),
                settings,
                readList(properties, "recentSynthesis")));
    }

    public TtsProfile save(TtsProfile profile) {
        Objects.requireNonNull(profile, "profile");
        String profileId = safeId(profile.profileId());
        Properties properties = new Properties();
        properties.setProperty("formatVersion", FORMAT_VERSION);
        properties.setProperty("profileId", profileId);
        properties.setProperty("displayName", requireText(profile.displayName(), "displayName"));
        properties.setProperty(
                "preferredVoiceId",
                requireText(profile.preferredVoiceId(), "preferredVoiceId"));
        ProfileSettings settings = Objects.requireNonNull(profile.settings(), "settings");
        properties.setProperty("defaultSpeed", Double.toString(settings.defaultSpeed()));
        properties.setProperty("defaultPitch", Double.toString(settings.defaultPitch()));
        properties.setProperty("defaultVolume", Double.toString(settings.defaultVolume()));
        properties.setProperty(
                "defaultEmotion",
                Objects.requireNonNull(settings.defaultEmotion(), "defaultEmotion").name());
        writeList(properties, "pronunciation", settings.customPronunciations());
        writeList(properties, "recentSynthesis", profile.recentSyntheses());

        Path target = file(profileId);
        Path temporary;
        try {
            temporary = Files.createTempFile(directory, profileId + "-", ".tmp");
            try (OutputStream output = Files.newOutputStream(temporary)) {
                properties.store(output, "Ghatana TTS profile");
            }
            try {
                Files.move(
                        temporary,
                        target,
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException failure) {
            throw new IllegalStateException("Unable to persist TTS profile " + profileId, failure);
        }
        return profile;
    }

    public boolean delete(String profileId) {
        try {
            return Files.deleteIfExists(file(profileId));
        } catch (IOException failure) {
            throw new IllegalStateException("Unable to delete TTS profile " + profileId, failure);
        }
    }

    private Path file(String profileId) {
        String id = safeId(profileId);
        Path file = directory.resolve(id + ".properties").normalize();
        if (!file.getParent().equals(directory)) {
            throw new IllegalArgumentException("profileId escapes profile directory");
        }
        return file;
    }

    private static String safeId(String value) {
        String id = requireText(value, "profileId");
        if (id.length() > 128 || !id.matches("[A-Za-z0-9._-]+")) {
            throw new IllegalArgumentException(
                    "profileId must contain only letters, digits, '.', '_', or '-' and be <= 128 characters");
        }
        return id;
    }

    private static void writeList(Properties properties, String prefix, List<String> values) {
        List<String> safe = List.copyOf(values == null ? List.of() : values);
        properties.setProperty(prefix + ".count", Integer.toString(safe.size()));
        for (int index = 0; index < safe.size(); index++) {
            String value = Objects.requireNonNull(safe.get(index), prefix + " item");
            properties.setProperty(
                    prefix + "." + index,
                    Base64.getUrlEncoder().withoutPadding().encodeToString(
                            value.getBytes(StandardCharsets.UTF_8)));
        }
    }

    private static List<String> readList(Properties properties, String prefix) {
        int count;
        try {
            count = Integer.parseInt(properties.getProperty(prefix + ".count", "0"));
        } catch (NumberFormatException failure) {
            throw new IllegalStateException("Invalid " + prefix + " count", failure);
        }
        if (count < 0 || count > 10_000) {
            throw new IllegalStateException("Invalid " + prefix + " count: " + count);
        }
        List<String> values = new ArrayList<>(count);
        for (int index = 0; index < count; index++) {
            String encoded = required(properties, prefix + "." + index);
            try {
                values.add(new String(
                        Base64.getUrlDecoder().decode(encoded),
                        StandardCharsets.UTF_8));
            } catch (IllegalArgumentException failure) {
                throw new IllegalStateException(
                        "Invalid encoded " + prefix + " value at index " + index,
                        failure);
            }
        }
        return List.copyOf(values);
    }

    private static double requiredDouble(Properties properties, String key) {
        try {
            return Double.parseDouble(required(properties, key));
        } catch (NumberFormatException failure) {
            throw new IllegalStateException("Invalid numeric TTS profile property " + key, failure);
        }
    }

    private static String required(Properties properties, String key) {
        return requireText(properties.getProperty(key), key);
    }

    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }
}
