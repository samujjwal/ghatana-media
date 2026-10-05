package com.ghatana.media.common;

/** @doc.type record @doc.purpose Streaming audio chunk @doc.layer common @doc.pattern ValueObject */
public record AudioChunk(
    byte[] data,
    int sequenceNumber,
    boolean isLast,
    long timestampMs
) {}
