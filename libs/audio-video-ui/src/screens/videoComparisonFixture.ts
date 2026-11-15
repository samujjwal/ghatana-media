// Test fixture: a small, complete comparison document (not a product asset; numbers are illustrative, not measured).
/** Reference + baseline (blurry/noisy) + candidate (better on most frames, worse on frame 3), 6 frames at 25 fps. */
export function sampleComparison(options: { reference?: boolean; sha?: { baseline?: string; candidate?: string } } = {}): Record<string, unknown> {
  const withReference = options.reference !== false;
  const basePsnr = [24.1, 24.0, 24.3, 24.2, 24.1, 24.0];
  const candPsnr = [27.2, 27.0, 27.4, 24.0, 27.1, 27.3];
  const baseSsim = [0.81, 0.8, 0.82, 0.81, 0.8, 0.81];
  const candSsim = [0.92, 0.91, 0.93, 0.8, 0.92, 0.92];
  const frames = (psnr: number[], ssim: number[], noise: number, lap: number) => psnr.map((p, i) => ({
    frameIndex: i, pts: i * 512, ptsMicros: i * 40_000, aligned: withReference,
    ...(withReference ? { psnrY: p, ssimY: ssim[i] } : {}), noiseSigmaY: noise + i * 0.01, laplacianVarianceY: lap + i,
  }));
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  const against = (psnr: number[], ssim: number[]) => withReference ? ({
    alignedFrames: 6, unalignedSubjectFrames: 0, unalignedReferenceFrames: 0, fullyAligned: true,
    meanPsnrY: mean(psnr), globalPsnrY: mean(psnr) - 0.1,
    minPsnrY: Math.min(...psnr), maxPsnrY: Math.max(...psnr), meanSsimY: mean(ssim), minSsimY: Math.min(...ssim), identicalFrames: 0,
  }) : undefined;
  const subject = (label: string, id: string, sha: string, psnr: number[], ssim: number[], noise: number, lap: number) => ({
    label, source: { artifactId: id, artifactVersionId: `sha256:${sha}`, sha256: sha, contentType: "video/mp4" },
    video: { width: 640, height: 360, frameCount: 6, timeBase: "1/12800" },
    noReference: { meanNoiseSigmaY: noise, meanLaplacianVarianceY: lap },
    ...(withReference ? { againstReference: against(psnr, ssim) } : {}),
    frames: frames(psnr, ssim, noise, lap),
  });
  const bSha = options.sha?.baseline ?? "b".repeat(64);
  const cSha = options.sha?.candidate ?? "c".repeat(64);
  return {
    schema: "media.dev.video-comparison.v1", scope: "DEV_ONLY", kind: "VIDEO_QUALITY_COMPARISON", requestId: "req-1",
    ...(withReference ? { reference: { artifactId: "ref-1", artifactVersionId: `sha256:${"a".repeat(64)}`, sha256: "a".repeat(64), contentType: "video/mp4" } } : {}),
    subjects: [subject("degraded", "src-b", bSha, basePsnr, baseSsim, 9.5, 120), subject("enhanced", "src-c", cSha, candPsnr, candSsim, 3.2, 150)],
    comparisons: [{
      subject: "enhanced", baseline: "degraded", verdict: withReference ? "IMPROVED" : "NO_REFERENCE",
      meanNoiseSigmaYDelta: -6.3, meanLaplacianVarianceYDelta: 30,
      ...(withReference ? { comparedFrames: 6, meanPsnrYDeltaDb: 2.5, meanSsimYDelta: 0.09, framesPsnrImproved: 5, framesPsnrRegressed: 1, framesSsimImproved: 5, framesSsimRegressed: 1 } : {}),
    }],
  };
}
