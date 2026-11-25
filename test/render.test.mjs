import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  computeAutoDuration,
  escapeHtml,
  escapeInlineJson,
  frameFilename,
  computeCacheFingerprint,
  splitIntoChunks,
  prepareCacheDir,
  parseGpx,
  buildTrackData,
  buildCameraTimeline
} from '../src/render.mjs';

test('computeAutoDuration scales with effort distance and has 15s floor with no upper cap', () => {
  assert.equal(computeAutoDuration(0.5, 0), 15);
  assert.equal(computeAutoDuration(2, 0), 19);
  assert.equal(computeAutoDuration(3.84, 464), 30);
  assert.equal(computeAutoDuration(6.82, 554), 34);
  // Very long multi-day trek exceeds 60s (no upper cap)
  assert.ok(computeAutoDuration(80, 3000) > 60);
});

test('buildTrackData accurately sums gradual 1s high-frequency elevation gain while filtering jitter', () => {
  // Simulate 1,000 points climbing +0.25m per step (+250m total) plus +/-0.4m jitter
  const points = [];
  for (let i = 0; i <= 1000; i++) {
    const jitter = i % 2 === 0 ? 0.4 : -0.4;
    points.push({
      lat: 24.18 + i * 0.00002,
      lon: 121.28,
      ele: 3000 + i * 0.25 + jitter,
      time: Date.parse('2026-11-23T01:00:00Z') + i * 1000
    });
  }

  const track = buildTrackData(points);
  assert.ok(track.elevationGainM >= 245 && track.elevationGainM <= 255, `Expected ~250m gain, got ${track.elevationGainM}`);
  assert.equal(track.elevationLossM, 0);
  assert.equal(track.elevationProfile.length, 120);
  assert.equal(track.resampledCoords.length, 500);
});

test('buildTrackData rejects zero-distance GPX where all points are identical', () => {
  const points = [
    { lat: 25.0, lon: 121.5, ele: 100, time: 1000 },
    { lat: 25.0, lon: 121.5, ele: 105, time: 2000 }
  ];
  assert.throws(() => buildTrackData(points), /zero total distance/i);
});

test('buildCameraTimeline aims toward farthest summit on out-and-back tracks instead of start->end drift', () => {
  // Out-and-back going due North (~0 deg) 2km, ending slightly South-West of start
  const points = [];
  const half = 50;
  for (let i = 0; i <= half; i++) {
    points.push({ lat: 24.18 + (i / half) * 0.02, lon: 121.28, ele: 3000 + i * 8, time: i * 60000 });
  }
  for (let i = 1; i <= half; i++) {
    points.push({
      lat: 24.20 - (i / half) * 0.0205,
      lon: 121.28 - (i / half) * 0.0005,
      ele: 3400 - i * 8,
      time: (half + i) * 60000
    });
  }

  const track = buildTrackData(points);
  const timeline = buildCameraTimeline(track, 30, 0.88);
  // First frame bearing is mainBearing - 10; mainBearing should be ~0 deg (North), not ~-140 deg (SW)
  const initialBearing = timeline[0].camera.bearing;
  assert.ok(
    initialBearing > -25 && initialBearing < 15,
    `Expected camera aimed near North (~-10 deg), got ${initialBearing}`
  );
});

test('buildCameraTimeline aims start->end on point-to-point tracks', () => {
  // Point-to-point heading due East (~90 deg)
  const points = [
    { lat: 25.0, lon: 121.5, ele: 500, time: 0 },
    { lat: 25.0, lon: 121.52, ele: 700, time: 1800000 },
    { lat: 25.0, lon: 121.54, ele: 900, time: 3600000 }
  ];

  const track = buildTrackData(points);
  const timeline = buildCameraTimeline(track, 20, 0.88);
  // mainBearing ~90 deg -> initialBearing ~80 deg
  const initialBearing = timeline[0].camera.bearing;
  assert.ok(
    initialBearing > 70 && initialBearing < 90,
    `Expected camera aimed near East (~80 deg), got ${initialBearing}`
  );
});

test('parseGpx handles multiple <rte> elements, malformed <ele>, and missing timestamps', () => {
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
  <gpx version="1.1">
    <metadata><name>Multi-Route Test</name></metadata>
    <rte>
      <rtept lat="25.00" lon="121.50"><ele>N/A</ele></rtept>
      <rtept lat="25.01" lon="121.50"><ele>150</ele></rtept>
    </rte>
    <rte>
      <rtept lat="25.02" lon="121.50"><ele>220</ele></rtept>
    </rte>
  </gpx>`;

  const parsed = parseGpx(gpx);
  assert.equal(parsed.title, 'Multi-Route Test');
  assert.equal(parsed.points.length, 3);
  assert.equal(parsed.points[0].ele, 0);
  assert.equal(parsed.points[1].ele, 150);
  assert.equal(parsed.points[2].time, null);
});

test('escapeHtml and escapeInlineJson neutralize HTML and script-tag injection', () => {
  assert.equal(escapeHtml('<script>"a" & \'b\'</script>'), '&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;');
  const json = escapeInlineJson({ title: "</script><script>alert('x')</script> $& $'" });
  assert.ok(!json.includes('</script>'));
  assert.deepEqual(JSON.parse(json), { title: "</script><script>alert('x')</script> $& $'" });
});

test('parseArgs validates flags, rounds odd dimensions to even, and rejects missing/invalid values', () => {
  const opts = parseArgs(['node', 'render.mjs', 'in.gpx', '--width', '721', '--height', '405', '--duration', '20']);
  assert.equal(opts.input, 'in.gpx');
  assert.equal(opts.width, 722);
  assert.equal(opts.height, 406);
  assert.equal(opts.duration, 20);

  assert.throws(() => parseArgs(['node', 'render.mjs', 'in.gpx', '--out']), /Missing value for --out/);
  assert.throws(() => parseArgs(['node', 'render.mjs', 'in.gpx', '--width', 'abc']), /--width and --height/);
  assert.throws(() => parseArgs(['node', 'render.mjs', 'in.gpx', '--fps', '0']), /--fps/);
  assert.throws(() => parseArgs(['node', 'render.mjs', 'in.gpx', '--workers', '0']), /--workers/);
  assert.throws(() => parseArgs(['node', 'render.mjs', 'in.gpx', '--start-frame', '10', '--end-frame', '5']), /--start-frame must be less than --end-frame/);

  const chunkOpts = parseArgs([
    'node', 'render.mjs', 'in.gpx',
    '--workers', '3',
    '--start-frame', '0',
    '--end-frame', '100',
    '--no-resume',
    '--keep-frames'
  ]);
  assert.equal(chunkOpts.workers, 3);
  assert.equal(chunkOpts.startFrame, 0);
  assert.equal(chunkOpts.endFrame, 100);
  assert.equal(chunkOpts.resume, false);
  assert.equal(chunkOpts.keepFrames, true);
});

test('splitIntoChunks distributes frames evenly across workers', () => {
  const chunks = splitIntoChunks([0, 1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(chunks, [[0, 1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(splitIntoChunks([10, 11], 5), [[10], [11]]);
  assert.equal(frameFilename(42), 'frame_000042.jpg');
});

test('prepareCacheDir resumes matching fingerprint and invalidates stale cache', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trackreel-cache-test-'));
  try {
    const fpA = computeCacheFingerprint({ title: 'A', width: 960, totalFrames: 100 });
    const fpB = computeCacheFingerprint({ title: 'B', width: 960, totalFrames: 100 });

    const first = await prepareCacheDir(tmpRoot, fpA, true);
    assert.equal(first, false);
    await fs.writeFile(path.join(tmpRoot, frameFilename(0)), 'fake-jpeg');

    // Same fingerprint with resume=true keeps cached frame
    const second = await prepareCacheDir(tmpRoot, fpA, true);
    assert.equal(second, true);
    assert.equal(await fs.readFile(path.join(tmpRoot, frameFilename(0)), 'utf-8'), 'fake-jpeg');

    // Different fingerprint automatically invalidates stale frames
    const third = await prepareCacheDir(tmpRoot, fpB, true);
    assert.equal(third, false);
    await assert.rejects(() => fs.stat(path.join(tmpRoot, frameFilename(0))));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

