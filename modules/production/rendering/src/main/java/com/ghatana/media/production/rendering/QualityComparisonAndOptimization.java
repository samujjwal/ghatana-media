package com.ghatana.media.production.rendering;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalDouble;

/**
 * Deterministic RGB8 quality comparison and reversible optimization orchestration.
 * It compares only exact immutable revisions and never decodes, encodes, or muxes media.
 */
public final class QualityComparisonAndOptimization {
    public static final int MAX_FRAME_DIMENSION = 2_048;
    public static final int MAX_FRAMES = 64;
    public static final long MAX_PIXELS = 16_000_000L;
    public static final long MAX_BYTES = 64L * 1024 * 1024;
    public static final int MAX_ATTEMPTS = 8;
    private static final String SHA256 = "^[a-f0-9]{64}$";
    private static final String PSNR_ID = "RGB8_SAMPLE_PSNR_V1";
    private static final String SSIM_ID = "GLOBAL_SRGB_LUMA_SSIM_V1";
    private static final double SSIM_C1 = 6.5025;
    private static final double SSIM_C2 = 58.5225;

    private QualityComparisonAndOptimization() {}

    public enum AuthorityStatus { ALLOWED, DENIED, UNAVAILABLE }
    public enum RunStatus { COMPLETED, NOT_ADMITTED, UNAVAILABLE }
    public enum MetricStatus { MEASURED, EXACT_MATCH, UNAVAILABLE }
    public enum OptimizationStatus { COMPLETED, NOT_ADMITTED, UNAVAILABLE }
    public enum QualityDisposition { IMPROVED, NOT_IMPROVED, UNAVAILABLE }
    public enum UnavailableReason { NO_REFERENCE, REFERENCE_DENIED, REFERENCE_AUTHORITY_UNAVAILABLE,
        REFERENCE_UNAVAILABLE, REFERENCE_NOT_ALIGNED }
    public enum BlockReason { SOURCE_DENIED, SOURCE_AUTHORITY_UNAVAILABLE, SOURCE_REVOKED,
        CANDIDATE_PORT_UNAVAILABLE, CANDIDATE_PORT_UNSUPPORTED, CANDIDATE_UNAVAILABLE,
        REFERENCE_AUTHORITY_UNAVAILABLE, SOURCE_UNAVAILABLE }

    /** Identity for a complete immutable media revision. Digests identify original media bytes. */
    public record RevisionId(String tenantId, String principalId, String artifactId, String versionId,
            String sha256) {
        public RevisionId {
            tenantId = text(tenantId, "tenantId", 255);
            principalId = text(principalId, "principalId", 255);
            artifactId = text(artifactId, "artifactId", 128);
            versionId = text(versionId, "versionId", 128);
            sha256 = digest(sha256, "revision sha256");
        }
    }

    /** Explicit operation caps. Values above module hard limits are rejected, not silently clamped. */
    public record Budget(long maxPixels, long maxBytes, int maxAttempts) {
        public Budget {
            if (maxPixels < 1 || maxPixels > MAX_PIXELS) throw invalid("maxPixels exceeds the supported bound");
            if (maxBytes < 3 || maxBytes > MAX_BYTES) throw invalid("maxBytes exceeds the supported bound");
            if (maxAttempts < 0 || maxAttempts > MAX_ATTEMPTS) throw invalid("maxAttempts exceeds the supported bound");
        }
        public static Budget standard() { return new Budget(MAX_PIXELS, MAX_BYTES, MAX_ATTEMPTS); }
    }

    /** Immutable exact decoded RGB8 frame; digest covers these decoded pixels, not encoded media. */
    public record RgbFrame(int index, int width, int height, long presentationTicks, byte[] rgb) {
        public RgbFrame {
            if (index < 0 || index >= MAX_FRAMES) throw invalid("frame index exceeds the bound");
            if (width < 1 || width > MAX_FRAME_DIMENSION || height < 1 || height > MAX_FRAME_DIMENSION) {
                throw invalid("frame dimensions exceed the bound");
            }
            if (presentationTicks < 0) throw invalid("presentation ticks must be non-negative");
            Objects.requireNonNull(rgb, "rgb");
            long expected = (long) width * height * 3;
            if (expected != rgb.length || expected > MAX_BYTES) throw invalid("RGB8 frame length is invalid");
            rgb = rgb.clone();
        }
        @Override public byte[] rgb() { return rgb.clone(); }
    }

    public record TimeBase(int numerator, int denominator) {
        public TimeBase {
            if (numerator < 1 || numerator > 1_000_000 || denominator < 1 || denominator > 1_000_000) {
                throw invalid("time base must be a bounded positive rational");
            }
        }
    }

    /** Exact source/candidate/reference revision plus the pixels returned by the host decode boundary. */
    public record Revision(RevisionId id, TimeBase timeBase, List<RgbFrame> frames) {
        public Revision {
            Objects.requireNonNull(id, "id");
            Objects.requireNonNull(timeBase, "timeBase");
            Objects.requireNonNull(frames, "frames");
            // Enforce the count before copying so an oversized caller-owned list cannot
            // force an unbounded defensive allocation before the revision is rejected.
            int frameCount = frames.size();
            if (frameCount < 1 || frameCount > MAX_FRAMES) throw invalid("revision frame count is outside bounds");
            frames = copyFramesBounded(frames);
            if (frames.isEmpty()) throw invalid("revision frame count is outside bounds");
            RgbFrame first = Objects.requireNonNull(frames.getFirst(), "frames[0]");
            long pixels = 0;
            long bytes = 0;
            long priorTicks = -1;
            for (int i = 0; i < frames.size(); i++) {
                RgbFrame frame = Objects.requireNonNull(frames.get(i), "frame");
                if (frame.index() != i || frame.width() != first.width() || frame.height() != first.height()) {
                    throw invalid("frames must be ordered with consistent dimensions");
                }
                if (frame.presentationTicks() <= priorTicks) throw invalid("frame timestamps must strictly increase");
                priorTicks = frame.presentationTicks();
                pixels = Math.addExact(pixels, (long) frame.width() * frame.height());
                // Read the record's private immutable snapshot directly. Calling the
                // public accessor here would clone the entire payload just to read its length.
                bytes = Math.addExact(bytes, frame.rgb.length);
            }
            if (pixels > MAX_PIXELS || bytes > MAX_BYTES) throw invalid("revision exceeds pixel or byte bound");
        }
    }

    public record AuthorityDecision(AuthorityStatus status, String decisionId) {
        public AuthorityDecision {
            Objects.requireNonNull(status, "status");
            decisionId = decisionId == null ? "" : decisionId.trim();
            if (status == AuthorityStatus.ALLOWED && decisionId.isBlank()) throw invalid("allowed authority needs decision id");
        }
    }

    @FunctionalInterface public interface RightsAuthority { AuthorityDecision check(RevisionId revision, String purpose); }

    /** Reference is read only after rights admission; returned reference must be the exact requested revision. */
    @FunctionalInterface public interface ReferenceReader { Revision readExact(RevisionId reference); }

    /** A null port means unavailable; unsupported operations are represented explicitly by the port. */
    public interface CandidatePort {
        boolean supports(String operationId);
        OptimizationAttempt optimize(String operationId, Revision source, int attempt, Budget budget);
    }

    public record OptimizationAttempt(boolean available, Revision candidate) {
        public OptimizationAttempt {
            if (available != (candidate != null)) throw invalid("available attempt must return one candidate");
        }
        public static OptimizationAttempt available(Revision candidate) { return new OptimizationAttempt(true, candidate); }
        public static OptimizationAttempt unavailable() { return new OptimizationAttempt(false, null); }
    }

    public record ReferenceRequest(RevisionId revision, String purpose) {
        public ReferenceRequest { Objects.requireNonNull(revision, "revision"); purpose = text(purpose, "purpose", 256); }
    }

    public record Metric(String algorithm, MetricStatus status, OptionalDouble value) {
        public Metric {
            algorithm = text(algorithm, "metric algorithm", 64);
            Objects.requireNonNull(status, "status");
            Objects.requireNonNull(value, "value");
            if (status == MetricStatus.MEASURED && (value.isEmpty() || !Double.isFinite(value.getAsDouble()))) {
                throw invalid("measured metric must be finite");
            }
            if (status != MetricStatus.MEASURED && value.isPresent()) throw invalid("non-measured metric cannot have a value");
        }
    }

    /** Explicit heuristics; these are descriptive only and never establish quality or improvement. */
    public record Heuristics(double meanAbsoluteSourceDelta, double candidateSpatialActivity) {
        public Heuristics {
            if (!Double.isFinite(meanAbsoluteSourceDelta) || meanAbsoluteSourceDelta < 0 || meanAbsoluteSourceDelta > 255
                    || !Double.isFinite(candidateSpatialActivity) || candidateSpatialActivity < 0 || candidateSpatialActivity > 255) {
                throw invalid("heuristic metric is outside bounds");
            }
        }
    }

    public record CandidateComparison(RevisionId candidate, Metric psnr, Metric ssim,
            Heuristics heuristics, QualityDisposition disposition) {
        public CandidateComparison {
            Objects.requireNonNull(candidate, "candidate"); Objects.requireNonNull(psnr, "psnr");
            Objects.requireNonNull(ssim, "ssim"); Objects.requireNonNull(heuristics, "heuristics");
            Objects.requireNonNull(disposition, "disposition");
        }
    }

    /** Stable report with no wall-clock fields; report digest covers every identity, metric and disposition. */
    public record Report(RunStatus status, Optional<BlockReason> blockReason, String operationId, Budget budget,
            int attemptsUsed, RevisionId source,
            String sourceRightsDecisionId, List<RevisionId> retainedRevisions,
            Optional<RevisionId> reference, String referenceRightsDecisionId,
            Optional<UnavailableReason> referenceUnavailableReason, List<CandidateComparison> comparisons,
            String reportSha256) {
        public Report {
            Objects.requireNonNull(status, "status"); Objects.requireNonNull(blockReason, "blockReason");
            operationId = text(operationId, "operationId", 128);
            Objects.requireNonNull(budget, "budget");
            if (attemptsUsed < 1 || attemptsUsed > budget.maxAttempts()) throw invalid("report attempts exceed budget");
            Objects.requireNonNull(source, "source");
            sourceRightsDecisionId = sourceRightsDecisionId == null ? "" : sourceRightsDecisionId;
            retainedRevisions = List.copyOf(Objects.requireNonNull(retainedRevisions, "retainedRevisions"));
            Objects.requireNonNull(reference, "reference");
            referenceRightsDecisionId = referenceRightsDecisionId == null ? "" : referenceRightsDecisionId;
            Objects.requireNonNull(referenceUnavailableReason, "referenceUnavailableReason");
            comparisons = List.copyOf(Objects.requireNonNull(comparisons, "comparisons"));
            reportSha256 = digest(reportSha256, "report sha256");
        }
    }

    public record Run(RunStatus status, Optional<BlockReason> reason, Optional<Report> report,
            List<Revision> retainedRevisions, int attemptsUsed) {
        public Run {
            Objects.requireNonNull(status, "status"); Objects.requireNonNull(reason, "reason");
            Objects.requireNonNull(report, "report"); retainedRevisions = List.copyOf(retainedRevisions);
            if (attemptsUsed < 0 || attemptsUsed > MAX_ATTEMPTS) throw invalid("attempt count is outside bounds");
        }
        static Run blocked(RunStatus status, BlockReason reason) {
            return new Run(status, Optional.of(reason), Optional.empty(), List.of(), 0);
        }
        static Run blockedAttempts(RunStatus status, BlockReason reason, int attemptsUsed) {
            return new Run(status, Optional.of(reason), Optional.empty(), List.of(), attemptsUsed);
        }
        static Run blockedKeeping(RunStatus status, BlockReason reason, List<Revision> retained, int attemptsUsed) {
            return new Run(status, Optional.of(reason), Optional.empty(), retained, attemptsUsed);
        }
    }

    /**
     * Runs up to requestedAttempts and retains source plus every returned candidate in exact attempt order.
     * Reference metrics are present only for an authorized, exact, frame/timestamp-aligned reference.
     */
    public static Run optimize(String operationId, Revision source, RightsAuthority sourceRights,
            CandidatePort candidatePort, int requestedAttempts, Budget budget,
            Optional<ReferenceRequest> referenceRequest, RightsAuthority referenceRights, ReferenceReader referenceReader) {
        operationId = text(operationId, "operationId", 128);
        Objects.requireNonNull(source, "source"); Objects.requireNonNull(budget, "budget");
        Objects.requireNonNull(referenceRequest, "referenceRequest");
        validateBudget(source, budget);
        if (sourceRights == null) return Run.blocked(RunStatus.UNAVAILABLE, BlockReason.SOURCE_AUTHORITY_UNAVAILABLE);
        AuthorityDecision sourceDecision = checkRights(sourceRights, source.id(), operationId);
        if (sourceDecision == null || sourceDecision.status() != AuthorityStatus.ALLOWED) {
            return Run.blocked(sourceDecision != null && sourceDecision.status() == AuthorityStatus.DENIED
                    ? RunStatus.NOT_ADMITTED : RunStatus.UNAVAILABLE,
                    sourceDecision != null && sourceDecision.status() == AuthorityStatus.DENIED
                            ? BlockReason.SOURCE_DENIED : BlockReason.SOURCE_AUTHORITY_UNAVAILABLE);
        }
        if (candidatePort == null) return Run.blocked(RunStatus.UNAVAILABLE, BlockReason.CANDIDATE_PORT_UNAVAILABLE);
        if (!candidatePort.supports(operationId)) return Run.blocked(RunStatus.NOT_ADMITTED, BlockReason.CANDIDATE_PORT_UNSUPPORTED);
        if (requestedAttempts < 1 || requestedAttempts > budget.maxAttempts()) throw invalid("requested attempts exceed explicit attempt budget");

        ArrayList<Revision> retained = new ArrayList<>();
        retained.add(source);
        long pixels = pixelCount(source);
        long bytes = byteCount(source);
        ArrayList<Revision> candidates = new ArrayList<>();
        int attemptsMade = 0;
        for (int attempt = 1; attempt <= requestedAttempts; attempt++) {
            AuthorityDecision dispatchDecision = checkRights(sourceRights, source.id(), operationId);
            if (!sameAllowedDecision(sourceDecision, dispatchDecision)) {
                return Run.blockedAttempts(RunStatus.NOT_ADMITTED, BlockReason.SOURCE_REVOKED, attemptsMade);
            }
            OptimizationAttempt result;
            attemptsMade++;
            try { result = candidatePort.optimize(operationId, source, attempt, budget); }
            catch (RuntimeException unavailable) {
                return Run.blockedKeeping(RunStatus.UNAVAILABLE, BlockReason.CANDIDATE_UNAVAILABLE, retained, attemptsMade);
            }
            if (result == null || !result.available()) {
                return Run.blockedKeeping(RunStatus.UNAVAILABLE, BlockReason.CANDIDATE_UNAVAILABLE, retained, attemptsMade);
            }
            Revision candidate = result.candidate();
            if (!sameTenant(source.id(), candidate.id())) throw invalid("candidate tenant/principal must match exact source owner");
            if (!aligned(source, candidate)) throw invalid("candidate must preserve source frame alignment");
            validateBudget(candidate, budget);
            pixels = Math.addExact(pixels, pixelCount(candidate));
            bytes = Math.addExact(bytes, byteCount(candidate));
            if (pixels > budget.maxPixels() || bytes > budget.maxBytes()) throw invalid("attempts exceed aggregate pixel/byte budget");
            retained.add(candidate);
            candidates.add(candidate);
        }
        AuthorityDecision finalSourceDecision = checkRights(sourceRights, source.id(), operationId);
        if (!sameAllowedDecision(sourceDecision, finalSourceDecision)) {
            return Run.blockedAttempts(finalSourceDecision != null && finalSourceDecision.status() == AuthorityStatus.DENIED
                    ? RunStatus.NOT_ADMITTED : RunStatus.UNAVAILABLE, BlockReason.SOURCE_REVOKED, attemptsMade);
        }

        ReferenceLoad reference = loadReference(referenceRequest, referenceRights, referenceReader, source, budget,
                pixels, bytes);
        ArrayList<CandidateComparison> comparisons = new ArrayList<>();
        for (Revision candidate : candidates) {
            comparisons.add(compare(source, candidate, reference.revision()));
        }
        if (reference.decision() != null && referenceRequest.isPresent()) {
            AuthorityDecision fresh = checkRights(referenceRights, referenceRequest.get().revision(), referenceRequest.get().purpose());
            if (!sameAllowedDecision(reference.decision(), fresh)) {
                reference = ReferenceLoad.unavailable(fresh != null && fresh.status() == AuthorityStatus.DENIED
                        ? UnavailableReason.REFERENCE_DENIED : UnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
                comparisons.clear();
                for (Revision candidate : candidates) comparisons.add(compare(source, candidate, null));
            }
        }
        finalSourceDecision = checkRights(sourceRights, source.id(), operationId);
        if (!sameAllowedDecision(sourceDecision, finalSourceDecision)) {
            return Run.blockedAttempts(finalSourceDecision != null && finalSourceDecision.status() == AuthorityStatus.DENIED
                    ? RunStatus.NOT_ADMITTED : RunStatus.UNAVAILABLE, BlockReason.SOURCE_REVOKED, attemptsMade);
        }
        Report report = report(operationId, budget, attemptsMade, source, sourceDecision.decisionId(),
                retained, reference, comparisons);
        return new Run(RunStatus.COMPLETED, Optional.empty(), Optional.of(report), retained, attemptsMade);
    }

    /** Undo selects and returns the byte-identical immutable source revision retained by a completed run. */
    public static Revision undo(Run run, RevisionId exactSourceRevision) {
        Objects.requireNonNull(run, "run"); Objects.requireNonNull(exactSourceRevision, "exactSourceRevision");
        if (run.status() != RunStatus.COMPLETED || run.report().isEmpty()) throw invalid("cannot undo an incomplete optimization run");
        if (!run.report().orElseThrow().source().equals(exactSourceRevision)) {
            throw invalid("undo must select the exact source revision from this run");
        }
        return run.retainedRevisions().stream().filter(revision -> revision.id().equals(exactSourceRevision))
                .findFirst().orElseThrow(() -> invalid("exact source revision is not retained by this run"));
    }

    private record ReferenceLoad(Revision revision, AuthorityDecision decision, Optional<UnavailableReason> unavailable) {
        static ReferenceLoad unavailable(UnavailableReason reason) { return new ReferenceLoad(null, null, Optional.of(reason)); }
        static ReferenceLoad unavailable(UnavailableReason reason, AuthorityDecision decision) {
            return new ReferenceLoad(null, decision, Optional.of(reason));
        }
    }

    private static ReferenceLoad loadReference(Optional<ReferenceRequest> request, RightsAuthority authority,
            ReferenceReader reader, Revision source, Budget budget, long pixels, long bytes) {
        if (request.isEmpty()) return ReferenceLoad.unavailable(UnavailableReason.NO_REFERENCE);
        ReferenceRequest ref = request.get();
        if (authority == null) return ReferenceLoad.unavailable(UnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
        AuthorityDecision decision = checkRights(authority, ref.revision(), ref.purpose());
        if (decision == null || decision.status() != AuthorityStatus.ALLOWED) {
            return ReferenceLoad.unavailable(decision != null && decision.status() == AuthorityStatus.DENIED
                    ? UnavailableReason.REFERENCE_DENIED : UnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
        }
        if (reader == null) return ReferenceLoad.unavailable(UnavailableReason.REFERENCE_UNAVAILABLE, decision);
        final Revision reference;
        try { reference = reader.readExact(ref.revision()); }
        catch (RuntimeException unavailable) {
            return ReferenceLoad.unavailable(UnavailableReason.REFERENCE_UNAVAILABLE, decision);
        }
        if (reference == null || !reference.id().equals(ref.revision()) || !sameTenant(source.id(), reference.id())) {
            return ReferenceLoad.unavailable(UnavailableReason.REFERENCE_UNAVAILABLE, decision);
        }
        validateBudget(reference, budget);
        if (pixels + pixelCount(reference) > budget.maxPixels() || bytes + byteCount(reference) > budget.maxBytes()) {
            throw invalid("reference exceeds aggregate pixel/byte budget");
        }
        if (!aligned(source, reference)) return ReferenceLoad.unavailable(UnavailableReason.REFERENCE_NOT_ALIGNED, decision);
        return new ReferenceLoad(reference, decision, Optional.empty());
    }

    private static CandidateComparison compare(Revision source, Revision candidate, Revision reference) {
        Heuristics heuristics = new Heuristics(meanAbsDelta(source, candidate), spatialActivity(candidate));
        if (reference == null) return new CandidateComparison(candidate.id(), unavailable(PSNR_ID), unavailable(SSIM_ID), heuristics,
                QualityDisposition.UNAVAILABLE);
        Metric candidatePsnr = psnr(candidate, reference);
        Metric candidateSsim = ssim(candidate, reference);
        Metric sourcePsnr = psnr(source, reference);
        Metric sourceSsim = ssim(source, reference);
        boolean improved = psnrBetter(candidatePsnr, sourcePsnr)
                && candidateSsim.value().orElse(Double.NEGATIVE_INFINITY) > sourceSsim.value().orElse(Double.POSITIVE_INFINITY);
        return new CandidateComparison(candidate.id(), candidatePsnr, candidateSsim, heuristics,
                improved ? QualityDisposition.IMPROVED : QualityDisposition.NOT_IMPROVED);
    }

    private static Report report(String operationId, Budget budget, int attemptsUsed, Revision source,
            String sourceDecision, List<Revision> retained,
            ReferenceLoad reference, List<CandidateComparison> comparisons) {
        Optional<RevisionId> refId = reference.revision() == null ? Optional.empty() : Optional.of(reference.revision().id());
        String refDecision = reference.revision() == null || reference.decision() == null
                ? "" : reference.decision().decisionId();
        String canonical = canonicalReport(operationId, budget, attemptsUsed, source.id(), sourceDecision,
                retained.stream().map(Revision::id).toList(), refId, refDecision, reference.unavailable(), comparisons);
        return new Report(RunStatus.COMPLETED, Optional.empty(), operationId, budget, attemptsUsed,
                source.id(), sourceDecision,
                retained.stream().map(Revision::id).toList(), refId, refDecision, reference.unavailable(), comparisons,
                sha256(canonical.getBytes(StandardCharsets.UTF_8)));
    }

    private static String canonicalReport(String operationId, Budget budget, int attemptsUsed, RevisionId source,
            String sourceDecision, List<RevisionId> retained,
            Optional<RevisionId> reference, String refDecision, Optional<UnavailableReason> unavailable,
            List<CandidateComparison> comparisons) {
        StringBuilder out = new StringBuilder("quality-comparison-v1\n");
        out.append("operation=").append(operationId).append('\n')
                .append("budget=").append(budget.maxPixels()).append(',').append(budget.maxBytes()).append(',')
                .append(budget.maxAttempts()).append('\n').append("attemptsUsed=").append(attemptsUsed).append('\n');
        appendRevision(out, source); out.append("sourceDecision=").append(sourceDecision).append('\n');
        retained.forEach(id -> { out.append("retained="); appendRevision(out, id); });
        reference.ifPresent(id -> { out.append("reference="); appendRevision(out, id); });
        out.append("referenceDecision=").append(refDecision).append('\n');
        out.append("referenceUnavailable=").append(unavailable.map(Enum::name).orElse("")).append('\n');
        for (CandidateComparison item : comparisons) {
            out.append("candidate="); appendRevision(out, item.candidate());
            appendMetric(out, "psnr", item.psnr()); appendMetric(out, "ssim", item.ssim());
            out.append("heuristics=").append(Double.toHexString(item.heuristics().meanAbsoluteSourceDelta())).append(',')
                    .append(Double.toHexString(item.heuristics().candidateSpatialActivity())).append('\n');
            out.append("disposition=").append(item.disposition()).append('\n');
        }
        return out.toString();
    }

    private static void appendRevision(StringBuilder out, RevisionId id) {
        out.append(id.tenantId()).append('|').append(id.principalId()).append('|').append(id.artifactId()).append('|')
                .append(id.versionId()).append('|').append(id.sha256()).append('\n');
    }
    private static void appendMetric(StringBuilder out, String name, Metric metric) {
        out.append(name).append('=').append(metric.algorithm()).append(':').append(metric.status()).append(':')
                .append(metric.value().isPresent() ? Double.toHexString(metric.value().getAsDouble()) : "").append('\n');
    }

    private static Metric unavailable(String algorithm) { return new Metric(algorithm, MetricStatus.UNAVAILABLE, OptionalDouble.empty()); }
    private static boolean psnrBetter(Metric candidate, Metric source) {
        if (candidate.status() == MetricStatus.EXACT_MATCH) return source.status() == MetricStatus.MEASURED;
        return candidate.status() == MetricStatus.MEASURED && source.status() == MetricStatus.MEASURED
                && candidate.value().orElseThrow() > source.value().orElseThrow();
    }
    private static Metric psnr(Revision a, Revision b) {
        long samples = 0; double squared = 0;
        for (int f = 0; f < a.frames().size(); f++) {
            byte[] x = pixels(a.frames().get(f)), y = pixels(b.frames().get(f));
            for (int i = 0; i < x.length; i++) { double d = (x[i] & 0xff) - (y[i] & 0xff); squared += d * d; samples++; }
        }
        double mse = squared / samples;
        if (mse == 0) return new Metric(PSNR_ID, MetricStatus.EXACT_MATCH, OptionalDouble.empty());
        return new Metric(PSNR_ID, MetricStatus.MEASURED, OptionalDouble.of(10.0 * Math.log10(65_025.0 / mse)));
    }
    private static Metric ssim(Revision a, Revision b) {
        // Online population moments keep memory independent of the number of pixels.
        // The RGB arrays are private immutable snapshots, so internal reads avoid
        // allocating defensive copies for each metric pass.
        long count = 0;
        double meanX = 0, meanY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
        for (int f = 0; f < a.frames().size(); f++) {
            byte[] x = pixels(a.frames().get(f)), y = pixels(b.frames().get(f));
            for (int i = 0; i < x.length; i += 3) {
                double valueX = luma(x, i), valueY = luma(y, i);
                count++;
                double dx = valueX - meanX, dy = valueY - meanY;
                meanX += dx / count;
                meanY += dy / count;
                sumXX += dx * (valueX - meanX);
                sumYY += dy * (valueY - meanY);
                sumXY += dx * (valueY - meanY);
            }
        }
        double vx = sumXX / count, vy = sumYY / count, cov = sumXY / count;
        double value = ((2 * meanX * meanY + SSIM_C1) * (2 * cov + SSIM_C2))
                / ((meanX * meanX + meanY * meanY + SSIM_C1) * (vx + vy + SSIM_C2));
        value = Math.max(-1.0, Math.min(1.0, value));
        return new Metric(SSIM_ID, MetricStatus.MEASURED, OptionalDouble.of(value));
    }
    private static double luma(byte[] rgb, int offset) {
        return .2126 * (rgb[offset] & 0xff) + .7152 * (rgb[offset + 1] & 0xff) + .0722 * (rgb[offset + 2] & 0xff);
    }
    private static byte[] pixels(RgbFrame frame) { return frame.rgb; }

    private static double meanAbsDelta(Revision source, Revision candidate) {
        long total = 0; long count = 0;
        for (int f = 0; f < source.frames().size(); f++) {
            byte[] x = pixels(source.frames().get(f)), y = pixels(candidate.frames().get(f));
            for (int i = 0; i < x.length; i++) { total += Math.abs((x[i] & 0xff) - (y[i] & 0xff)); count++; }
        }
        return (double) total / count;
    }
    private static double spatialActivity(Revision revision) {
        long total = 0, count = 0;
        for (RgbFrame frame : revision.frames()) {
            byte[] rgb = pixels(frame);
            for (int y = 0; y < frame.height(); y++) for (int x = 0; x < frame.width(); x++) {
                int pixel = (y * frame.width() + x) * 3;
                if (x + 1 < frame.width()) for (int c = 0; c < 3; c++) { total += Math.abs((rgb[pixel + c] & 0xff) - (rgb[pixel + 3 + c] & 0xff)); count++; }
                if (y + 1 < frame.height()) for (int c = 0; c < 3; c++) { total += Math.abs((rgb[pixel + c] & 0xff) - (rgb[pixel + frame.width() * 3 + c] & 0xff)); count++; }
            }
        }
        return count == 0 ? 0.0 : (double) total / count;
    }
    private static boolean aligned(Revision a, Revision b) {
        if (a.frames().size() != b.frames().size() || !a.timeBase().equals(b.timeBase())) return false;
        for (int i = 0; i < a.frames().size(); i++) {
            RgbFrame x = a.frames().get(i), y = b.frames().get(i);
            if (x.width() != y.width() || x.height() != y.height() || x.presentationTicks() != y.presentationTicks()) return false;
        }
        return true;
    }
    private static boolean sameTenant(RevisionId a, RevisionId b) {
        return a.tenantId().equals(b.tenantId()) && a.principalId().equals(b.principalId());
    }
    private static boolean sameAllowedDecision(AuthorityDecision a, AuthorityDecision b) {
        return a != null && b != null && a.status() == AuthorityStatus.ALLOWED
                && b.status() == AuthorityStatus.ALLOWED && a.decisionId().equals(b.decisionId());
    }
    private static AuthorityDecision checkRights(RightsAuthority authority, RevisionId revision, String purpose) {
        if (authority == null) return new AuthorityDecision(AuthorityStatus.UNAVAILABLE, "");
        try {
            AuthorityDecision decision = authority.check(revision, purpose);
            return decision == null ? new AuthorityDecision(AuthorityStatus.UNAVAILABLE, "") : decision;
        } catch (RuntimeException unavailable) {
            return new AuthorityDecision(AuthorityStatus.UNAVAILABLE, "");
        }
    }
    private static void validateBudget(Revision revision, Budget budget) {
        if (pixelCount(revision) > budget.maxPixels() || byteCount(revision) > budget.maxBytes()) {
            throw invalid("revision exceeds declared pixel/byte budget");
        }
    }
    private static long pixelCount(Revision revision) {
        return revision.frames().stream().mapToLong(f -> (long) f.width() * f.height()).sum();
    }
    private static long byteCount(Revision revision) {
        return revision.frames().stream().mapToLong(f -> f.rgb.length).sum();
    }
    private static String text(String value, String field, int max) {
        if (value == null || value.isBlank() || value.length() > max) throw invalid(field + " is required and bounded");
        return value.trim();
    }
    private static String digest(String value, String field) {
        String result = text(value, field, 64).toLowerCase(java.util.Locale.ROOT);
        if (!result.matches(SHA256)) throw invalid(field + " must be lowercase SHA-256 hex");
        return result;
    }

    private static List<RgbFrame> copyFramesBounded(List<RgbFrame> frames) {
        ArrayList<RgbFrame> copy = new ArrayList<>();
        java.util.Iterator<RgbFrame> iterator = frames.iterator();
        while (iterator.hasNext()) {
            if (copy.size() >= MAX_FRAMES) throw invalid("revision frame count is outside bounds");
            copy.add(Objects.requireNonNull(iterator.next(), "frames[]"));
        }
        return List.copyOf(copy);
    }

    private static String sha256(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
}
