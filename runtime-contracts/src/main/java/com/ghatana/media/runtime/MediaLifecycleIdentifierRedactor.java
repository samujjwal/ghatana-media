package com.ghatana.media.runtime;

/** Creates stable, purpose-separated public aliases for internal lifecycle identifiers. */
@FunctionalInterface
public interface MediaLifecycleIdentifierRedactor {
    String redact(String identifierKind, String rawIdentifier);
}
