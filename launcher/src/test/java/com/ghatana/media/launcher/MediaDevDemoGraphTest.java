package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevDemoGraph.Choice;
import com.ghatana.media.launcher.MediaDevDemoGraph.GraphException;
import com.ghatana.media.launcher.MediaDevDemoGraph.Node;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Structure rules of an authored branching demonstration; every refusal names the JSON path. */
class MediaDevDemoGraphTest {
    private static Node node(String id, Choice... choices) { return new Node(id, "Scene " + id, List.of(choices)); }

    private static Choice choice(String id, String to) { return new Choice(id, "Go " + id, to); }

    private static void refused(String start, List<Node> nodes, String code, String path) {
        assertThatThrownBy(() -> MediaDevDemoGraph.validate(start, nodes)).isInstanceOfSatisfying(GraphException.class,
                failure -> {
                    assertThat(failure.code()).isEqualTo(code);
                    assertThat(failure.path()).isEqualTo(path);
                });
    }

    @Test
    void aBranchingGraphWithALoopThatCanEndIsAccepted() {
        assertThatCode(() -> MediaDevDemoGraph.validate("intro", List.of(
                node("intro", choice("a", "left"), choice("b", "right")),
                node("left", choice("again", "intro"), choice("done", "end")),
                node("right", choice("done", "end")),
                node("end")))).doesNotThrowAnyException();
    }

    @Test
    void aDanglingEdgeNamesTheChoiceAndItsTarget() {
        refused("a", List.of(node("a", choice("x", "b"), choice("y", "nowhere")), node("b")),
                "EDGE_DANGLING", "nodes[0].choices[1].to");
    }

    @Test
    void anUnreachableNodeNamesTheNode() {
        refused("a", List.of(node("a"), node("b"), node("orphan")), "NODE_UNREACHABLE", "nodes[1]");
    }

    @Test
    void aCycleWithoutAnExitIsRefusedAndNamesAnOffendingNode() {
        refused("a", List.of(node("a", choice("go", "b")), node("b", choice("back", "a"))),
                "GRAPH_CYCLE_WITHOUT_EXIT", "nodes[0]");
        // a loop reachable from a branch that does have an ending is still refused for the trapped nodes
        refused("a", List.of(node("a", choice("x", "end"), choice("y", "trap")), node("end"),
                node("trap", choice("self", "trap"))), "GRAPH_CYCLE_WITHOUT_EXIT", "nodes[2]");
    }

    @Test
    void blankDuplicateAndUnknownStartAreRefusedWithPaths() {
        refused("a", List.of(new Node("a", "  ", List.of())), "LABEL_BLANK", "nodes[0].label");
        refused("a", List.of(node("a", new Choice("x", " ", "a"), choice("y", "a"))), "LABEL_BLANK", "nodes[0].choices[0].label");
        refused("a", List.of(node("a"), node("a")), "NODE_ID_DUPLICATE", "nodes[1].id");
        refused("a", List.of(node("a", choice("x", "a"), choice("x", "a"))), "CHOICE_ID_DUPLICATE", "nodes[0].choices[1].id");
        refused("a", List.of(node("a", new Choice("x", "Same", "b"), new Choice("y", "same", "b")), node("b")),
                "CHOICE_LABEL_DUPLICATE", "nodes[0].choices[1].label");
        refused("zzz", List.of(node("a")), "START_NODE_UNKNOWN", "startNodeId");
        refused("a", List.of(), "GRAPH_EMPTY", "nodes");
        refused("a", List.of(new Node("A B", "x", List.of())), "NODE_ID_INVALID", "nodes[0].id");
    }
}
