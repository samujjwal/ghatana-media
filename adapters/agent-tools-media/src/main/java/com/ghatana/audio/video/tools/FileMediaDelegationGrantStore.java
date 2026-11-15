/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeSet;
import java.util.stream.Stream;

/**
 * Single-host development grant store: one owner-only JSON file per grant, written by exclusive create and revoked by
 * an atomic replace. It holds no credential. It is the development stand-in for the Action Plane's delegation
 * registry (which this adapter does not own) and makes no multi-host claim.
 *
 * @doc.type class
 * @doc.purpose file-backed delegation grant store
 * @doc.layer product
 * @doc.pattern Repository
 */
public final class FileMediaDelegationGrantStore implements MediaDelegationGrantStore {

    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private final Path directory;

    public FileMediaDelegationGrantStore(Path directory) {
        Objects.requireNonNull(directory, "directory");
        try {
            this.directory = Files.createDirectories(directory,
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
                    .toRealPath();
        } catch (IOException failure) {
            throw new IllegalStateException("delegation grant directory is unavailable", failure);
        }
    }

    @Override
    public synchronized void issue(MediaDelegationGrant grant) {
        Path target = file(grant.grantId());
        try {
            write(grant, target, false);
        } catch (java.nio.file.FileAlreadyExistsException duplicate) {
            throw new IllegalStateException("delegation grant already exists");
        } catch (IOException failure) {
            throw new IllegalStateException("delegation grant could not be stored", failure);
        }
    }

    @Override
    public Optional<MediaDelegationGrant> find(String grantId) {
        Path target = file(grantId);
        if (!Files.isRegularFile(target, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return Optional.empty();
        try {
            return Optional.of(read(target));
        } catch (IOException | RuntimeException unreadable) {
            // A corrupt or unreadable record never becomes a live grant.
            throw new IllegalStateException("delegation grant record is unreadable");
        }
    }

    @Override
    public Optional<MediaDelegationGrant> findFor(String tenantId, String principalId, String agentId, String toolId) {
        List<MediaDelegationGrant> matching = new ArrayList<>();
        try (Stream<Path> files = Files.list(directory)) {
            for (Path candidate : (Iterable<Path>) files.filter(path -> path.getFileName().toString().endsWith(".json"))::iterator) {
                MediaDelegationGrant grant = read(candidate);
                if (grant.tenantId().equals(tenantId) && grant.principalId().equals(principalId)
                        && grant.agentId().equals(agentId) && grant.toolId().equals(toolId)) {
                    matching.add(grant);
                }
            }
        } catch (IOException | RuntimeException unreadable) {
            throw new IllegalStateException("delegation grants are unreadable");
        }
        return matching.stream().max(Comparator.comparing(MediaDelegationGrant::issuedAt)
                .thenComparing(MediaDelegationGrant::grantId));
    }

    @Override
    public synchronized boolean revoke(String grantId, Instant at) {
        Optional<MediaDelegationGrant> found = find(grantId);
        if (found.isEmpty() || found.get().isRevoked()) return false;
        try {
            write(found.get().revoked(at), file(grantId), true);
            return true;
        } catch (IOException failure) {
            throw new IllegalStateException("delegation grant could not be revoked", failure);
        }
    }

    private Path file(String grantId) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(grantId.getBytes(StandardCharsets.UTF_8));
            return directory.resolve(HexFormat.of().formatHex(digest) + ".json");
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private void write(MediaDelegationGrant grant, Path target, boolean replace) throws IOException {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("grantId", grant.grantId());
        view.put("tenantId", grant.tenantId());
        view.put("principalId", grant.principalId());
        view.put("agentId", grant.agentId());
        view.put("toolId", grant.toolId());
        view.put("operations", new TreeSet<>(grant.operations()));
        view.put("sourceArtifactIds", new TreeSet<>(grant.sourceArtifactIds()));
        view.put("issuedAt", grant.issuedAt().toString());
        view.put("expiresAt", grant.expiresAt().toString());
        view.put("revokedAt", grant.revokedAt() == null ? null : grant.revokedAt().toString());
        byte[] bytes = JSON.writeValueAsString(view).getBytes(StandardCharsets.UTF_8);
        if (!replace) {
            Files.write(target, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-------"));
            return;
        }
        Path staging = Files.createTempFile(directory, ".grant-", ".tmp",
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        try {
            Files.write(staging, bytes, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            try {
                Files.move(staging, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                throw new IOException("atomic replace is required for revocation", unsupported);
            }
        } finally {
            Files.deleteIfExists(staging);
        }
    }

    private static MediaDelegationGrant read(Path file) throws IOException {
        JsonNode node = JSON.readTree(Files.readAllBytes(file));
        java.util.Set<String> operations = new java.util.LinkedHashSet<>();
        node.path("operations").forEach(item -> operations.add(item.asString()));
        java.util.Set<String> sources = new java.util.LinkedHashSet<>();
        node.path("sourceArtifactIds").forEach(item -> sources.add(item.asString()));
        JsonNode revoked = node.path("revokedAt");
        return new MediaDelegationGrant(node.path("grantId").asString(), node.path("tenantId").asString(),
                node.path("principalId").asString(), node.path("agentId").asString(), node.path("toolId").asString(),
                operations, sources, Instant.parse(node.path("issuedAt").asString()),
                Instant.parse(node.path("expiresAt").asString()),
                revoked.isNull() || revoked.isMissingNode() ? null : Instant.parse(revoked.asString()));
    }
}
