package com.ghatana.media.integration;

import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.audio.video.tools.FileMediaDelegationGrantStore;
import com.ghatana.audio.video.tools.MediaLauncherDelegate;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationLedger;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;

import java.net.URI;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Optional;

/**
 * Test-only child process of the J-25 IT: it is a REAL agent-tool host process that dispatches one invocation to the
 * launcher and is then killed ({@code Runtime.halt}, no shutdown hooks, no finally blocks) at a precise point:
 *
 * <ul>
 *   <li>{@code on-complete}: the launcher's response was received but the tool result was never recorded;</li>
 *   <li>{@code after-ms:N}: N milliseconds after dispatch started, while the launcher may still be working.</li>
 * </ul>
 *
 * Arguments: baseUrl tenant principal agent ledgerDir grantDir toolId invocationId artifactId version token mode.
 */
public final class MediaDevAgentDelegationWorker {
    private MediaDevAgentDelegationWorker() { }

    /** Delegating ledger that kills the process when the host tries to record the terminal result. */
    private static final class KillOnComplete implements InvocationLedger {
        private final InvocationLedger inner;
        KillOnComplete(InvocationLedger inner) { this.inner = inner; }
        @Override public Optional<LogicalAction> find(String id) { return inner.find(id); }
        @Override public void record(LogicalAction action) { inner.record(action); }
        @Override public ClaimResult claim(LogicalAction fence) { return inner.claim(fence); }
        @Override public boolean complete(LogicalAction terminal) {
            System.out.println("WORKER_KILLED_BEFORE_RECORDING_RESULT");
            System.out.flush();
            Runtime.getRuntime().halt(137);
            return false;
        }
    }

    public static void main(String[] args) throws Exception {
        URI base = URI.create(args[0]);
        String tenant = args[1];
        String principal = args[2];
        String agent = args[3];
        Path ledgerDir = Path.of(args[4]);
        Path grantDir = Path.of(args[5]);
        String toolId = args[6];
        String invocationId = args[7];
        String artifactId = args[8];
        String version = args[9];
        String token = args[10];
        String mode = args[11];

        var grants = new FileMediaDelegationGrantStore(grantDir);
        MediaLauncherDelegate delegate = MediaDevAgentDelegationSupport.delegate(base, grants,
                (grant, p) -> token);
        InvocationLedger ledger = MediaDevAgentDelegationSupport.ledger(ledgerDir);
        if ("on-complete".equals(mode)) ledger = new KillOnComplete(ledger);
        var binder = MediaDevAgentDelegationSupport.binder(ledger, delegate);
        var handler = MediaDevAgentDelegationSupport.factory(binder, delegate).createAuthenticated(toolId);
        ToolExecutionEnvelope envelope = MediaDevAgentDelegationSupport.envelope(toolId, invocationId, tenant, agent,
                artifactId, version);
        if (mode.startsWith("after-ms:")) {
            long millis = Long.parseLong(mode.substring("after-ms:".length()));
            Thread killer = new Thread(() -> {
                try { Thread.sleep(millis); } catch (InterruptedException ignored) { }
                System.out.println("WORKER_KILLED_MID_FLIGHT");
                System.out.flush();
                Runtime.getRuntime().halt(137);
            }, "worker-killer");
            killer.setDaemon(true);
            killer.start();
        }
        Eventloop eventloop = Eventloop.builder().withCurrentThread().build();
        Promise<ToolExecutionResult> promise = handler.handle(envelope, MediaDevAgentDelegationSupport.contract(envelope),
                new AuthenticatedPrincipal(tenant, principal, Instant.now()));
        promise.whenComplete((result, failure) -> {
            System.out.println("WORKER_FINISHED "
                    + (failure == null ? result.status() : failure.getClass().getSimpleName()));
            for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
                System.out.println("WORKER_CAUSE " + cause);
            }
        });
        eventloop.run();
    }
}
