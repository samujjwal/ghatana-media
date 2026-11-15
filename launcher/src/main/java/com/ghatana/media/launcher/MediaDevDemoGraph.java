package com.ghatana.media.launcher;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Structural validation of an authored branching demonstration: nodes (scenes) joined by labelled choices. Every refusal
 * names the JSON path of the offending element ({@code nodes[2].choices[0].to}) so an author can fix it.
 *
 * <p>Rules: 1..{@value #MAX_NODES} nodes with unique ids and non-blank labels; at most {@value #MAX_CHOICES} choices per
 * node with ids and labels unique inside the node (two identical labels would be indistinguishable to a screen reader);
 * the start node and every choice target exist; every node is reachable from the start node; and every reachable node can
 * reach an exit (a node with no choices), so a cycle is allowed only while it has a way out - a path that can never end
 * is refused as {@code GRAPH_CYCLE_WITHOUT_EXIT}.</p>
 */
final class MediaDevDemoGraph {
    static final int MAX_NODES = 32;
    static final int MAX_CHOICES = 8;
    static final int MAX_LABEL = 120;
    static final Pattern ID = Pattern.compile("[a-z0-9][a-z0-9_-]{0,31}");

    private MediaDevDemoGraph() { }

    record Choice(String id, String label, String to) { }

    record Node(String id, String label, List<Choice> choices) { }

    /** A typed 422 with the path of the offending element. */
    static final class GraphException extends IllegalArgumentException {
        private final String code;
        private final String path;

        GraphException(String code, String path, String message) {
            super(message);
            this.code = code;
            this.path = path;
        }

        String code() { return code; }
        String path() { return path; }
    }

    static void validate(String startNodeId, List<Node> nodes) {
        if (nodes == null || nodes.isEmpty()) throw new GraphException("GRAPH_EMPTY", "nodes", "a demonstration needs at least one node");
        if (nodes.size() > MAX_NODES) {
            throw new GraphException("GRAPH_TOO_LARGE", "nodes", "at most " + MAX_NODES + " nodes are supported");
        }
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < nodes.size(); i++) {
            Node node = nodes.get(i);
            String base = "nodes[" + i + "]";
            if (node.id() == null || !ID.matcher(node.id()).matches()) {
                throw new GraphException("NODE_ID_INVALID", base + ".id", "a node id is 1-32 characters of a-z, 0-9, _ or -");
            }
            if (index.put(node.id(), i) != null) {
                throw new GraphException("NODE_ID_DUPLICATE", base + ".id", "node id '" + node.id() + "' is used twice");
            }
            requireLabel(node.label(), base + ".label");
            if (node.choices() == null) throw new GraphException("CHOICES_REQUIRED", base + ".choices", "choices must be an array");
            if (node.choices().size() > MAX_CHOICES) {
                throw new GraphException("TOO_MANY_CHOICES", base + ".choices", "at most " + MAX_CHOICES + " choices per node");
            }
            Set<String> ids = new HashSet<>();
            Set<String> labels = new HashSet<>();
            for (int j = 0; j < node.choices().size(); j++) {
                Choice choice = node.choices().get(j);
                String path = base + ".choices[" + j + "]";
                if (choice.id() == null || !ID.matcher(choice.id()).matches()) {
                    throw new GraphException("CHOICE_ID_INVALID", path + ".id", "a choice id is 1-32 characters of a-z, 0-9, _ or -");
                }
                if (!ids.add(choice.id())) {
                    throw new GraphException("CHOICE_ID_DUPLICATE", path + ".id", "choice id '" + choice.id() + "' is used twice in this node");
                }
                requireLabel(choice.label(), path + ".label");
                if (!labels.add(choice.label().trim().toLowerCase(java.util.Locale.ROOT))) {
                    throw new GraphException("CHOICE_LABEL_DUPLICATE", path + ".label",
                            "two choices of one node have the same label");
                }
            }
        }
        if (startNodeId == null || !index.containsKey(startNodeId)) {
            throw new GraphException("START_NODE_UNKNOWN", "startNodeId", "the start node is not one of the nodes");
        }
        for (int i = 0; i < nodes.size(); i++) {
            for (int j = 0; j < nodes.get(i).choices().size(); j++) {
                Choice choice = nodes.get(i).choices().get(j);
                if (choice.to() == null || !index.containsKey(choice.to())) {
                    throw new GraphException("EDGE_DANGLING", "nodes[" + i + "].choices[" + j + "].to",
                            "the choice leads to a node that does not exist");
                }
            }
        }
        boolean[] reachable = new boolean[nodes.size()];
        ArrayDeque<Integer> pending = new ArrayDeque<>();
        reachable[index.get(startNodeId)] = true;
        pending.add(index.get(startNodeId));
        while (!pending.isEmpty()) {
            int at = pending.poll();
            for (Choice choice : nodes.get(at).choices()) {
                int to = index.get(choice.to());
                if (!reachable[to]) {
                    reachable[to] = true;
                    pending.add(to);
                }
            }
        }
        for (int i = 0; i < nodes.size(); i++) {
            if (!reachable[i]) {
                throw new GraphException("NODE_UNREACHABLE", "nodes[" + i + "]",
                        "node '" + nodes.get(i).id() + "' cannot be reached from the start node");
            }
        }
        // nodes that can reach an exit (a node without choices), by a reverse walk from the exits
        List<List<Integer>> incoming = new ArrayList<>();
        for (int i = 0; i < nodes.size(); i++) incoming.add(new ArrayList<>());
        for (int i = 0; i < nodes.size(); i++) {
            for (Choice choice : nodes.get(i).choices()) incoming.get(index.get(choice.to())).add(i);
        }
        boolean[] exits = new boolean[nodes.size()];
        for (int i = 0; i < nodes.size(); i++) {
            if (nodes.get(i).choices().isEmpty()) {
                exits[i] = true;
                pending.add(i);
            }
        }
        while (!pending.isEmpty()) {
            int at = pending.poll();
            for (int from : incoming.get(at)) {
                if (!exits[from]) {
                    exits[from] = true;
                    pending.add(from);
                }
            }
        }
        for (int i = 0; i < nodes.size(); i++) {
            if (!exits[i]) {
                throw new GraphException("GRAPH_CYCLE_WITHOUT_EXIT", "nodes[" + i + "]",
                        "node '" + nodes.get(i).id() + "' is on a path that can never reach an ending");
            }
        }
    }

    private static void requireLabel(String label, String path) {
        if (label == null || label.isBlank()) throw new GraphException("LABEL_BLANK", path, "a label must not be blank");
        if (label.length() > MAX_LABEL) throw new GraphException("LABEL_TOO_LONG", path, "a label is at most " + MAX_LABEL + " characters");
        for (int i = 0; i < label.length(); i++) {
            if (Character.isISOControl(label.charAt(i))) {
                throw new GraphException("LABEL_INVALID", path, "a label must not contain control characters");
            }
        }
    }
}
