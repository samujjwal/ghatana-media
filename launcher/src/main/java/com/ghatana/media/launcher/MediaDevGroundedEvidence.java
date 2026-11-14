package com.ghatana.media.launcher;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Evidence items, the bounded model prompt and the server-side citation validator of the grounded-answer lane.
 * The validator proves citation integrity only (every cited id exists, was offered to the model, and its time or box
 * is inside the source clock / frame). It does not prove that a claim is entailed by the cited evidence, so it never
 * presents a result as verified truth: it labels a claim GROUNDED only in the sense of "cites valid evidence".
 *
 * @doc.type class
 * @doc.purpose grounded evidence model, prompt budget and citation validation
 * @doc.layer product
 * @doc.pattern Service
 */
final class MediaDevGroundedEvidence {
    static final int MAX_CLAIMS = 8;
    static final int MAX_CLAIM_CHARS = 500;
    /** Whisper rounds segment ends; one second of slack beyond the container duration is tolerated, never more. */
    static final long TIME_TOLERANCE_MICROS = 1_000_000L;
    /** Florence boxes are in rounded pixel space; one pixel of slack. */
    static final double BOX_TOLERANCE_PX = 1.0;
    static final int PROMPT_BUDGET = 1000;
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    private MediaDevGroundedEvidence() { }

    enum Kind { TRANSCRIPT_SEGMENT, FRAME, FRAME_OBJECT, FRAME_TEXT }

    record Box(double x, double y, double width, double height) { }

    /** Frame position: the decoded frame's own PTS in the video stream timebase plus the frame size for box checks. */
    record Frame(long ptsTicks, String timebase, int width, int height, int frameNumber) { }

    /**
     * One citable piece of evidence. Times are container microseconds on the source clock. {@code frame} is set for
     * frame evidence; {@code box} for objects and scene-text regions; {@code origin} names the producing child/model.
     */
    record Item(String id, Kind kind, long startMicros, long endMicros, Frame frame, Box box, String text,
                String origin) {
        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("evidenceId", id);
            out.put("kind", kind.name());
            out.put("startMicros", startMicros);
            out.put("endMicros", endMicros);
            if (frame != null) {
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("ptsTicks", frame.ptsTicks());
                f.put("timebase", frame.timebase());
                f.put("frameNumber", frame.frameNumber());
                f.put("width", frame.width());
                f.put("height", frame.height());
                out.put("frame", f);
            }
            if (box != null) {
                out.put("box", Map.of("x", box.x(), "y", box.y(), "width", box.width(), "height", box.height()));
            }
            out.put("text", text);
            out.put("origin", origin);
            return out;
        }
    }

    /** Evidence ids the model was shown, in prompt order, and how many known items did not fit the budget. */
    record Prompt(String text, List<String> offeredIds, int omitted) { }

    static Prompt prompt(String question, List<Item> items) {
        String head = "Answer using ONLY the evidence below. Reply with JSON only: "
                + "{\"claims\":[{\"text\":\"...\",\"evidence\":[\"T0\"]}]}. Cite evidence ids exactly as listed; "
                + "every claim needs at least one. If the evidence does not answer, reply {\"claims\":[]}.\n"
                + "Question: " + oneLine(question, 220) + "\nEvidence:\n";
        StringBuilder out = new StringBuilder(head);
        List<String> offered = new ArrayList<>();
        int omitted = 0;
        List<Item> ordered = new ArrayList<>(items);
        ordered.sort(java.util.Comparator.comparingInt((Item item) -> priority(item.kind())));
        for (Item item : ordered) {
            String line = line(item);
            if (out.length() + line.length() + 1 > PROMPT_BUDGET) {
                omitted++;
                continue;
            }
            out.append(line).append('\n');
            offered.add(item.id());
        }
        return new Prompt(out.toString(), List.copyOf(offered), omitted);
    }

    private static int priority(Kind kind) {
        return switch (kind) {
            case TRANSCRIPT_SEGMENT -> 0;
            case FRAME_TEXT -> 1;
            case FRAME -> 2;
            case FRAME_OBJECT -> 3;
        };
    }

    private static String line(Item item) {
        String time = seconds(item.startMicros()) + (item.kind() == Kind.TRANSCRIPT_SEGMENT
                ? "-" + seconds(item.endMicros()) : "") + "s";
        String label = switch (item.kind()) {
            case TRANSCRIPT_SEGMENT -> "speech";
            case FRAME -> "frame caption";
            case FRAME_OBJECT -> "object";
            case FRAME_TEXT -> "on-screen text";
        };
        return item.id() + " [" + time + "] " + label + ": " + oneLine(item.text(), 90);
    }

    private static String seconds(long micros) {
        return String.format(java.util.Locale.ROOT, "%.2f", micros / 1_000_000.0);
    }

    private static String oneLine(String text, int max) {
        String flat = text.replaceAll("[\\p{Cntrl}\\s]+", " ").strip();
        return flat.length() <= max ? flat : flat.substring(0, max - 1) + "…";
    }

    // ---- validation ----

    record Claim(String claimId, String text, List<String> evidenceIds) {
        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("claimId", claimId);
            out.put("text", text);
            out.put("evidenceIds", evidenceIds);
            out.put("status", "GROUNDED");
            return out;
        }
    }

    record Flagged(String text, List<String> evidenceIds, List<String> flags) {
        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("text", text);
            out.put("evidenceIds", evidenceIds);
            out.put("flags", flags);
            out.put("status", "NOT_GROUNDED");
            return out;
        }
    }

    record Answer(String status, List<Claim> claims, List<Flagged> flagged, int modelClaimCount) {
        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("status", status);
            out.put("claims", claims.stream().map(Claim::view).toList());
            out.put("flaggedClaims", flagged.stream().map(Flagged::view).toList());
            out.put("modelClaimCount", modelClaimCount);
            out.put("validation", Map.of("checked",
                    "cited ids exist, were offered to the model, times within the source clock, boxes within the frame",
                    "notChecked", "that a claim is entailed by its cited evidence"));
            return out;
        }
    }

    /**
     * Validates the raw model reply. Claims without a valid citation are moved to {@code flagged} and are never
     * presented as grounded; an unparseable reply yields ANSWER_UNPARSEABLE with no claims.
     */
    static Answer validate(String modelReply, List<Item> all, List<String> offeredIds, MediaDevGroundedClock clock) {
        Map<String, Item> known = new LinkedHashMap<>();
        for (Item item : all) known.put(item.id(), item);
        Set<String> offered = new LinkedHashSet<>(offeredIds);
        final JsonNode root;
        try {
            int open = modelReply.indexOf('{');
            int close = modelReply.lastIndexOf('}');
            if (open < 0 || close <= open) throw new IllegalArgumentException("no JSON object");
            root = JSON.readTree(modelReply.substring(open, close + 1));
            if (!root.path("claims").isArray()) throw new IllegalArgumentException("claims is not an array");
        } catch (RuntimeException unparseable) {
            return new Answer("ANSWER_UNPARSEABLE", List.of(), List.of(), 0);
        }
        List<Claim> grounded = new ArrayList<>();
        List<Flagged> flagged = new ArrayList<>();
        int count = 0;
        for (JsonNode node : root.path("claims")) {
            if (++count > MAX_CLAIMS) {
                flagged.add(new Flagged("", List.of(), List.of("TOO_MANY_CLAIMS")));
                break;
            }
            String text = node.path("text").isString() ? node.path("text").asString().strip() : "";
            List<String> ids = new ArrayList<>();
            JsonNode cited = node.has("evidence") ? node.path("evidence") : node.path("evidenceIds");
            boolean malformedIds = false;
            if (cited.isArray()) {
                for (JsonNode id : cited) {
                    if (id.isString()) ids.add(id.asString());
                    else malformedIds = true;
                }
            } else if (!cited.isMissingNode() && !cited.isNull()) {
                malformedIds = true;
            }
            List<String> flags = new ArrayList<>();
            if (text.isEmpty()) flags.add("EMPTY_CLAIM");
            if (text.length() > MAX_CLAIM_CHARS) flags.add("CLAIM_TOO_LONG");
            if (malformedIds) flags.add("MALFORMED_CITATION");
            if (ids.isEmpty() && !malformedIds) flags.add("UNCITED");
            for (String id : ids) {
                Item item = known.get(id);
                if (item == null) {
                    flags.add("UNKNOWN_EVIDENCE_ID:" + printable(id));
                } else if (!offered.contains(id)) {
                    flags.add("EVIDENCE_NOT_OFFERED:" + id);
                } else if (!inRange(item, clock)) {
                    flags.add("EVIDENCE_OUT_OF_RANGE:" + id);
                }
            }
            List<String> safeIds = ids.stream().map(MediaDevGroundedEvidence::printable).toList();
            if (flags.isEmpty()) {
                grounded.add(new Claim("C" + grounded.size(), text, List.copyOf(new LinkedHashSet<>(ids))));
            } else {
                flagged.add(new Flagged(text.length() > MAX_CLAIM_CHARS ? text.substring(0, MAX_CLAIM_CHARS) : text,
                        safeIds, flags));
            }
        }
        String status;
        if (grounded.isEmpty()) status = "UNGROUNDED";
        else if (flagged.isEmpty()) status = "GROUNDED";
        else status = "PARTIALLY_GROUNDED";
        return new Answer(status, List.copyOf(grounded), List.copyOf(flagged), count);
    }

    private static String printable(String id) {
        String flat = id.replaceAll("[^A-Za-z0-9._:-]", "?");
        return flat.length() > 40 ? flat.substring(0, 40) : flat;
    }

    /** Time inside the source clock (with the documented tolerance) and, for boxes, inside the frame. */
    static boolean inRange(Item item, MediaDevGroundedClock clock) {
        if (item.startMicros() > item.endMicros()) return false;
        if (item.startMicros() < clock.containerStartMicros() - TIME_TOLERANCE_MICROS) return false;
        if (item.endMicros() > clock.containerEndMicros() + TIME_TOLERANCE_MICROS) return false;
        if (item.box() != null) {
            Frame frame = item.frame();
            Box box = item.box();
            if (frame == null || box.width() < 0 || box.height() < 0) return false;
            if (box.x() < -BOX_TOLERANCE_PX || box.y() < -BOX_TOLERANCE_PX
                    || box.x() + box.width() > frame.width() + BOX_TOLERANCE_PX
                    || box.y() + box.height() > frame.height() + BOX_TOLERANCE_PX) return false;
        }
        return true;
    }
}
