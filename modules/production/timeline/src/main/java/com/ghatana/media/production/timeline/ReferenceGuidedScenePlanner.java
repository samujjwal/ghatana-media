package com.ghatana.media.production.timeline;

import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;

/**
 * Prepares a deterministic authored-template scene candidate from exact, rights-checked inputs.
 * This deliberately does not execute a model or claim an output artifact. The underlying PDP
 * shot-condition definition is still a proposed extension; exact graph/persistence mapping is
 * unresolved, so this class is a local candidate builder rather than a canonical graph writer.
 */
public final class ReferenceGuidedScenePlanner {
    private final CurrentSourceAuthority sourceAuthority;
    private final ModelProvider modelProvider;

    public ReferenceGuidedScenePlanner(CurrentSourceAuthority sourceAuthority, ModelProvider modelProvider) {
        this.sourceAuthority = Objects.requireNonNull(sourceAuthority, "sourceAuthority");
        this.modelProvider = Objects.requireNonNull(modelProvider, "modelProvider");
    }

    /** Creates a repeatable, authored-only candidate after fresh authority checks. */
    public Candidate prepare(Actor actor, Request request) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(request, "request");
        List<BoundSource> sources = request.allSources();
        verifyCurrentSourceRights(actor, request.purpose(), sources);

        List<String> violations = continuityViolations(request.template(), request.continuity());
        if (!violations.isEmpty()) throw new ContinuityConflictException(violations);
        String seed = deterministicSeed(request, sources);
        List<Provenance> provenance = sources.stream()
                .sorted(Comparator.comparing((BoundSource s) -> s.source().artifactId())
                        .thenComparing(s -> s.source().artifactVersionId()).thenComparing(BoundSource::role))
                .map(s -> new Provenance(s.role(), s.source(), s.sha256()))
                .toList();
        return new Candidate(actor.tenantId(), actor.principalId(), request.projectId(), request.sceneId(),
                request.expectedProjectRevisionId(), request.purpose(), request.template().templateId(), request.template().version(),
                request.prompt().authoredText(), request.template().authoredScene(), request.template().continuityFacts(), request.continuity(),
                provenance, seed, Preparation.AUTHORED_TEMPLATE_CANDIDATE);
    }

    /** Model-backed generation truthfully reports unavailable unless an admitted port is supplied. */
    public ModelResult generateWithModel(Candidate candidate) {
        Objects.requireNonNull(candidate, "candidate");
        boolean admitted;
        try {
            admitted = modelProvider.admitted();
        } catch (RuntimeException unavailable) {
            return new ModelUnavailable("PROVIDER_ADMISSION_UNAVAILABLE");
        }
        if (!admitted) return new ModelUnavailable("NO_ADMITTED_PROVIDER");
        verifyCurrentSourceRights(new Actor(candidate.tenantId(), candidate.ownerPrincipalId()), candidate.purpose(),
                candidate.provenance().stream()
                        .map(p -> new BoundSource(p.role(), p.source(), p.sha256())).toList());
        return modelProvider.generate(candidate);
    }

    private void verifyCurrentSourceRights(Actor actor, String purpose, List<BoundSource> sources) {
        for (BoundSource source : sources) {
            Decision decision;
            try {
                decision = sourceAuthority.inspect(actor, source, purpose);
            } catch (RuntimeException unavailable) {
                throw new SourceAuthorityUnavailableException();
            }
            if (decision == null || decision == Decision.UNKNOWN || decision == Decision.MISSING) {
                throw new SourceAuthorityUnavailableException();
            }
            if (decision == Decision.STALE) throw new StaleSourceVersionException(source.source());
            if (decision != Decision.ELIGIBLE) throw new SourceRightsDeniedException(source.source());
        }
    }

    public enum Decision { ELIGIBLE, MISSING, STALE, REVOKED, DENIED, UNKNOWN }
    public enum Preparation { AUTHORED_TEMPLATE_CANDIDATE }

    @FunctionalInterface
    public interface CurrentSourceAuthority {
        /** Must verify current purpose-specific policy and rights for the exact version and digest. */
        Decision inspect(Actor actor, BoundSource exactSource, String purpose);
    }

    /** Port for a separately admitted model integration. The default implementation is unavailable. */
    public interface ModelProvider {
        boolean admitted();
        ModelResult generate(Candidate candidate);
    }

    public sealed interface ModelResult permits ModelUnavailable, ModelOutput { }
    public record ModelUnavailable(String reason) implements ModelResult {
        public ModelUnavailable { reason = required(reason, "reason"); }
    }
    /** Kept in the type system for a future admitted adapter; this planner never fabricates it. */
    public record ModelOutput(String artifactId, String artifactVersionId, String sha256) implements ModelResult {
        public ModelOutput {
            artifactId = required(artifactId, "artifactId");
            artifactVersionId = required(artifactVersionId, "artifactVersionId");
            sha256 = digest(sha256);
        }
    }

    public record BoundSource(String role, SourceVersion source, String sha256) {
        public BoundSource {
            role = required(role, "source role");
            Objects.requireNonNull(source, "source");
            sha256 = digest(sha256);
        }
    }

    public record Prompt(String authoredText, BoundSource authoredSource) {
        public Prompt {
            authoredText = required(authoredText, "authoredText");
            Objects.requireNonNull(authoredSource, "authoredSource");
        }
    }

    public record ContinuityFact(String key, String value) {
        public ContinuityFact {
            key = required(key, "continuity key");
            value = required(value, "continuity value");
        }
    }

    public record ContinuitySnapshot(String stateId, String semanticVersion, List<ContinuityFact> facts,
                                     List<BoundSource> exactSources) {
        public ContinuitySnapshot {
            stateId = required(stateId, "continuity stateId");
            semanticVersion = required(semanticVersion, "continuity semanticVersion");
            facts = canonicalFacts(facts);
            exactSources = canonicalSources(exactSources);
        }
    }

    public record Template(String templateId, String version, String authoredScene,
                           List<ContinuityFact> continuityFacts, List<BoundSource> exactSources) {
        public Template {
            templateId = required(templateId, "templateId");
            version = required(version, "template version");
            authoredScene = required(authoredScene, "authoredScene");
            continuityFacts = canonicalFacts(continuityFacts);
            exactSources = canonicalSources(exactSources);
        }
    }

    public record Request(String projectId, String sceneId, String expectedProjectRevisionId, String purpose,
                         long seedInput, Prompt prompt, List<BoundSource> references, Template template,
                         ContinuitySnapshot continuity) {
        public Request {
            projectId = required(projectId, "projectId");
            sceneId = required(sceneId, "sceneId");
            expectedProjectRevisionId = required(expectedProjectRevisionId, "expectedProjectRevisionId");
            purpose = required(purpose, "purpose");
            Objects.requireNonNull(prompt, "prompt");
            references = canonicalSources(references);
            Objects.requireNonNull(template, "template");
            Objects.requireNonNull(continuity, "continuity");
            if (references.isEmpty()) throw new IllegalArgumentException("at least one exact reference is required");
        }

        private List<BoundSource> allSources() {
            List<BoundSource> all = new ArrayList<>();
            all.add(prompt.authoredSource());
            all.addAll(references);
            all.addAll(template.exactSources());
            all.addAll(continuity.exactSources());
            return canonicalSources(all);
        }
    }

    public record Provenance(String role, SourceVersion source, String sha256) {
        public Provenance {
            role = required(role, "role");
            Objects.requireNonNull(source, "source");
            sha256 = digest(sha256);
        }
    }

    public static final class Candidate {
        private final String tenantId;
        private final String ownerPrincipalId;
        private final String projectId;
        private final String sceneId;
        private final String expectedProjectRevisionId;
        private final String purpose;
        private final String templateId;
        private final String templateVersion;
        private final String authoredPrompt;
        private final String authoredScene;
        private final List<ContinuityFact> continuityFacts;
        private final ContinuitySnapshot priorContinuity;
        private final List<Provenance> provenance;
        private final String deterministicSeed;
        private final Preparation preparation;

        private Candidate(String tenantId, String ownerPrincipalId, String projectId, String sceneId,
                          String expectedProjectRevisionId, String purpose, String templateId, String templateVersion,
                          String authoredPrompt, String authoredScene, List<ContinuityFact> continuityFacts,
                          ContinuitySnapshot priorContinuity, List<Provenance> provenance,
                          String deterministicSeed, Preparation preparation) {
            this.tenantId = required(tenantId, "tenantId");
            this.ownerPrincipalId = required(ownerPrincipalId, "ownerPrincipalId");
            this.projectId = required(projectId, "projectId");
            this.sceneId = required(sceneId, "sceneId");
            this.expectedProjectRevisionId = required(expectedProjectRevisionId, "expectedProjectRevisionId");
            this.purpose = required(purpose, "purpose");
            this.templateId = required(templateId, "templateId");
            this.templateVersion = required(templateVersion, "templateVersion");
            this.authoredPrompt = required(authoredPrompt, "authoredPrompt");
            this.authoredScene = required(authoredScene, "authoredScene");
            this.continuityFacts = canonicalFacts(continuityFacts);
            this.priorContinuity = Objects.requireNonNull(priorContinuity, "priorContinuity");
            this.provenance = List.copyOf(provenance);
            this.deterministicSeed = digest(deterministicSeed);
            this.preparation = Objects.requireNonNull(preparation, "preparation");
            if (preparation != Preparation.AUTHORED_TEMPLATE_CANDIDATE) {
                throw new IllegalArgumentException("planner only prepares authored template candidates");
            }
        }

        public String tenantId() { return tenantId; }
        public String ownerPrincipalId() { return ownerPrincipalId; }
        public String projectId() { return projectId; }
        public String sceneId() { return sceneId; }
        public String expectedProjectRevisionId() { return expectedProjectRevisionId; }
        public String purpose() { return purpose; }
        public String templateId() { return templateId; }
        public String templateVersion() { return templateVersion; }
        public String authoredPrompt() { return authoredPrompt; }
        public String authoredScene() { return authoredScene; }
        public List<ContinuityFact> continuityFacts() { return continuityFacts; }
        public ContinuitySnapshot priorContinuity() { return priorContinuity; }
        public List<Provenance> provenance() { return provenance; }
        public String deterministicSeed() { return deterministicSeed; }
        public Preparation preparation() { return preparation; }
    }

    public static final class SourceAuthorityUnavailableException extends IllegalStateException {
        public SourceAuthorityUnavailableException() { super("current source policy/rights authority is unavailable or unknown"); }
    }
    public static final class SourceRightsDeniedException extends SecurityException {
        public SourceRightsDeniedException(SourceVersion source) { super("source is not currently authorized: " + source.artifactId()); }
    }
    public static final class StaleSourceVersionException extends IllegalStateException {
        public StaleSourceVersionException(SourceVersion source) { super("source version is stale: " + source.artifactId()); }
    }
    public static final class ContinuityConflictException extends IllegalArgumentException {
        private final List<String> conflicts;
        public ContinuityConflictException(List<String> conflicts) {
            super("authored template violates continuity constraints: " + String.join(", ", conflicts));
            this.conflicts = List.copyOf(conflicts);
        }
        public List<String> conflicts() { return conflicts; }
    }

    private static List<String> continuityViolations(Template template, ContinuitySnapshot prior) {
        var priorValues = prior.facts().stream().collect(java.util.stream.Collectors.toMap(
                ContinuityFact::key, ContinuityFact::value));
        List<String> violations = new ArrayList<>();
        for (ContinuityFact expected : template.continuityFacts()) {
            String actual = priorValues.get(expected.key());
            if (actual == null || !actual.equals(expected.value())) violations.add(expected.key());
        }
        return List.copyOf(violations);
    }

    private static String deterministicSeed(Request request, List<BoundSource> sources) {
        StringBuilder material = new StringBuilder();
        appendField(material, "project", request.projectId());
        appendField(material, "scene", request.sceneId());
        appendField(material, "projectRevision", request.expectedProjectRevisionId());
        appendField(material, "purpose", request.purpose());
        appendField(material, "seedInput", Long.toString(request.seedInput()));
        appendField(material, "prompt", request.prompt().authoredText());
        appendField(material, "templateId", request.template().templateId());
        appendField(material, "templateVersion", request.template().version());
        appendField(material, "continuityStateId", request.continuity().stateId());
        appendField(material, "continuityVersion", request.continuity().semanticVersion());
        request.continuity().facts().forEach(f -> appendFact(material, "priorContinuity", f));
        request.template().continuityFacts().forEach(f -> appendFact(material, "templateContinuity", f));
        sources.forEach(s -> {
            appendField(material, "sourceRole", s.role());
            appendField(material, "sourceArtifact", s.source().artifactId());
            appendField(material, "sourceVersion", s.source().artifactVersionId());
            appendField(material, "sourceSha256", s.sha256());
        });
        return sha256(material.toString());
    }

    private static void appendFact(StringBuilder material, String label, ContinuityFact fact) {
        appendField(material, label + "Key", fact.key());
        appendField(material, label + "Value", fact.value());
    }

    private static void appendField(StringBuilder material, String label, String value) {
        material.append(label.length()).append(':').append(label)
                .append(value.length()).append(':').append(value);
    }

    private static List<BoundSource> canonicalSources(List<BoundSource> values) {
        if (values == null) return List.of();
        return values.stream().map(v -> Objects.requireNonNull(v, "source" )).distinct()
                .sorted(Comparator.comparing((BoundSource s) -> s.source().artifactId())
                        .thenComparing(s -> s.source().artifactVersionId()).thenComparing(BoundSource::role)
                        .thenComparing(BoundSource::sha256)).toList();
    }

    private static List<ContinuityFact> canonicalFacts(List<ContinuityFact> values) {
        if (values == null) return List.of();
        var sorted = values.stream().map(v -> Objects.requireNonNull(v, "continuity fact"))
                .sorted(Comparator.comparing(ContinuityFact::key)).toList();
        if (sorted.stream().map(ContinuityFact::key).distinct().count() != sorted.size()) {
            throw new IllegalArgumentException("duplicate continuity fact key");
        }
        return sorted;
    }

    private static String digest(String value) {
        String normalized = required(value, "SHA-256").toLowerCase(java.util.Locale.ROOT);
        if (!normalized.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("SHA-256 must be 64 hexadecimal characters");
        return normalized;
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static String required(String value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        return value;
    }
}
