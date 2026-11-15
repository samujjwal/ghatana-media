#!/usr/bin/env node
// MED-09 installed-artifact check for the public Media STT profile contract.
// Compiles and runs a fresh consumer against runtime-contracts from a verified install set only.
// The fixture is synthetic and never admits a real provider or establishes model quality/rights.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MANIFEST_NAME, verifyInstallSet } from '../lib/media-install-set.mjs';

const installSet = process.argv[2] ?? process.env.MEDIA_INSTALL_SET;
if (!installSet) {
  console.error('usage: installed-stt-profile-consumer.mjs <verified-media-install-set>');
  process.exit(2);
}

const root = path.resolve(installSet);
const javaHome = process.env.JAVA_HOME;
const javac = javaHome ? path.join(javaHome, 'bin/javac') : 'javac';
const javaBin = javaHome ? path.join(javaHome, 'bin/java') : 'java';
const verification = verifyInstallSet(root);
if (!verification.ok) {
  for (const error of verification.errors) console.error(`REFUSED ${error}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_NAME), 'utf8'));
const runtime = manifest.mavenArtifacts.find((a) => a.groupId === 'com.ghatana.media' && a.artifactId === 'runtime-contracts');
const jarEntry = runtime?.files.find((f) => f.name.endsWith('.jar') && !f.name.endsWith('-sources.jar'));
if (!jarEntry) throw new Error('verified install set has no runtime-contracts binary jar');

const work = mkdtempSync(path.join(tmpdir(), 'media-installed-stt-profile-'));
const source = path.join(work, 'InstalledSttProfileConsumer.java');
const javaSource = String.raw`
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.MediaSttLanguageQualification;
import java.time.Instant;
import java.util.List;
import java.util.Set;

public final class InstalledSttProfileConsumer {
  private static final String DIGEST = "sha256:" + "a".repeat(64);
  private static final Instant NOW = Instant.parse("2026-11-15T12:00:00Z");
  private static int failures;

  private static void check(String name, boolean ok) {
    System.out.println((ok ? "PASS " : "FAIL ") + name);
    if (!ok) failures++;
  }

  private static MediaSpeechToTextAdmission.Profile profile(String version, String digest) {
    return new MediaSpeechToTextAdmission.Profile("media.stt.provider", "0.1.0",
      "whisper-ne", version, digest,
      MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
      Set.of("ne"), false,
      MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
      "synthetic://qualification-fixture");
  }

  public static void main(String[] args) {
    var selected = profile("profile-v3", DIGEST);
    var qualified = new MediaSttLanguageQualification.Entry("ne",
      MediaSttLanguageQualification.Status.QUALIFIED, "whisper-ne", "profile-v3", DIGEST,
      "synthetic://language-qualification-fixture", NOW.minusSeconds(60), NOW.plusSeconds(60));
    var registry = new MediaSttLanguageQualification.Registry(List.of(qualified));
    check("installed registry admits only its exact Nepali profile", registry.admits(selected, "ne", NOW));
    check("English does not inherit Nepali qualification", !registry.admits(selected, "en-US", NOW));
    check("profile version mismatch is refused", !registry.admits(profile("profile-v4", DIGEST), "ne", NOW));
    check("profile digest mismatch is refused", !registry.admits(profile("profile-v3", "sha256:" + "b".repeat(64)), "ne", NOW));
    check("qualification is not active before evaluatedAt", !registry.admits(selected, "ne", NOW.minusSeconds(61)));
    check("expired qualification is refused", !registry.admits(selected, "ne", NOW.plusSeconds(60)));
    check("empty installed registry admits no language", !MediaSttLanguageQualification.Registry.empty().admits(selected, "ne", NOW));
    var unqualified = new MediaSttLanguageQualification.Entry("ne",
      MediaSttLanguageQualification.Status.NOT_QUALIFIED, "whisper-ne", "profile-v3", DIGEST,
      "", NOW.minusSeconds(60), NOW.plusSeconds(60));
    check("NOT_QUALIFIED entry cannot enable a profile", !new MediaSttLanguageQualification.Registry(List.of(unqualified)).admits(selected, "ne", NOW));
    if (failures != 0) System.exit(1);
  }
}
`;

try {
  writeFileSync(source, javaSource);
  const jar = path.resolve(root, jarEntry.path);
  execFileSync(javac, ['-cp', jar, '-d', work, source], { stdio: 'inherit' });
  execFileSync(javaBin, ['-cp', `${jar}${path.delimiter}${work}`, 'InstalledSttProfileConsumer'], { stdio: 'inherit' });
  console.log('RESULT: PASS (installed Media contract only; synthetic qualification fixture, NOT provider admission)');
} finally {
  rmSync(work, { recursive: true, force: true });
}
