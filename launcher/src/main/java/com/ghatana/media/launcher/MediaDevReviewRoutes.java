package com.ghatana.media.launcher;

import com.ghatana.media.production.review.ReviewAssignmentStore.*;
import com.ghatana.media.production.review.ReviewContracts.*;
import com.sun.net.httpserver.HttpExchange;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.math.BigDecimal;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY hosted review routes (outside the canonical manifest/OpenAPI):
 * POST /dev/v1/reviews, GET /dev/v1/reviews/{id}, POST .../comments, POST .../decisions,
 * POST .../assignments, POST .../assignments/{assignmentId}/revoke.
 * Every response is labelled DEV_ONLY and states that a recorded decision is not a human or production approval.
 */
final class MediaDevReviewRoutes {
    static final String SCHEMA = "media.dev.versioned-review.v1";
    static final String APPROVAL_NOTE = "DEV_ONLY statement (synthetic owner or explicitly assigned DEV_ONLY reviewer); "
            + "not an issued human reviewer authority, not owner/production approval, and does not authorize "
            + "delivery or publication";
    private static final Pattern OPEN = Pattern.compile("^/dev/v1/reviews$");
    private static final Pattern CASE = Pattern.compile("^/dev/v1/reviews/([^/]+)$");
    private static final Pattern COMMENTS = Pattern.compile("^/dev/v1/reviews/([^/]+)/comments$");
    private static final Pattern DECISIONS = Pattern.compile("^/dev/v1/reviews/([^/]+)/decisions$");
    private static final Pattern ASSIGNMENTS = Pattern.compile("^/dev/v1/reviews/([^/]+)/assignments$");
    private static final Pattern REVOKE = Pattern.compile("^/dev/v1/reviews/([^/]+)/assignments/([^/]+)/revoke$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    /** Response writers owned by {@link MediaHttpHandler}, so envelopes and headers stay identical. */
    interface Responder {
        void json(HttpExchange exchange, int status, Object body) throws IOException;
        void error(HttpExchange exchange, int status, String code, String message, Map<String, ?> details)
                throws IOException;
    }

    private final MediaDevReviewRuntime reviews;

    MediaDevReviewRoutes(MediaDevReviewRuntime reviews) { this.reviews = reviews; }

    static boolean handles(String path) {
        return path.equals("/dev/v1/reviews") || path.startsWith("/dev/v1/reviews/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevReviewRuntime.ReviewAuthorityException failure) {
            out.error(exchange, 403, failure.code(), failure.getMessage(), Map.of("establishesApproval", false));
        } catch (MediaDevReviewRuntime.SelfAssignmentException failure) {
            out.error(exchange, 422, "REVIEW_SELF_ASSIGNMENT_REFUSED", failure.getMessage(), Map.of());
        } catch (ReviewAssignmentActiveException failure) {
            out.error(exchange, 409, "REVIEW_ASSIGNMENT_ALREADY_ACTIVE",
                    "The reviewer already holds an active assignment; revoke it first", Map.of());
        } catch (ReviewAssignmentRevokedException failure) {
            out.error(exchange, 409, "REVIEW_ASSIGNMENT_ALREADY_REVOKED", "The assignment is already revoked", Map.of());
        } catch (ReviewAssignmentNotFoundException failure) {
            out.error(exchange, 404, "REVIEW_ASSIGNMENT_NOT_FOUND", "Review assignment not found on this case", Map.of());
        } catch (ReviewDeniedException failure) {
            out.error(exchange, 403, "REVIEW_ACCESS_DENIED",
                    "Principal is not authorized for this review case or its exact subject", Map.of());
        } catch (MediaDevReviewRuntime.SubjectNotFoundException failure) {
            out.error(exchange, 404, "REVIEW_SUBJECT_NOT_FOUND",
                    "The exact subject version is not available to this DEV_ONLY owner", Map.of());
        } catch (StaleReviewException failure) {
            out.error(exchange, 409, "REVIEW_SUBJECT_STALE",
                    "The reviewed subject changed; decisions on this exact version are no longer accepted",
                    Map.of("establishesApproval", false));
        } catch (ReviewConflictException failure) {
            out.error(exchange, 409, "REVIEW_CASE_REVISION_CONFLICT",
                    "Review case changed; re-read it and retry with the current caseRevision", Map.of());
        } catch (ReviewIdempotencyConflictException failure) {
            out.error(exchange, 409, "REVIEW_REQUEST_ID_REUSED",
                    "requestId was already used with a different review payload", Map.of());
        } catch (ReviewAuthorityConflictException failure) {
            out.error(exchange, 409, "REVIEW_AUTHORITY_CHANGED", "Reviewer authority changed; retry", Map.of());
        } catch (ReviewRevisionExhaustedException failure) {
            out.error(exchange, 409, "REVIEW_REVISION_EXHAUSTED", "Review case cannot advance", Map.of());
        } catch (ReviewCaseMismatchException failure) {
            out.error(exchange, 404, "REVIEW_CASE_NOT_FOUND",
                    "Review case is not available in this tenant and owner scope", Map.of());
        } catch (ReviewUnavailableException failure) {
            out.error(exchange, 503, "REVIEW_UNAVAILABLE",
                    "Review evidence is unavailable; reconcile with the same requestId", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, Responder out) throws IOException {
        if (OPEN.matcher(path).matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("subject"), Set.of(), "review open request");
            Map<String, Object> subject = object(body.get("subject"), "subject");
            String kindName = string(subject.get("kind"), "subject.kind");
            SubjectKind kind;
            String objectId;
            String versionId;
            if ("PROJECT_REVISION".equals(kindName)) {
                requireKeys(subject, Set.of("kind", "projectId", "revisionId"), Set.of(), "subject");
                kind = SubjectKind.PROJECT_REVISION;
                objectId = string(subject.get("projectId"), "subject.projectId");
                versionId = string(subject.get("revisionId"), "subject.revisionId");
            } else if ("ARTIFACT_VERSION".equals(kindName)) {
                requireKeys(subject, Set.of("kind", "artifactId", "artifactVersionId"), Set.of(), "subject");
                kind = SubjectKind.ARTIFACT_VERSION;
                objectId = string(subject.get("artifactId"), "subject.artifactId");
                versionId = string(subject.get("artifactVersionId"), "subject.artifactVersionId");
                if (!artifactRead(exchange, out)) return;
            } else {
                throw new IllegalArgumentException("subject.kind must be PROJECT_REVISION or ARTIFACT_VERSION");
            }
            var opened = reviews.open(tenantId, principalId, kind, objectId, versionId);
            ReviewSnapshot snapshot = reviews.inspect(tenantId, principalId, opened.reviewCase());
            Map<String, Object> view = caseView(snapshot, reviews.assignments(opened.reviewCase()));
            view.put("created", opened.created());
            out.json(exchange, opened.created() ? 201 : 200, view);
            return;
        }
        Matcher assignments = ASSIGNMENTS.matcher(path);
        Matcher revoke = REVOKE.matcher(path);
        Matcher comments = COMMENTS.matcher(path);
        Matcher decisions = DECISIONS.matcher(path);
        Matcher single = CASE.matcher(path);
        String caseId;
        if (assignments.matches()) caseId = pathSegment(assignments.group(1));
        else if (revoke.matches()) caseId = pathSegment(revoke.group(1));
        else if (comments.matches()) caseId = pathSegment(comments.group(1));
        else if (decisions.matches()) caseId = pathSegment(decisions.group(1));
        else if (single.matches()) caseId = pathSegment(single.group(1));
        else { out.error(exchange, 404, "NOT_FOUND", "Review route not found", Map.of()); return; }

        String allow = single.matches() ? "GET" : "POST";
        if (!allow.equals(method)) { notAllowed(exchange, allow, out); return; }
        ReviewCaseRef reviewCase = reviews.find(tenantId, principalId, caseId).orElse(null);
        if (reviewCase == null) {
            out.error(exchange, 404, "REVIEW_CASE_NOT_FOUND",
                    "Review case is not available in this tenant and owner scope", Map.of());
            return;
        }
        if (reviewCase.reviewSubjectRef().kind() == SubjectKind.ARTIFACT_VERSION && !artifactRead(exchange, out)) return;

        if (single.matches()) {
            out.json(exchange, 200, caseView(reviews.inspect(tenantId, principalId, reviewCase),
                    reviews.assignments(reviewCase)));
            return;
        }
        Map<String, Object> body = body(exchange, maxBody);
        if (assignments.matches()) {
            requireKeys(body, Set.of("requestId", "expectedCaseRevision", "reviewerPrincipalId", "scopes", "expiresAt"),
                    Set.of(), "review assignment request");
            if (!(body.get("scopes") instanceof List<?> rawScopes)) {
                throw new IllegalArgumentException("scopes must be an array");
            }
            java.util.EnumSet<ReviewScope> scopes = java.util.EnumSet.noneOf(ReviewScope.class);
            for (Object raw : rawScopes) scopes.add(ReviewScope.valueOf(string(raw, "scopes[]")));
            Instant expires = parseInstant(string(body.get("expiresAt"), "expiresAt"));
            AssignmentChange change = reviews.assign(tenantId, principalId, reviewCase,
                    revision(body.get("expectedCaseRevision")), string(body.get("requestId"), "requestId"),
                    string(body.get("reviewerPrincipalId"), "reviewerPrincipalId"), scopes, expires);
            out.json(exchange, change.replayed() ? 200 : 201, assignmentChangeView(reviewCase, change));
            return;
        }
        if (revoke.matches()) {
            requireKeys(body, Set.of("requestId", "expectedCaseRevision"), Set.of(), "review assignment revoke request");
            AssignmentChange change = reviews.revoke(tenantId, principalId, reviewCase, pathSegment(revoke.group(2)),
                    revision(body.get("expectedCaseRevision")), string(body.get("requestId"), "requestId"));
            out.json(exchange, 200, assignmentChangeView(reviewCase, change));
            return;
        }
        if (comments.matches()) {
            requireKeys(body, Set.of("requestId", "expectedCaseRevision", "text", "disposition"),
                    Set.of("annotation"), "review comment request");
            Comment comment = new Comment(string(body.get("text"), "text"),
                    CommentDisposition.valueOf(string(body.get("disposition"), "disposition")),
                    annotation(body.get("annotation")));
            var outcome = reviews.comment(tenantId, principalId, reviewCase,
                    revision(body.get("expectedCaseRevision")), string(body.get("requestId"), "requestId"), comment);
            out.json(exchange, outcome.replayed() ? 200 : 201, appendView(outcome));
            return;
        }
        requireKeys(body, Set.of("requestId", "expectedCaseRevision", "decision", "reason", "confirmed", "scope"),
                Set.of(), "review decision request");
        if (!(body.get("confirmed") instanceof Boolean confirmed) || !confirmed) {
            out.error(exchange, 422, "REVIEW_CONFIRMATION_REQUIRED",
                    "A decision requires confirmed=true for this exact subject", Map.of());
            return;
        }
        DecisionRecord decision = new DecisionRecord(Decision.valueOf(string(body.get("decision"), "decision")),
                string(body.get("reason"), "reason"));
        var verified = MediaSecurityFilter.verifiedIdentity(exchange);
        var outcome = reviews.decide(tenantId, principalId, reviewCase, revision(body.get("expectedCaseRevision")),
                string(body.get("requestId"), "requestId"), decision,
                ReviewScope.valueOf(string(body.get("scope"), "scope")), true,
                verified == null ? com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource.UNSPECIFIED
                        : verified.assurance());
        out.json(exchange, outcome.replayed() ? 200 : 201, appendView(outcome));
    }

    private static boolean artifactRead(HttpExchange exchange, Responder out) throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) return true;
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read permission is required to review an artifact version", Map.of());
        return false;
    }

    private static void notAllowed(HttpExchange exchange, String allow, Responder out) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
    }

    // ---- views ----

    private static Map<String, Object> caseView(ReviewSnapshot snapshot, List<ReviewAssignment> assignments) {
        ReviewCaseRef reviewCase = snapshot.reviewCase();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", SCHEMA);
        view.put("reviewCaseId", reviewCase.reviewCaseId());
        view.put("subject", subject(reviewCase.reviewSubjectRef()));
        view.put("currentness", snapshot.currentness().name());
        view.put("caseRevision", snapshot.caseRevision());
        List<Map<String, Object>> records = new ArrayList<>();
        RecordObservation latestDecision = null;
        for (RecordObservation observation : snapshot.records()) {
            records.add(recordView(observation));
            if (observation.record().payload() instanceof DecisionRecord) latestDecision = observation;
        }
        view.put("records", records);
        Map<String, Object> state = new LinkedHashMap<>();
        if (latestDecision == null) {
            state.put("latestDecision", null);
            state.put("status", "NO_DECISION");
        } else {
            DecisionRecord decision = (DecisionRecord) latestDecision.record().payload();
            state.put("latestDecision", Map.of("decision", decision.decision().name(),
                    "appendRecordId", latestDecision.record().appendRecordId(),
                    "caseRevision", latestDecision.record().caseRevision(),
                    "currentness", latestDecision.currentness().name()));
            String family = MediaDevReviewRuntime.isIdpVerifiedAuthority(latestDecision.record().authorityVersion())
                    ? "IDP_VERIFIED_REVIEWER_"
                    : MediaDevReviewRuntime.isAssignedAuthority(latestDecision.record().authorityVersion())
                    ? "DEV_ASSIGNED_REVIEWER_" : "DEV_ONLY_";
            state.put("identityAssurance", MediaDevReviewRuntime.isIdpVerifiedAuthority(
                    latestDecision.record().authorityVersion()) ? "OIDC_VERIFIED" : "NOT_IDP_VERIFIED");
            state.put("status", family + decision.decision().name()
                    + (latestDecision.currentness() == Currentness.CURRENT ? "_CURRENT" : "_STALE"));
        }
        state.put("establishesApproval", false);
        state.put("humanReviewApproval", false);
        view.put("reviewState", state);
        view.put("authority", "DEV_ONLY owner-assigned reviewer; the DEV_ONLY signed identity is not a trusted human "
                + "identity, so no decision is an issued human reviewer authority or approval");
        List<Map<String, Object>> assigned = new ArrayList<>();
        for (ReviewAssignment assignment : assignments) assigned.add(assignmentView(assignment, snapshot.observedAt()));
        view.put("assignments", assigned);
        view.put("note", APPROVAL_NOTE);
        view.put("observedAt", snapshot.observedAt().toString());
        view.put("scope", "DEV_ONLY");
        return view;
    }

    private static Map<String, Object> recordView(RecordObservation observation) {
        ReviewRecord record = observation.record();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("appendRecordId", record.appendRecordId());
        view.put("caseRevision", record.caseRevision());
        view.put("requestId", record.requestId());
        view.put("principalId", record.actor().principalId());
        view.put("createdAt", record.createdAt().toString());
        view.put("currentness", observation.currentness().name());
        if (record.payload() instanceof Comment comment) {
            view.put("kind", "COMMENT");
            view.put("text", comment.text());
            view.put("disposition", comment.disposition().name());
            view.put("annotation", comment.annotation() == null ? null : annotationView(comment.annotation()));
        } else if (record.payload() instanceof DecisionRecord decision) {
            view.put("kind", "DECISION");
            view.put("authorityVersion", record.authorityVersion());
            boolean assignedReviewer = MediaDevReviewRuntime.isAssignedAuthority(record.authorityVersion());
            boolean idpVerified = MediaDevReviewRuntime.isIdpVerifiedAuthority(record.authorityVersion());
            view.put("recordedAs", (idpVerified ? "IDP_VERIFIED_REVIEWER_"
                    : assignedReviewer ? "DEV_ASSIGNED_REVIEWER_" : "DEV_ONLY_") + decision.decision().name());
            view.put("identityAssurance", idpVerified ? "OIDC_VERIFIED" : "NOT_IDP_VERIFIED");
            view.put("identityBackedHumanDecision", idpVerified);
            if (idpVerified) {
                view.put("identityNote", "The configured identity provider verified who this reviewer is; the "
                        + "decision is still not an approval and authorizes no delivery or publication");
            }
            if (assignedReviewer) {
                String[] parts = record.authorityVersion().split(":");
                view.put("scope", parts[parts.length - 1]);
            }
            view.put("decision", decision.decision().name());
            view.put("reason", decision.reason());
        }
        return view;
    }

    private static Map<String, Object> appendView(MediaDevReviewRuntime.AppendOutcome outcome) {
        AppendReceipt receipt = outcome.receipt();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", SCHEMA);
        view.put("requestId", receipt.requestId());
        view.put("reviewCaseId", receipt.reviewCaseId());
        view.put("subject", subject(receipt.reviewSubjectRef()));
        view.put("appendRecordId", receipt.appendRecordId());
        view.put("caseRevision", receipt.caseRevision());
        view.put("currentness", receipt.currentness().name());
        view.put("establishesApproval", receipt.establishesApproval());
        view.put("replayed", outcome.replayed());
        view.put("observedAt", receipt.observedAt().toString());
        view.put("note", APPROVAL_NOTE);
        view.put("scope", "DEV_ONLY");
        return view;
    }

    private static Map<String, Object> assignmentView(ReviewAssignment assignment, Instant now) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("assignmentId", assignment.assignmentId());
        view.put("reviewerPrincipalId", assignment.reviewerPrincipalId());
        view.put("assignedByPrincipalId", assignment.assignedByPrincipalId());
        view.put("scopes", assignment.scopes().stream().map(Enum::name).sorted().toList());
        view.put("expiresAt", assignment.expiresAt().toString());
        view.put("status", assignment.status() == AssignmentStatus.REVOKED ? "REVOKED"
                : assignment.expiresAt().isAfter(now) ? "ACTIVE" : "EXPIRED");
        view.put("assignmentVersion", assignment.assignmentVersion());
        view.put("createdAt", assignment.createdAt().toString());
        view.put("changedAt", assignment.changedAt().toString());
        return view;
    }

    private static Map<String, Object> assignmentChangeView(ReviewCaseRef reviewCase, AssignmentChange change) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", SCHEMA);
        view.put("reviewCaseId", reviewCase.reviewCaseId());
        view.put("assignment", assignmentView(change.assignment(), change.assignment().changedAt()));
        view.put("replayed", change.replayed());
        view.put("establishesApproval", false);
        view.put("humanReviewApproval", false);
        view.put("note", APPROVAL_NOTE);
        view.put("scope", "DEV_ONLY");
        return view;
    }

    private static Instant parseInstant(String text) {
        try { return Instant.parse(text); }
        catch (java.time.format.DateTimeParseException invalid) {
            throw new IllegalArgumentException("expiresAt must be an ISO-8601 UTC instant");
        }
    }

    private static Map<String, Object> subject(ExactVersionRef ref) {
        Map<String, Object> subject = new LinkedHashMap<>();
        subject.put("kind", ref.kind().name());
        if (ref.kind() == SubjectKind.PROJECT_REVISION) {
            subject.put("projectId", ref.objectId());
            subject.put("revisionId", ref.versionId());
        } else {
            subject.put("artifactId", ref.objectId());
            subject.put("artifactVersionId", ref.versionId());
        }
        subject.put("reference", ref.reference());
        return subject;
    }

    private static Map<String, Object> annotationView(Annotation annotation) {
        Map<String, Object> view = new LinkedHashMap<>();
        if (annotation.timeRange() != null) {
            view.put("timeRange", Map.of("start", timeView(annotation.timeRange().start()),
                    "end", timeView(annotation.timeRange().end())));
        }
        if (annotation.roi() != null) {
            NormalizedRoi roi = annotation.roi();
            view.put("roi", Map.of("x", roi.x(), "y", roi.y(), "width", roi.width(), "height", roi.height()));
        }
        return view;
    }

    private static Map<String, Object> timeView(RationalTime time) {
        return Map.of("ticks", time.ticks(), "rateNumerator", time.rateNumerator(),
                "rateDenominator", time.rateDenominator(), "clock", time.clock().name());
    }

    // ---- request parsing ----

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                new TypeReference<Map<String, Object>>() { });
        if (body == null) throw new IllegalArgumentException("request body is required");
        return body;
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional,
                                    String field) {
        if (!value.keySet().containsAll(required)
                || !java.util.stream.Stream.concat(required.stream(), optional.stream())
                        .collect(java.util.stream.Collectors.toSet()).containsAll(value.keySet())) {
            throw new IllegalArgumentException(field + " fields do not match its declared shape");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String field) {
        if (!(value instanceof Map<?, ?> map)) throw new IllegalArgumentException(field + " must be an object");
        return (Map<String, Object>) map;
    }

    private static String string(Object value, String field) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static long revision(Object value) {
        long number = integer(value, "expectedCaseRevision");
        if (number < 0) throw new IllegalArgumentException("expectedCaseRevision must be non-negative");
        return number;
    }

    private static long integer(Object value, String field) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        return ((Number) value).longValue();
    }

    private static Annotation annotation(Object raw) {
        if (raw == null) return null;
        Map<String, Object> value = object(raw, "annotation");
        requireKeys(value, Set.of(), Set.of("timeRange", "roi"), "annotation");
        TimeRange range = null;
        if (value.containsKey("timeRange")) {
            Map<String, Object> time = object(value.get("timeRange"), "annotation.timeRange");
            requireKeys(time, Set.of("start", "end"), Set.of(), "annotation.timeRange");
            range = new TimeRange(rational(time.get("start")), rational(time.get("end")));
        }
        NormalizedRoi roi = null;
        if (value.containsKey("roi")) {
            Map<String, Object> box = object(value.get("roi"), "annotation.roi");
            requireKeys(box, Set.of("x", "y", "width", "height"), Set.of(), "annotation.roi");
            roi = new NormalizedRoi(decimal(box.get("x")), decimal(box.get("y")),
                    decimal(box.get("width")), decimal(box.get("height")));
        }
        return new Annotation(range, roi);
    }

    private static RationalTime rational(Object raw) {
        Map<String, Object> value = object(raw, "time");
        requireKeys(value, Set.of("ticks", "rateNumerator", "rateDenominator", "clock"), Set.of(), "time");
        return new RationalTime(integer(value.get("ticks"), "ticks"), integer(value.get("rateNumerator"), "rateNumerator"),
                integer(value.get("rateDenominator"), "rateDenominator"),
                ClockDomain.valueOf(string(value.get("clock"), "clock")));
    }

    private static double decimal(Object value) {
        if (!(value instanceof Number number)) throw new IllegalArgumentException("roi values must be numbers");
        return new BigDecimal(number.toString()).doubleValue();
    }

    private static String pathSegment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Path identifier must not contain a separator");
        }
        return decoded;
    }
}
