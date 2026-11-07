package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaTimebase;
import com.ghatana.media.runtime.MediaTimebase.ClockDomain;
import com.ghatana.media.runtime.MediaVisualContracts.NormalizedBox;
import java.util.AbstractList;
import java.util.AbstractMap;
import java.util.AbstractSet;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class ReversibleRegionEditEngineTest {
    private static final Actor OWNER = new Actor("tenant-region", "principal-region");
    private static final Actor OTHER = new Actor("tenant-region", "principal-other");
    private static final SourceVersion SOURCE = new SourceVersion("artifact-region", "version-9");
    private static final String DIGEST = "a".repeat(64);
    private static final MediaTimebase PTS = new MediaTimebase(90_000, 1);

    @Test
    void explicitVfrEvidenceIsKeptAtSourcePtsWithoutInterpolation() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.TrackingEvidence evidence = evidence(List.of(
                bboxSample(0, 0.10, 0.10, 0),
                bboxSample(40_000, 0.14, 0.10, 0),
                bboxSample(108_000, 0.21, 0.10, 0)));
        ReversibleRegionEditEngine.RegionEditPlan plan = fixture.prepare(evidence);

        assertThat(plan.evidence().samples()).extracting(sample -> sample.sourcePts().ticks())
                .containsExactly(0L, 40_000L, 108_000L);
        assertThat(plan.evidence().samples().get(2).sourcePts().timebase()).isEqualTo(PTS);
        assertThat(plan.evidence().samples().get(2).sourcePts().domain()).isEqualTo(ClockDomain.SOURCE);
    }

    @Test
    void bboxDriftAndMaskDriftAreRejectedAndMissingTrackingIsTypedUnsupported() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.TrackedSample badBox = new ReversibleRegionEditEngine.TrackedSample(
                sourcePts(0), "frame-coordinates-v1", "edited-coordinates-v1",
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .2, .2)),
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.205, .1, .2, .2)),
                new ReversibleRegionEditEngine.AffineTransform(1, 0, 0, 1, .1, 0));
        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(badBox))))
                .isInstanceOf(ReversibleRegionEditEngine.RegionMappingConflictException.class)
                .hasMessageContaining("drifts");

        ReversibleRegionEditEngine.MaskShape before = new ReversibleRegionEditEngine.MaskShape(2, 2,
                new byte[] {1, 0, 0, 1});
        ReversibleRegionEditEngine.MaskShape drifted = new ReversibleRegionEditEngine.MaskShape(2, 2,
                new byte[] {0, 1, 0, 1});
        ReversibleRegionEditEngine.TrackedSample badMask = new ReversibleRegionEditEngine.TrackedSample(
                sourcePts(0), "mask-grid-v1", "mask-grid-v1", before, drifted,
                ReversibleRegionEditEngine.AffineTransform.identity());
        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(badMask))))
                .isInstanceOf(ReversibleRegionEditEngine.RegionMappingConflictException.class)
                .hasMessageContaining("mask bytes or dimensions drift");
        assertThatThrownBy(() -> fixture.engine.prepare(OWNER, new ReversibleRegionEditEngine.EditRequest(
                "project-region", "plan-absent", "r0", SOURCE, DIGEST, "local-region-edit", "region-1", PTS, null,
                ReversibleRegionEditEngine.EditIntent.ADJUST_MASK_BOUNDARY)))
                .isInstanceOf(ReversibleRegionEditEngine.UnsupportedTrackingException.class);
    }

    @Test
    void editIntentMustMatchEveryTrackedSampleShapeBeforeRightsInspection() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.TrackingEvidence boxes = evidence(List.of(bboxSample(0, .1, .1, 0)));
        assertThatThrownBy(() -> fixture.engine.prepare(OWNER, new ReversibleRegionEditEngine.EditRequest(
                "project-region", "plan-wrong-mask-intent", "r0", SOURCE, DIGEST, "local-region-edit", "region-1",
                PTS, boxes, ReversibleRegionEditEngine.EditIntent.ADJUST_MASK_BOUNDARY)))
                .isInstanceOf(ReversibleRegionEditEngine.UnsupportedRegionMappingException.class)
                .hasMessageContaining("shape does not match");
        assertThat(fixture.rightsCalls).isZero();

        ReversibleRegionEditEngine.MaskShape mask = new ReversibleRegionEditEngine.MaskShape(2, 2,
                new byte[] {1, 0, 0, 1});
        ReversibleRegionEditEngine.TrackedSample maskSample = new ReversibleRegionEditEngine.TrackedSample(
                sourcePts(0), "source-mask-grid-v1", "source-mask-grid-v1", mask, mask,
                ReversibleRegionEditEngine.AffineTransform.identity());
        ReversibleRegionEditEngine.TrackingEvidence masks = evidence(List.of(maskSample));
        assertThatThrownBy(() -> fixture.engine.prepare(OWNER, new ReversibleRegionEditEngine.EditRequest(
                "project-region", "plan-wrong-move-intent", "r0", SOURCE, DIGEST, "local-region-edit", "region-1",
                PTS, masks, ReversibleRegionEditEngine.EditIntent.MOVE_OR_RESIZE_REGION)))
                .isInstanceOf(ReversibleRegionEditEngine.UnsupportedRegionMappingException.class)
                .hasMessageContaining("shape does not match");
        assertThat(fixture.rightsCalls).isZero();

        assertThat(fixture.engine.prepare(OWNER, new ReversibleRegionEditEngine.EditRequest(
                "project-region", "plan-mask-intent", "r0", SOURCE, DIGEST, "local-region-edit", "region-1",
                PTS, masks, ReversibleRegionEditEngine.EditIntent.ADJUST_MASK_BOUNDARY)).intent())
                .isEqualTo(ReversibleRegionEditEngine.EditIntent.ADJUST_MASK_BOUNDARY);
        assertThat(fixture.rightsCalls).isEqualTo(1);
    }

    @Test
    void identityMappingCannotRelabelTheTrackedCoordinateContext() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.TrackedSample relabeled = new ReversibleRegionEditEngine.TrackedSample(
                sourcePts(0), "source-frame-v1", "edited-frame-v2",
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .2, .2)),
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .2, .2)),
                ReversibleRegionEditEngine.AffineTransform.identity());

        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(relabeled))))
                .isInstanceOf(ReversibleRegionEditEngine.RegionMappingConflictException.class)
                .hasMessageContaining("identity transform cannot change coordinate context");
        assertThat(fixture.rightsCalls).isZero();
    }

    @Test
    void bboxTransformUsesAllCornersAndRejectsAreaCollapsingMapping() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.TrackedSample sheared = new ReversibleRegionEditEngine.TrackedSample(
                sourcePts(0), "source-frame-v1", "edited-frame-v1",
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .2, .2)),
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.2, .1, .4, .2)),
                new ReversibleRegionEditEngine.AffineTransform(1, 1, 0, 1, 0, 0));

        assertThat(fixture.prepare(evidence(List.of(sheared))).evidence().samples()).containsExactly(sheared);

        ReversibleRegionEditEngine.TrackedSample collapsed = new ReversibleRegionEditEngine.TrackedSample(
                sourcePts(0), "source-frame-v1", "edited-frame-v1",
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .2, .2)),
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .2, .2, .4)),
                new ReversibleRegionEditEngine.AffineTransform(.5, .5, 1, 1, 0, 0));
        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(collapsed))))
                .isInstanceOf(ReversibleRegionEditEngine.RegionMappingConflictException.class)
                .hasMessageContaining("finite and invertible");
    }

    @Test
    void bboxTransformOutsideNormalizedEditedFrameIsTypedMappingConflictBeforeRightsCheck() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.TrackedSample outsideFrame = new ReversibleRegionEditEngine.TrackedSample(
                sourcePts(0), "source-frame-v1", "edited-frame-v1",
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.8, .1, .15, .2)),
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.9, .1, .1, .2)),
                new ReversibleRegionEditEngine.AffineTransform(1, 0, 0, 1, .2, 0));

        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(outsideFrame))))
                .isInstanceOf(ReversibleRegionEditEngine.RegionMappingConflictException.class)
                .hasMessageContaining("outside normalized edited-frame bounds");
        assertThat(fixture.rightsCalls).isZero();
    }

    @Test
    void sourceVersionDigestAndFreshRightsMustMatchAtPrepareAndCommit() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.RegionEditPlan plan = fixture.prepare(evidence(List.of(bboxSample(0, .1, .1, 0))));
        fixture.rights = ReversibleRegionEditEngine.RightsDecision.REVOKED;
        assertThatThrownBy(() -> fixture.engine.apply(OWNER, plan, "r0", "edit-revoked", state("new", "region", "2")))
                .isInstanceOf(ReversibleRegionEditEngine.RegionRightsDeniedException.class);
        assertThat(fixture.store.head(OWNER, "project-region").revisionId()).isEqualTo("r0");

        fixture.rights = ReversibleRegionEditEngine.RightsDecision.ELIGIBLE;
        ReversibleRegionEditEngine.TrackingEvidence staleDigest = new ReversibleRegionEditEngine.TrackingEvidence(
                "vision-track-1", SOURCE, "b".repeat(64), "region-1", List.of(bboxSample(0, .1, .1, 0)));
        assertThatThrownBy(() -> fixture.prepare(staleDigest))
                .isInstanceOf(ReversibleRegionEditEngine.RegionMappingConflictException.class);
        fixture.rights = ReversibleRegionEditEngine.RightsDecision.MISSING;
        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(bboxSample(0, .1, .1, 0)))))
                .isInstanceOf(ReversibleRegionEditEngine.SourceRevisionMissingException.class);
        fixture.rights = ReversibleRegionEditEngine.RightsDecision.STALE;
        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(bboxSample(0, .1, .1, 0)))))
                .isInstanceOf(ReversibleRegionEditEngine.StaleSourceRevisionException.class);
        fixture.rights = ReversibleRegionEditEngine.RightsDecision.UNKNOWN;
        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(bboxSample(0, .1, .1, 0)))))
                .isInstanceOf(ReversibleRegionEditEngine.RightsAuthorityUnavailableException.class);
        assertThat(fixture.rightsCalls).isGreaterThanOrEqualTo(3);
    }

    @Test
    void staleEditorConflictIsAtomicAndCannotReplaceCurrentRevision() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.TrackingEvidence evidence = evidence(List.of(bboxSample(0, .1, .1, 0)));
        ReversibleRegionEditEngine.RegionEditPlan first = fixture.prepare(evidence);
        ReversibleRegionEditEngine.RegionEditPlan stale = fixture.prepare(evidence);
        ReversibleRegionEditEngine.EditRevision committed = fixture.engine.apply(OWNER, first, "r0", "edit-1",
                state("after-one", "edit", "one"));

        assertThatThrownBy(() -> fixture.engine.apply(OWNER, stale, "r0", "edit-2", state("after-two", "edit", "two")))
                .isInstanceOf(RevisionConflictException.class);
        assertThat(fixture.store.head(OWNER, "project-region").revisionId()).isEqualTo(committed.revisionId());
        assertThat(fixture.store.head(OWNER, "project-region").snapshot()).isEqualTo(state("after-one", "edit", "one"));
        assertThatThrownBy(() -> fixture.engine.apply(OTHER, first, "r0", "edit-other", state("x", "k", "v")))
                .isInstanceOf(ProjectAccessDeniedException.class);
    }

    @Test
    void revisionRejectsTrackingEvidenceForAnotherSourceDigest() {
        ReversibleRegionEditEngine.TrackingEvidence otherSourceEvidence = new ReversibleRegionEditEngine.TrackingEvidence(
                "vision-track-other-source", SOURCE, "b".repeat(64), "region-1",
                List.of(bboxSample(0, .1, .1, 0)));

        assertThatThrownBy(() -> new ReversibleRegionEditEngine.EditRevision(
                OWNER.tenantId(), OWNER.principalId(), "project-region", "r1", "r0", "plan-1",
                SOURCE, DIGEST, "local-region-edit", "region-1", otherSourceEvidence,
                state("snapshot", "edit", "value"), null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("revision must preserve exact source and region evidence identity");
    }

    @Test
    void revisionRejectsMixedSourcePresentationTimebases() {
        MediaTimebase otherTimebase = new MediaTimebase(30_000, 1);
        ReversibleRegionEditEngine.TrackingEvidence mixedClockEvidence = evidence(List.of(
                bboxSample(0, .1, .1, 0),
                new ReversibleRegionEditEngine.TrackedSample(
                        new MediaTimebase.Timestamp(otherTimebase, 1_000, ClockDomain.SOURCE),
                        "source-normalized-frame-v1", "source-normalized-frame-v1",
                        new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .15, .12)),
                        new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .15, .12)),
                        ReversibleRegionEditEngine.AffineTransform.identity())));

        assertThatThrownBy(() -> new ReversibleRegionEditEngine.EditRevision(
                OWNER.tenantId(), OWNER.principalId(), "project-region", "r1", "r0", "plan-1",
                SOURCE, DIGEST, "local-region-edit", "region-1", mixedClockEvidence,
                state("snapshot", "edit", "value"), null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exact source presentation clock");
    }

    @Test
    void undoRestoresByteExactPriorMetadataOnlyForMatchingTargetAndIsIdempotent() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.EditSnapshot before = new ReversibleRegionEditEngine.EditSnapshot(
                new byte[] {0, (byte) 0xff, 3, 0}, Map.of("mask", "original", "selection", "ROI-A"));
        fixture.store.seed(OWNER, "project-region", "r0", SOURCE, DIGEST, "local-region-edit", "region-1", evidence(List.of(bboxSample(0, .1, .1, 0))), before);
        ReversibleRegionEditEngine.RegionEditPlan plan = fixture.prepare(evidence(List.of(bboxSample(0, .1, .1, 0))));
        ReversibleRegionEditEngine.EditSnapshot after = new ReversibleRegionEditEngine.EditSnapshot(
                new byte[] {9, 8, 7, 6, 5}, Map.of("mask", "edited", "selection", "ROI-B"));
        ReversibleRegionEditEngine.EditRevision edit = fixture.engine.apply(OWNER, plan, "r0", "edit-undo", after);
        assertThat(edit.snapshot()).isEqualTo(after);
        assertThatThrownBy(() -> fixture.engine.undo(OWNER, "project-region", "r0", edit.revisionId(), "undo-wrong-target"))
                .isInstanceOf(RevisionConflictException.class);

        ReversibleRegionEditEngine.EditRevision undone = fixture.engine.undo(OWNER, "project-region", edit.revisionId(),
                edit.revisionId(), "undo-1");
        assertThat(undone.snapshot()).isEqualTo(before);
        assertThat(undone.restoresRevisionId()).isEqualTo(edit.revisionId());
        assertThat(undone.revisionId()).isNotEqualTo("r0");
        assertThat(fixture.engine.undo(OWNER, "project-region", edit.revisionId(), edit.revisionId(), "undo-1"))
                .isEqualTo(undone);

        assertThatThrownBy(() -> fixture.engine.undo(OWNER, "project-region", edit.revisionId(), "r0", "undo-stale"))
                .isInstanceOf(RevisionConflictException.class);
        assertThat(fixture.store.head(OWNER, "project-region").snapshot()).isEqualTo(before);
    }

    @Test
    void requestIdempotencyReturnsSameRevisionAndRejectsRebinding() {
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.RegionEditPlan plan = fixture.prepare(evidence(List.of(bboxSample(0, .1, .1, 0))));
        ReversibleRegionEditEngine.EditSnapshot after = state("same", "edit", "same");
        ReversibleRegionEditEngine.EditRevision first = fixture.engine.apply(OWNER, plan, "r0", "edit-idem", after);
        assertThat(fixture.engine.apply(OWNER, plan, "r0", "edit-idem", after)).isEqualTo(first);
        assertThatThrownBy(() -> fixture.engine.apply(OWNER, plan, "r0", "edit-idem", state("changed", "edit", "different")))
                .isInstanceOf(ReversibleRegionEditEngine.EditIdempotencyConflictException.class);
        assertThat(fixture.store.head(OWNER, "project-region").revisionId()).isEqualTo(first.revisionId());
    }

    @Test
    void snapshotsAndMasksDefensivelyCopyBytesAndRejectBadSourcePtsOrDigest() {
        byte[] bytes = {1, 2, 3};
        ReversibleRegionEditEngine.EditSnapshot snapshot = new ReversibleRegionEditEngine.EditSnapshot(bytes, Map.of("a", "b"));
        bytes[0] = 9;
        byte[] read = snapshot.bytes();
        read[1] = 9;
        assertThat(snapshot.bytes()).containsExactly(1, 2, 3);

        byte[] maskBytes = {1, 0, 0, 1};
        ReversibleRegionEditEngine.MaskShape mask = new ReversibleRegionEditEngine.MaskShape(2, 2, maskBytes);
        maskBytes[0] = 0;
        byte[] maskRead = mask.occupancy();
        maskRead[3] = 0;
        assertThat(mask.occupancy()).containsExactly((byte) 1, (byte) 0, (byte) 0, (byte) 1);

        assertThatThrownBy(() -> fixtureRequest("bad-digest"))
                .isInstanceOf(IllegalArgumentException.class);
        RegionEditFixture fixture = new RegionEditFixture();
        ReversibleRegionEditEngine.TrackedSample mediaClock = new ReversibleRegionEditEngine.TrackedSample(
                new MediaTimebase.Timestamp(PTS, 1, ClockDomain.MEDIA), "src", "edit",
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .1, .1)),
                new ReversibleRegionEditEngine.BoxShape(new NormalizedBox(.1, .1, .1, .1)),
                ReversibleRegionEditEngine.AffineTransform.identity());
        assertThatThrownBy(() -> fixture.prepare(evidence(List.of(mediaClock))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("source presentation clock");
    }

    @Test
    void trackedSamplesAndSnapshotMetadataAreBoundedBeforeCopyOrAuthorityDispatch() {
        List<ReversibleRegionEditEngine.TrackedSample> excessiveSamples =
                java.util.Collections.nCopies(10_001, bboxSample(0, .1, .1, 0));
        assertThatThrownBy(() -> evidence(excessiveSamples))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("10000-frame local bound");

        Map<String, String> excessiveMetadata = new HashMap<>();
        for (int index = 0; index < 257; index++) excessiveMetadata.put("key-" + index, "value");
        assertThatThrownBy(() -> new ReversibleRegionEditEngine.EditSnapshot(new byte[] {1}, excessiveMetadata))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("metadata exceeds entry bound");
        assertThatThrownBy(() -> new ReversibleRegionEditEngine.EditSnapshot(
                new byte[] {1}, Map.of("key", "v".repeat(4_097))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("field exceeds character bound");
    }

    @Test
    void aggregateTrackedMaskBytesAreBoundedBeforeRightsInspection() {
        byte[] maximumMaskBytes = new byte[4_096 * 4_096];
        ReversibleRegionEditEngine.MaskShape maximumMask = new ReversibleRegionEditEngine.MaskShape(
                4_096, 4_096, maximumMaskBytes);
        List<ReversibleRegionEditEngine.TrackedSample> samples = List.of(
                maskSample(0, maximumMask), maskSample(1, maximumMask), maskSample(2, maximumMask));
        RegionEditFixture fixture = new RegionEditFixture();

        assertThatThrownBy(() -> fixture.engine.prepare(OWNER, new ReversibleRegionEditEngine.EditRequest(
                "project-region", "plan-large-mask-evidence", "r0", SOURCE, DIGEST, "local-region-edit", "region-1",
                PTS, evidence(samples), ReversibleRegionEditEngine.EditIntent.ADJUST_MASK_BOUNDARY)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("tracked mask evidence exceeds the 64 MiB local byte bound");
        assertThat(fixture.rightsCalls).isZero();
    }

    @Test
    void reportedCollectionSizesCannotBypassTrackedSampleOrMetadataBounds() {
        AtomicInteger visitedSamples = new AtomicInteger();
        ReversibleRegionEditEngine.TrackedSample sample = bboxSample(0, .1, .1, 0);
        List<ReversibleRegionEditEngine.TrackedSample> oversizedSamples = new AbstractList<>() {
            @Override public int size() { return 1; }
            @Override public ReversibleRegionEditEngine.TrackedSample get(int index) { return sample; }
            @Override public Iterator<ReversibleRegionEditEngine.TrackedSample> iterator() {
                return new Iterator<>() {
                    private int index;
                    @Override public boolean hasNext() { return index < 10_001; }
                    @Override public ReversibleRegionEditEngine.TrackedSample next() {
                        index++;
                        visitedSamples.incrementAndGet();
                        return sample;
                    }
                };
            }
        };
        assertThatThrownBy(() -> evidence(oversizedSamples))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("10000-frame local bound");
        assertThat(visitedSamples).hasValue(10_000);

        AtomicInteger visitedMetadata = new AtomicInteger();
        Map<String, String> oversizedMetadata = new AbstractMap<>() {
            @Override public int size() { return 1; }
            @Override public Set<Entry<String, String>> entrySet() {
                return new AbstractSet<>() {
                    @Override public int size() { return 1; }
                    @Override public Iterator<Entry<String, String>> iterator() {
                        return new Iterator<>() {
                            private int index;
                            @Override public boolean hasNext() { return index < 257; }
                            @Override public Entry<String, String> next() {
                                int value = index++;
                                visitedMetadata.incrementAndGet();
                                return Map.entry("key-" + value, "value");
                            }
                        };
                    }
                };
            }
        };
        assertThatThrownBy(() -> new ReversibleRegionEditEngine.EditSnapshot(new byte[] {1}, oversizedMetadata))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("metadata exceeds entry bound");
        assertThat(visitedMetadata).hasValue(256);
    }

    @Test
    void duplicateMetadataKeysFromHostileMapAreRejected() {
        AtomicInteger visited = new AtomicInteger();
        Map<String, String> duplicateKeys = new AbstractMap<>() {
            @Override public int size() { return 1; }
            @Override public Set<Entry<String, String>> entrySet() {
                return new AbstractSet<>() {
                    @Override public int size() { return 1; }
                    @Override public Iterator<Entry<String, String>> iterator() {
                        return new Iterator<>() {
                            private int index;
                            @Override public boolean hasNext() { return index < 2; }
                            @Override public Entry<String, String> next() {
                                visited.incrementAndGet();
                                return Map.entry("selection", index++ == 0 ? "ROI-A" : "ROI-B");
                            }
                        };
                    }
                };
            }
        };

        assertThatThrownBy(() -> new ReversibleRegionEditEngine.EditSnapshot(
                new byte[] {1}, duplicateKeys))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("metadata keys must be unique");
        assertThat(visited).hasValue(2);
    }

    private static ReversibleRegionEditEngine.EditRequest fixtureRequest(String digest) {
        return new ReversibleRegionEditEngine.EditRequest("project", "plan-test", "r0", SOURCE, digest, "purpose", "region",
                PTS, evidence(List.of(bboxSample(0, .1, .1, 0))), ReversibleRegionEditEngine.EditIntent.MOVE_OR_RESIZE_REGION);
    }

    private static ReversibleRegionEditEngine.TrackingEvidence evidence(List<ReversibleRegionEditEngine.TrackedSample> samples) {
        return new ReversibleRegionEditEngine.TrackingEvidence("vision-observation-exact-1", SOURCE, DIGEST, "region-1", samples);
    }

    private static ReversibleRegionEditEngine.TrackedSample bboxSample(long pts, double x, double y, double dx) {
        NormalizedBox source = new NormalizedBox(x, y, .15, .12);
        NormalizedBox edited = new NormalizedBox(x + dx, y, .15, .12);
        return new ReversibleRegionEditEngine.TrackedSample(sourcePts(pts), "source-normalized-frame-v1",
                dx == 0 ? "source-normalized-frame-v1" : "edited-normalized-frame-v1",
                new ReversibleRegionEditEngine.BoxShape(source), new ReversibleRegionEditEngine.BoxShape(edited),
                new ReversibleRegionEditEngine.AffineTransform(1, 0, 0, 1, dx, 0));
    }

    private static ReversibleRegionEditEngine.TrackedSample maskSample(
            long pts, ReversibleRegionEditEngine.MaskShape mask) {
        return new ReversibleRegionEditEngine.TrackedSample(sourcePts(pts), "source-mask-grid-v1",
                "source-mask-grid-v1", mask, mask, ReversibleRegionEditEngine.AffineTransform.identity());
    }

    private static MediaTimebase.Timestamp sourcePts(long ticks) {
        return new MediaTimebase.Timestamp(PTS, ticks, ClockDomain.SOURCE);
    }

    private static ReversibleRegionEditEngine.EditSnapshot state(String text, String key, String value) {
        return new ReversibleRegionEditEngine.EditSnapshot(text.getBytes(java.nio.charset.StandardCharsets.UTF_8), Map.of(key, value));
    }

    private static final class RegionEditFixture {
        final MemoryStore store = new MemoryStore();
        final ReversibleRegionEditEngine engine = new ReversibleRegionEditEngine(store, this::inspect);
        ReversibleRegionEditEngine.RightsDecision rights = ReversibleRegionEditEngine.RightsDecision.ELIGIBLE;
        int rightsCalls;
        RegionEditFixture() {
            store.seed(OWNER, "project-region", "r0", SOURCE, DIGEST, "local-region-edit", "region-1",
                    evidence(List.of(bboxSample(0, .1, .1, 0))), state("before", "edit", "original"));
        }
        ReversibleRegionEditEngine.RightsDecision inspect(Actor actor, SourceVersion source, String digest,
                String purpose, String regionId, List<ReversibleRegionEditEngine.TrackedSample> samples) {
            rightsCalls++;
            if (!source.equals(SOURCE) || !DIGEST.equals(digest) || !"local-region-edit".equals(purpose)
                    || !"region-1".equals(regionId) || samples.isEmpty()) return ReversibleRegionEditEngine.RightsDecision.DENIED;
            return rights;
        }
        ReversibleRegionEditEngine.RegionEditPlan prepare(ReversibleRegionEditEngine.TrackingEvidence evidence) {
            return engine.prepare(OWNER, new ReversibleRegionEditEngine.EditRequest("project-region", "plan-region-1", "r0", SOURCE,
                    DIGEST, "local-region-edit", "region-1", PTS, evidence,
                    ReversibleRegionEditEngine.EditIntent.MOVE_OR_RESIZE_REGION));
        }
    }

    /** Test authority: synchronized single writer with append-only revisions and request fingerprinting. */
    private static final class MemoryStore implements ReversibleRegionEditEngine.RegionEditStore {
        private final Map<String, Project> projects = new HashMap<>();
        private final Map<RequestKey, RequestReceipt> requests = new HashMap<>();
        private int sequence;

        synchronized void seed(Actor actor, String projectId, String revisionId, SourceVersion source, String digest,
                               String purpose, String regionId, ReversibleRegionEditEngine.TrackingEvidence evidence,
                               ReversibleRegionEditEngine.EditSnapshot snapshot) {
            ReversibleRegionEditEngine.EditRevision initial = new ReversibleRegionEditEngine.EditRevision(
                    actor.tenantId(), actor.principalId(), projectId, revisionId, null, "initial", source, digest,
                    purpose, regionId, evidence, snapshot, null);
            Project project = new Project(actor, revisionId);
            project.revisions.put(revisionId, initial);
            projects.put(key(actor.tenantId(), projectId), project);
        }

        @Override public synchronized ReversibleRegionEditEngine.EditRevision revision(Actor actor, String projectId, String revisionId) {
            Project project = owned(actor, projectId);
            ReversibleRegionEditEngine.EditRevision revision = project.revisions.get(revisionId);
            if (revision == null) throw new ReversibleRegionEditEngine.EditRevisionNotFoundException();
            return revision;
        }

        @Override public synchronized ReversibleRegionEditEngine.EditRevision commit(Actor actor,
                ReversibleRegionEditEngine.RegionEditPlan plan, String expectedRevisionId, String requestId,
                ReversibleRegionEditEngine.EditSnapshot afterState) {
            String fingerprint = "commit|" + plan + "|" + afterState.sha256() + "|" + afterState.metadata();
            ReversibleRegionEditEngine.EditRevision replay = replay(actor, requestId, fingerprint);
            if (replay != null) return replay;
            Project project = owned(actor, plan.projectId());
            if (!project.headRevisionId.equals(expectedRevisionId)) {
                throw new RevisionConflictException(expectedRevisionId, project.headRevisionId);
            }
            String revisionId = "r" + (++sequence);
            ReversibleRegionEditEngine.EditRevision committed = new ReversibleRegionEditEngine.EditRevision(
                    actor.tenantId(), actor.principalId(), plan.projectId(), revisionId, project.headRevisionId,
                    plan.editPlanId(), plan.source(), plan.sourceSha256(), plan.purpose(), plan.regionId(),
                    plan.evidence(), afterState, null);
            project.revisions.put(revisionId, committed);
            project.headRevisionId = revisionId;
            remember(actor, requestId, fingerprint, committed);
            return committed;
        }

        @Override public synchronized ReversibleRegionEditEngine.EditRevision undo(Actor actor, String projectId,
                String targetRevisionId, String expectedCurrentRevisionId, String requestId) {
            String fingerprint = "undo|" + projectId + "|" + targetRevisionId + "|" + expectedCurrentRevisionId;
            ReversibleRegionEditEngine.EditRevision replay = replay(actor, requestId, fingerprint);
            if (replay != null) return replay;
            Project project = owned(actor, projectId);
            if (!project.headRevisionId.equals(expectedCurrentRevisionId) || !targetRevisionId.equals(project.headRevisionId)) {
                throw new RevisionConflictException(expectedCurrentRevisionId, project.headRevisionId);
            }
            ReversibleRegionEditEngine.EditRevision target = project.revisions.get(targetRevisionId);
            if (target == null) throw new ReversibleRegionEditEngine.EditRevisionNotFoundException();
            if (target.parentRevisionId() == null) throw new IllegalStateException("initial revision has no undo parent");
            ReversibleRegionEditEngine.EditRevision parent = project.revisions.get(target.parentRevisionId());
            String revisionId = "r" + (++sequence);
            ReversibleRegionEditEngine.EditRevision restored = new ReversibleRegionEditEngine.EditRevision(
                    actor.tenantId(), actor.principalId(), projectId, revisionId, project.headRevisionId,
                    target.planId(), target.source(), target.sourceSha256(), target.purpose(), target.regionId(),
                    target.evidence(), parent.snapshot(), target.revisionId());
            project.revisions.put(revisionId, restored);
            project.headRevisionId = revisionId;
            remember(actor, requestId, fingerprint, restored);
            return restored;
        }

        synchronized ReversibleRegionEditEngine.EditRevision head(Actor actor, String projectId) {
            Project project = owned(actor, projectId);
            return project.revisions.get(project.headRevisionId);
        }

        private ReversibleRegionEditEngine.EditRevision replay(Actor actor, String requestId, String fingerprint) {
            RequestKey key = new RequestKey(actor.tenantId(), actor.principalId(), requestId);
            RequestReceipt previous = requests.get(key);
            if (previous == null) return null;
            if (!previous.fingerprint.equals(fingerprint)) throw new ReversibleRegionEditEngine.EditIdempotencyConflictException();
            return previous.revision;
        }

        private void remember(Actor actor, String requestId, String fingerprint, ReversibleRegionEditEngine.EditRevision revision) {
            requests.put(new RequestKey(actor.tenantId(), actor.principalId(), requestId), new RequestReceipt(fingerprint, revision));
        }

        private Project owned(Actor actor, String projectId) {
            Project project = projects.get(key(actor.tenantId(), projectId));
            if (project == null) throw new ProjectNotFoundException();
            if (!project.actor.principalId().equals(actor.principalId())) throw new ProjectAccessDeniedException();
            return project;
        }
        private static String key(String tenant, String project) { return tenant + "/" + project; }
        private record RequestKey(String tenant, String principal, String request) { }
        private record RequestReceipt(String fingerprint, ReversibleRegionEditEngine.EditRevision revision) { }
        private static final class Project {
            private final Actor actor;
            private String headRevisionId;
            private final Map<String, ReversibleRegionEditEngine.EditRevision> revisions = new HashMap<>();
            private Project(Actor actor, String headRevisionId) { this.actor = actor; this.headRevisionId = headRevisionId; }
        }
    }
}
