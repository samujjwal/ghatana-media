package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/** Process-local reference implementation for tests and isolated development only. */
public final class InMemoryProjectTimelineStore implements ProjectTimelineStore {
    private final Map<ProjectKey, Aggregate> projects = new HashMap<>();
    private final Map<RequestKey, CreateReceipt> requests = new HashMap<>();

    @Override
    public synchronized Created create(Actor actor, String workspaceId, String title, String requestId,
                                       String projectId, String initialRevisionId, String timelineId) {
        Objects.requireNonNull(actor, "actor");
        RequestKey requestKey = new RequestKey(actor.tenantId(), actor.principalId(), required(requestId, "requestId"));
        CreateReceipt prior = requests.get(requestKey);
        if (prior != null) {
            if (!prior.workspaceId.equals(workspaceId) || !prior.title.equals(title)) throw new IdempotencyConflictException();
            Aggregate original = projects.get(prior.projectKey);
            return new Created(prior.initialProject, original.revisions.get(prior.initialRevisionId), false);
        }
        ProjectKey key = new ProjectKey(actor.tenantId(), required(projectId, "projectId"));
        if (projects.containsKey(key)) throw new IllegalStateException("project identity already exists in tenant");
        Revision initial = new Revision(actor.tenantId(), projectId, initialRevisionId, null, Graph.empty(timelineId));
        Project project = new Project(actor.tenantId(), projectId, workspaceId, actor.principalId(), title, initialRevisionId);
        Aggregate aggregate = new Aggregate(project);
        aggregate.revisions.put(initial.revisionId(), initial);
        projects.put(key, aggregate);
        requests.put(requestKey, new CreateReceipt(key, workspaceId, title, project, initial.revisionId()));
        return new Created(project, initial, true);
    }

    @Override public synchronized Project project(Actor actor, String projectId) {
        return owned(actor, projectId).project;
    }

    @Override public synchronized Revision revision(Actor actor, String projectId, String revisionId) {
        Aggregate aggregate = owned(actor, projectId);
        Revision revision = aggregate.revisions.get(required(revisionId, "revisionId"));
        if (revision == null) throw new ProjectNotFoundException();
        return revision;
    }

    @Override public synchronized Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                                  String newRevisionId, Graph graph) {
        Objects.requireNonNull(graph, "graph");
        Aggregate aggregate = owned(actor, projectId);
        if (!aggregate.project.headRevisionId().equals(expectedHeadRevisionId)) {
            throw new RevisionConflictException(expectedHeadRevisionId, aggregate.project.headRevisionId());
        }
        Revision currentHead = aggregate.revisions.get(aggregate.project.headRevisionId());
        if (currentHead == null || !currentHead.graph().timelineId().equals(graph.timelineId())) {
            throw new IllegalArgumentException("timeline identity is immutable across project revisions");
        }
        String revisionId = required(newRevisionId, "newRevisionId");
        if (aggregate.revisions.containsKey(revisionId)) throw new IllegalStateException("revision identity cannot be reused");
        Revision revision = new Revision(aggregate.project.tenantId(), aggregate.project.projectId(), revisionId,
                aggregate.project.headRevisionId(), graph);
        aggregate.revisions.put(revisionId, revision);
        Project old = aggregate.project;
        aggregate.project = new Project(old.tenantId(), old.projectId(), old.workspaceId(), old.ownerPrincipalId(),
                old.title(), revisionId);
        return revision;
    }

    private Aggregate owned(Actor actor, String projectId) {
        Objects.requireNonNull(actor, "actor");
        Aggregate aggregate = projects.get(new ProjectKey(actor.tenantId(), required(projectId, "projectId")));
        if (aggregate == null) throw new ProjectNotFoundException();
        if (!aggregate.project.ownerPrincipalId().equals(actor.principalId())) throw new ProjectAccessDeniedException();
        return aggregate;
    }

    private record ProjectKey(String tenantId, String projectId) { }
    private record RequestKey(String tenantId, String principalId, String requestId) { }
    private record CreateReceipt(ProjectKey projectKey, String workspaceId, String title,
                                 Project initialProject, String initialRevisionId) { }
    private static final class Aggregate {
        private Project project;
        private final Map<String, Revision> revisions = new HashMap<>();
        private Aggregate(Project project) { this.project = project; }
    }
}
