package com.ghatana.media.production.simulation.scenario;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A scenario that cannot be run: a typed refusal that names the JSON path of the offending value. It is raised before any
 * solver step, so nothing is ever computed or fabricated for a refused scenario.
 */
public final class ScenarioException extends RuntimeException {
    /** Refusal class; maps one-to-one to a host error code. */
    public enum Kind { INVALID, UNIT_MISMATCH, NON_FINITE, BUDGET }

    private final Kind kind;
    private final String path;
    private final Map<String, Object> details;

    public ScenarioException(Kind kind, String path, String message) {
        this(kind, path, message, Map.of());
    }

    public ScenarioException(Kind kind, String path, String message, Map<String, Object> extra) {
        super(message, null, false, false);
        this.kind = kind;
        this.path = path;
        Map<String, Object> merged = new LinkedHashMap<>();
        merged.put("path", path);
        merged.putAll(extra);
        this.details = Map.copyOf(merged);
    }

    public Kind kind() { return kind; }
    public String path() { return path; }
    public Map<String, Object> details() { return details; }
}
