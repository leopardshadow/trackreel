#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import * as turf from '@turf/turf';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP_TEXT = `Usage: trackreel <input.gpx> [options]

Options:
  --out <dir>              Output directory (default: dist)
  --title <text>           Activity title shown in video HUD and page header
  --duration <auto|sec>    Video duration in seconds, or "auto" (default: auto)
  --fps <num>              Rendered frames per second (default: 30)
  --width <px>             Video width in pixels, rounded to even (default: 1280)
  --height <px>            Video height in pixels, rounded to even (default: 720)
  --exaggeration <num>     3D terrain vertical exaggeration factor (default: 1.4)
  --interpolate-fps <num>  Optional FFmpeg motion interpolation target FPS (default: 0 / off)
  --workers <num>          Parallel headless Chrome workers for frame rendering (default: 1)
  --cache-dir <dir>        Frame cache directory for resumable rendering (default: <out>/.trackreel-cache)
  --start-frame <num>      Optional 0-based inclusive start frame for chunked rendering
  --end-frame <num>        Optional 0-based exclusive end frame for chunked rendering
  --no-resume              Clear existing frame cache before rendering
  --keep-frames            Keep cached JPEG frames after encoding MP4
  --chrome <path>          Explicit path to Chrome/Chromium executable
  -h, --help               Show this help message
`;

function detectChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);

  return candidates.find((p) => existsSync(p)) || null;
}

function requireArg(argv, i, flag) {
  if (i + 1 >= argv.length) {
    throw new Error(`Missing value for ${flag}`);
  }
  return argv[i + 1];
}

function parseArgs(argv) {
  const opts = {
    input: null,
    out: 'dist',
    duration: 'auto',
    fps: 30,
    width: 1280,
    height: 720,
    exaggeration: 1.4,
    title: null,
    interpolateFps: 0,
    workers: 1,
    cacheDir: null,
    startFrame: null,
    endFrame: null,
    resume: true,
    keepFrames: false,
    chromePath: null
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP_TEXT);
      process.exit(0);
    } else if (!arg.startsWith('-') && !opts.input) {
      opts.input = arg;
    } else if (arg === '--out') {
      opts.out = requireArg(argv, i++, arg);
    } else if (arg === '--duration') {
      const val = requireArg(argv, i++, arg);
      opts.duration = val === 'auto' ? 'auto' : Number(val);
    } else if (arg === '--fps') {
      opts.fps = Number(requireArg(argv, i++, arg));
    } else if (arg === '--interpolate-fps') {
      opts.interpolateFps = Number(requireArg(argv, i++, arg));
    } else if (arg === '--width') {
      opts.width = Number(requireArg(argv, i++, arg));
    } else if (arg === '--height') {
      opts.height = Number(requireArg(argv, i++, arg));
    } else if (arg === '--exaggeration') {
      opts.exaggeration = Number(requireArg(argv, i++, arg));
    } else if (arg === '--title') {
      opts.title = requireArg(argv, i++, arg);
    } else if (arg === '--workers') {
      opts.workers = Number(requireArg(argv, i++, arg));
    } else if (arg === '--cache-dir') {
      opts.cacheDir = requireArg(argv, i++, arg);
    } else if (arg === '--start-frame') {
      opts.startFrame = Number(requireArg(argv, i++, arg));
    } else if (arg === '--end-frame') {
      opts.endFrame = Number(requireArg(argv, i++, arg));
    } else if (arg === '--no-resume') {
      opts.resume = false;
    } else if (arg === '--keep-frames') {
      opts.keepFrames = true;
    } else if (arg === '--chrome') {
      opts.chromePath = requireArg(argv, i++, arg);
    } else {
      console.error(`Unknown argument: ${arg}\n`);
      console.error(HELP_TEXT);
      process.exit(1);
    }
  }

  if (!opts.input) {
    console.error(HELP_TEXT);
    process.exit(1);
  }

  if (!Number.isFinite(opts.width) || opts.width < 2 || !Number.isFinite(opts.height) || opts.height < 2) {
    throw new Error('--width and --height must be positive numbers >= 2');
  }
  if (!Number.isFinite(opts.fps) || opts.fps <= 0) {
    throw new Error('--fps must be a positive number');
  }
  if (!Number.isFinite(opts.exaggeration) || opts.exaggeration < 0) {
    throw new Error('--exaggeration must be a non-negative number');
  }
  if (!Number.isFinite(opts.interpolateFps) || opts.interpolateFps < 0) {
    throw new Error('--interpolate-fps must be a non-negative number');
  }
  if (!Number.isInteger(opts.workers) || opts.workers < 1) {
    throw new Error('--workers must be an integer >= 1');
  }
  if (opts.startFrame !== null && (!Number.isInteger(opts.startFrame) || opts.startFrame < 0)) {
    throw new Error('--start-frame must be a non-negative integer');
  }
  if (opts.endFrame !== null && (!Number.isInteger(opts.endFrame) || opts.endFrame < 1)) {
    throw new Error('--end-frame must be a positive integer');
  }
  if (opts.startFrame !== null && opts.endFrame !== null && opts.startFrame >= opts.endFrame) {
    throw new Error('--start-frame must be less than --end-frame');
  }
  if (opts.duration !== 'auto' && (!Number.isFinite(opts.duration) || opts.duration <= 0)) {
    throw new Error('--duration must be "auto" or a positive number');
  }

  opts.width = Math.max(2, Math.round(opts.width / 2) * 2);
  opts.height = Math.max(2, Math.round(opts.height / 2) * 2);

  return opts;
}

/**
 * Compute natural video duration from distance + elevation gain using
 * Naismith-style effort distance and a square-root curve (minimum 15s, no upper cap).
 */
function computeAutoDuration(distanceKm, elevationGainM) {
  const effortKm = Math.max(0.5, distanceKm + elevationGainM / 100);
  const raw = Math.round(8 + 7.5 * Math.sqrt(effortKm));
  return Math.max(15, raw);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeInlineJson(obj) {
  return JSON.stringify(obj).replaceAll('<', '\\u003c');
}

function frameFilename(index) {
  return `frame_${String(index).padStart(6, '0')}.jpg`;
}

function computeCacheFingerprint(params) {
  return crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
}

function splitIntoChunks(items, chunkCount) {
  const count = Math.max(1, Math.min(chunkCount, items.length));
  const chunks = Array.from({ length: count }, () => []);
  const baseSize = Math.floor(items.length / count);
  const remainder = items.length % count;
  let offset = 0;
  for (let c = 0; c < count; c++) {
    const size = baseSize + (c < remainder ? 1 : 0);
    chunks[c] = items.slice(offset, offset + size);
    offset += size;
  }
  return chunks.filter((ch) => ch.length > 0);
}

function parseGpx(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
  });
  const doc = parser.parse(xmlText);
  const gpx = doc.gpx;
  if (!gpx) throw new Error('Invalid GPX file: missing <gpx> root');

  const rawTitle =
    gpx.trk?.name ||
    (Array.isArray(gpx.trk) ? gpx.trk[0]?.name : null) ||
    gpx.metadata?.name ||
    '3D Track Flyover';

  const rawPoints = [];
  if (gpx.trk) {
    const trks = Array.isArray(gpx.trk) ? gpx.trk : [gpx.trk];
    for (const trk of trks) {
      const segs = Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg];
      for (const seg of segs) {
        if (!seg?.trkpt) continue;
        const pts = Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt];
        rawPoints.push(...pts);
      }
    }
  } else if (gpx.rte) {
    const rtes = Array.isArray(gpx.rte) ? gpx.rte : [gpx.rte];
    for (const rte of rtes) {
      if (!rte?.rtept) continue;
      const pts = Array.isArray(rte.rtept) ? rte.rtept : [rte.rtept];
      rawPoints.push(...pts);
    }
  }

  const points = rawPoints
    .map((p) => {
      const eleNum = Number(p.ele);
      return {
        lat: Number(p['@_lat']),
        lon: Number(p['@_lon']),
        ele: p.ele !== undefined && Number.isFinite(eleNum) ? eleNum : 0,
        time: p.time ? Date.parse(p.time) : null
      };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (points.length < 2) {
    throw new Error('GPX file contains fewer than 2 valid trackpoints');
  }

  return { title: String(rawTitle).trim(), points };
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function smoothCoords(coords, windowRadius) {
  const n = coords.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let lonSum = 0;
    let latSum = 0;
    let count = 0;
    const start = Math.max(0, i - windowRadius);
    const end = Math.min(n - 1, i + windowRadius);
    for (let j = start; j <= end; j++) {
      lonSum += coords[j][0];
      latSum += coords[j][1];
      count++;
    }
    out[i] = [lonSum / count, latSum / count];
  }
  return out;
}

function buildTrackData(points) {
  const cumDistKm = [0];
  let elevationGainM = 0;
  let elevationLossM = 0;
  let minEleM = Infinity;
  let maxEleM = -Infinity;

  // Use hysteresis (3m threshold) so high-frequency 1s GPS logs don't lose gradual climbs
  // while still filtering barometric/GPS altitude jitter.
  const eleThreshold = 3.0;
  let eleAnchor = points[0].ele;
  const cumGainM = [0];

  for (let i = 0; i < points.length; i++) {
    const ele = points[i].ele;
    if (ele < minEleM) minEleM = ele;
    if (ele > maxEleM) maxEleM = ele;
    if (i > 0) {
      const d = turf.distance(
        [points[i - 1].lon, points[i - 1].lat],
        [points[i].lon, points[i].lat],
        { units: 'kilometers' }
      );
      cumDistKm.push(cumDistKm[i - 1] + d);
      const diff = ele - eleAnchor;
      if (diff >= eleThreshold) {
        elevationGainM += diff;
        eleAnchor = ele;
      } else if (diff <= -eleThreshold) {
        elevationLossM += -diff;
        eleAnchor = ele;
      }
      cumGainM.push(elevationGainM);
    }
  }

  const totalDistKm = cumDistKm[cumDistKm.length - 1];
  if (totalDistKm <= 0) {
    throw new Error('GPX track has zero total distance (all trackpoints are identical)');
  }
  const lineCoords = points.map((p) => [p.lon, p.lat]);
  const line = turf.lineString(lineCoords);
  const bbox = turf.bbox(line);

  const firstTimePoint = points.find((p) => p.time !== null && Number.isFinite(p.time));
  const lastTimePoint = [...points].reverse().find((p) => p.time !== null && Number.isFinite(p.time));
  const hasTime = Boolean(firstTimePoint && lastTimePoint && lastTimePoint.time > firstTimePoint.time);
  const startTimeMs = firstTimePoint?.time ?? null;

  // Resample into 500 evenly spaced points for smooth camera & tube animation
  const sampleCount = 500;
  const resampledCoords = [];
  const resampledEles = [];
  const resampledDists = [];
  const resampledGains = [];
  const resampledElapsedSec = [];

  let origIdx = 0;
  for (let i = 0; i < sampleCount; i++) {
    const targetDist = (i / (sampleCount - 1)) * totalDistKm;
    const pt = turf.along(line, targetDist, { units: 'kilometers' });
    resampledCoords.push(pt.geometry.coordinates);
    resampledDists.push(targetDist);

    while (origIdx < cumDistKm.length - 2 && cumDistKm[origIdx + 1] < targetDist) {
      origIdx++;
    }
    const segLen = Math.max(1e-9, cumDistKm[origIdx + 1] - cumDistKm[origIdx]);
    const frac = Math.max(0, Math.min(1, (targetDist - cumDistKm[origIdx]) / segLen));
    const ele = points[origIdx].ele + (points[origIdx + 1].ele - points[origIdx].ele) * frac;
    const gain = cumGainM[origIdx] + (cumGainM[origIdx + 1] - cumGainM[origIdx]) * frac;
    resampledEles.push(ele);
    resampledGains.push(gain);

    if (hasTime) {
      const t0 = points[origIdx].time ?? startTimeMs;
      const t1 = points[origIdx + 1].time ?? t0;
      const interpMs = t0 + (t1 - t0) * frac;
      resampledElapsedSec.push(Math.max(0, (interpMs - startTimeMs) / 1000));
    } else {
      resampledElapsedSec.push(null);
    }
  }

  // Downsampled elevation profile (~120 points) for lightweight static SVG chart
  const profileCount = 120;
  const elevationProfile = [];
  for (let i = 0; i < profileCount; i++) {
    const idx = Math.round((i / (profileCount - 1)) * (sampleCount - 1));
    elevationProfile.push({
      dist: Number(resampledDists[idx].toFixed(3)),
      ele: Number(resampledEles[idx].toFixed(1))
    });
  }

  const firstTime = firstTimePoint?.time || Date.now();
  const lastTime = lastTimePoint?.time || firstTime;
  const durationSec = Math.max(0, (lastTime - firstTime) / 1000);
  const dObj = new Date(firstTime);
  const dateFormatted = dObj.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const dateDot = firstTimePoint
    ? `${dObj.getUTCFullYear()}.${String(dObj.getUTCMonth() + 1).padStart(2, '0')}.${String(dObj.getUTCDate()).padStart(2, '0')}`
    : '';

  return {
    totalDistKm,
    elevationGainM,
    elevationLossM,
    minEleM,
    maxEleM,
    durationSec,
    durationFormatted: formatDuration(durationSec),
    dateFormatted,
    dateDot,
    hasTime,
    bbox,
    resampledCoords,
    resampledEles,
    resampledDists,
    resampledGains,
    resampledElapsedSec,
    elevationProfile
  };
}

function buildCameraTimeline(track, totalFrames, trackFlyRatio = 0.88) {
  const {
    resampledCoords,
    resampledEles,
    resampledDists,
    resampledGains,
    resampledElapsedSec,
    totalDistKm,
    elevationGainM,
    durationSec,
    hasTime,
    bbox
  } = track;
  const n = resampledCoords.length;

  const baseZoom =
    totalDistKm < 2.5 ? 15.2 : totalDistKm < 6 ? 14.6 : totalDistKm < 15 ? 13.8 : 13.2;

  // Lock camera bearing to the overall route axis with a gentle monotonic sweep
  // so terrain stays rock-solid instead of spinning wildly on switchbacks.
  // For out-and-back or loop tracks (where start and end are close), aim toward the farthest point.
  const startCoord = resampledCoords[0];
  const endCoord = resampledCoords[n - 1];
  let farthestCoord = endCoord;
  let maxDistFromStart = 0;
  for (let i = 1; i < n; i++) {
    const d = turf.distance(startCoord, resampledCoords[i], { units: 'kilometers' });
    if (d > maxDistFromStart) {
      maxDistFromStart = d;
      farthestCoord = resampledCoords[i];
    }
  }
  const startToEndDist = turf.distance(startCoord, endCoord, { units: 'kilometers' });
  const axisTarget = startToEndDist < maxDistFromStart * 0.4 ? farthestCoord : endCoord;
  const mainBearing = turf.bearing(startCoord, axisTarget);

  const smoothCenters = smoothCoords(resampledCoords, Math.round(n * 0.18));
  const routeCenter = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

  const flyFrames = Math.max(2, Math.floor(totalFrames * trackFlyRatio));
  const outroFrames = Math.max(1, totalFrames - flyFrames);

  const frames = [];
  for (let f = 0; f < totalFrames; f++) {
    if (f < flyFrames) {
      const linearT = f / (flyFrames - 1);
      const p = linearT * 0.9 + easeInOutCubic(linearT) * 0.1;
      const idx = Math.min(n - 1, Math.max(1, Math.round(p * (n - 1))));
      const lookIdx = Math.min(n - 1, idx + Math.round(n * 0.04));
      const bearing = mainBearing - 10 + 18 * linearT;

      frames.push({
        progress: p,
        distKm: resampledDists[idx],
        gainM: resampledGains[idx],
        eleM: resampledEles[idx],
        elapsedSec: hasTime ? resampledElapsedSec[idx] : null,
        headCoord: resampledCoords[idx],
        camera: {
          center: smoothCenters[lookIdx],
          zoom: baseZoom,
          pitch: 62,
          bearing
        }
      });
    } else {
      // Smooth outro pull-back revealing the full terrain and complete route
      const outroT = easeInOutCubic((f - flyFrames + 1) / outroFrames);
      const endCenter = smoothCenters[n - 1];
      const endBearing = mainBearing + 8;

      const center = [
        endCenter[0] + (routeCenter[0] - endCenter[0]) * outroT,
        endCenter[1] + (routeCenter[1] - endCenter[1]) * outroT
      ];

      frames.push({
        progress: 1,
        distKm: totalDistKm,
        gainM: elevationGainM,
        eleM: resampledEles[n - 1],
        elapsedSec: hasTime ? durationSec : null,
        headCoord: resampledCoords[n - 1],
        camera: {
          center,
          zoom: baseZoom - 1.1 * outroT,
          pitch: 62 - 8 * outroT,
          bearing: endBearing + 8 * outroT
        }
      });
    }
  }

  return frames;
}

function startStaticServer(htmlContent) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

async function prepareCacheDir(cacheDir, fingerprint, resume) {
  const manifestPath = path.join(cacheDir, 'manifest.json');
  let validCache = false;

  if (resume && existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      if (existing.fingerprint === fingerprint) {
        validCache = true;
      }
    } catch {
      validCache = false;
    }
  }

  if (!validCache) {
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({ fingerprint }, null, 2), 'utf-8');
  }

  return validCache;
}

async function renderFrameChunk({
  workerId,
  frameIndices,
  capturePoster,
  chromePath,
  url,
  opts,
  title,
  track,
  timeline,
  cacheDir,
  outDir,
  onProgress
}) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        `--window-size=${opts.width},${opts.height}`
      ]
    });

    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1
    });

    page.on('pageerror', (err) => console.error(`[worker ${workerId}] Page error:`, err.message));

    await page.goto(url, { waitUntil: 'networkidle' });

    await page.evaluate(
      (cfg) => window.initMap(cfg),
      {
        title,
        dateDot: track.dateDot,
        hasTime: track.hasTime,
        exaggeration: opts.exaggeration,
        fullCoords: track.resampledCoords,
        initialCamera: timeline[frameIndices[0] ?? 0].camera
      }
    );

    if (capturePoster) {
      await page.evaluate(
        (bbox) =>
          window.renderOverview([
            [bbox[0], bbox[1]],
            [bbox[2], bbox[3]]
          ]),
        track.bbox
      );
      await page.screenshot({
        path: path.join(outDir, 'poster.jpg'),
        type: 'jpeg',
        quality: 90
      });
    }

    for (let k = 0; k < frameIndices.length; k++) {
      const idx = frameIndices[k];
      const frame = timeline[idx];
      await page.evaluate(
        (f) => window.renderFrame(f),
        { ...frame, idleTimeoutMs: k === 0 ? 6000 : 1200 }
      );
      const jpegBuf = await page.screenshot({ type: 'jpeg', quality: 90 });
      const finalPath = path.join(cacheDir, frameFilename(idx));
      const tmpPath = `${finalPath}.tmp`;
      await fs.writeFile(tmpPath, jpegBuf);
      await fs.rename(tmpPath, finalPath);
      onProgress();
    }
  } finally {
    if (browser) await browser.close();
  }
}

async function encodeFramesToMp4({ cacheDir, mp4Path, fps, interpolateFps }) {
  const vfArgs =
    interpolateFps > fps
      ? ['-vf', `minterpolate=fps=${interpolateFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`]
      : [];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-y',
        '-framerate', String(fps),
        '-start_number', '0',
        '-i', path.join(cacheDir, 'frame_%06d.jpg'),
        ...vfArgs,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'medium',
        '-crf', '21',
        '-movflags', '+faststart',
        mp4Path
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}:\n${stderr.slice(-1000)}`));
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const inputPath = path.resolve(opts.input);
  const outDir = path.resolve(opts.out);
  const cacheDir = path.resolve(opts.cacheDir || path.join(outDir, '.trackreel-cache'));
  await fs.mkdir(outDir, { recursive: true });

  const chromePath = opts.chromePath || detectChromeExecutable();
  if (!chromePath) {
    throw new Error(
      'Could not find Chrome/Chromium executable. Pass --chrome <path> or set CHROME_PATH.'
    );
  }

  console.log(`Reading GPX: ${inputPath}`);
  const xmlText = await fs.readFile(inputPath, 'utf-8');
  const parsed = parseGpx(xmlText);
  const title = opts.title || parsed.title;

  const track = buildTrackData(parsed.points);
  const resolvedDuration =
    opts.duration === 'auto'
      ? computeAutoDuration(track.totalDistKm, track.elevationGainM)
      : opts.duration;
  const effortKm = track.totalDistKm + track.elevationGainM / 100;
  console.log(
    `Track "${title}": ${track.totalDistKm.toFixed(2)} km, +${Math.round(track.elevationGainM)} m gain (effort ${effortKm.toFixed(1)} km) -> ${resolvedDuration}s video`
  );

  const totalFrames = Math.max(2, Math.round(resolvedDuration * opts.fps));
  const trackFlyRatio = 0.88;
  const timeline = buildCameraTimeline(track, totalFrames, trackFlyRatio);

  const gpxHash = crypto.createHash('sha256').update(xmlText).digest('hex').slice(0, 16);
  const fingerprint = computeCacheFingerprint({
    gpxHash,
    title,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    duration: resolvedDuration,
    exaggeration: opts.exaggeration,
    totalFrames
  });

  const resumed = await prepareCacheDir(cacheDir, fingerprint, opts.resume);
  const rangeStart = opts.startFrame ?? 0;
  const rangeEnd = Math.min(totalFrames, opts.endFrame ?? totalFrames);
  if (rangeStart >= rangeEnd) {
    throw new Error(`Invalid frame range [${rangeStart}, ${rangeEnd}) for totalFrames=${totalFrames}`);
  }

  const targetIndices = [];
  for (let i = rangeStart; i < rangeEnd; i++) {
    const framePath = path.join(cacheDir, frameFilename(i));
    if (!existsSync(framePath)) {
      targetIndices.push(i);
    }
  }

  const cachedInRange = rangeEnd - rangeStart - targetIndices.length;
  if (resumed && cachedInRange > 0) {
    console.log(`Resuming from cache: ${cachedInRange}/${rangeEnd - rangeStart} frames already rendered.`);
  }

  const posterPath = path.join(outDir, 'poster.jpg');
  const needPoster = !existsSync(posterPath) || !resumed;

  if (targetIndices.length > 0 || needPoster) {
    const rendererHtml = await fs.readFile(path.join(__dirname, 'renderer.html'), 'utf-8');
    const { server, url } = await startStaticServer(rendererHtml);
    try {
      const workerChunks =
        targetIndices.length > 0 ? splitIntoChunks(targetIndices, opts.workers) : [[]];
      console.log(
        `Rendering ${targetIndices.length} frames (${opts.width}x${opts.height}, ${workerChunks.length} worker${workerChunks.length > 1 ? 's' : ''})...`
      );

      let completed = cachedInRange;
      const rangeTotal = rangeEnd - rangeStart;
      const t0 = Date.now();
      const onProgress = () => {
        completed++;
        if (completed % 10 === 0 || completed === rangeTotal) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(
            `  Frame ${completed}/${rangeTotal} (${Math.round((completed / rangeTotal) * 100)}%) - ${elapsed}s`
          );
        }
      };

      await Promise.all(
        workerChunks.map((chunk, idx) =>
          renderFrameChunk({
            workerId: idx + 1,
            frameIndices: chunk,
            capturePoster: idx === 0 && needPoster,
            chromePath,
            url,
            opts,
            title,
            track,
            timeline,
            cacheDir,
            outDir,
            onProgress
          })
        )
      );
    } finally {
      server.close();
    }
  }

  // Check if all 0..totalFrames-1 frames are present before encoding final MP4
  let allPresent = true;
  for (let i = 0; i < totalFrames; i++) {
    if (!existsSync(path.join(cacheDir, frameFilename(i)))) {
      allPresent = false;
      break;
    }
  }

  if (!allPresent) {
    console.log(
      `\nChunk [${rangeStart}, ${rangeEnd}) cached in ${cacheDir}. Run remaining ranges to encode flyover.mp4.`
    );
    return;
  }

  const mp4Path = path.join(outDir, 'flyover.mp4');
  console.log(`Encoding ${totalFrames} cached frames into ${mp4Path}...`);
  await encodeFramesToMp4({
    cacheDir,
    mp4Path,
    fps: opts.fps,
    interpolateFps: opts.interpolateFps
  });

  if (!opts.keepFrames) {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }

  // Build meta.json and static index.html
  const meta = {
    title,
    dateFormatted: track.dateFormatted,
    distanceKm: Number(track.totalDistKm.toFixed(2)),
    elevationGainM: Math.round(track.elevationGainM),
    elevationLossM: Math.round(track.elevationLossM),
    minEleM: Math.round(track.minEleM),
    maxEleM: Math.round(track.maxEleM),
    durationFormatted: track.durationFormatted,
    trackFlyRatio,
    elevationProfile: track.elevationProfile
  };

  await fs.writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  const templateHtml = await fs.readFile(path.join(__dirname, 'template.html'), 'utf-8');
  const desc = `${title} · ${meta.distanceKm} km · +${meta.elevationGainM} m elevation gain · 3D terrain flyover`;
  const finalHtml = templateHtml
    .replaceAll('__PAGE_TITLE__', () => escapeHtml(title))
    .replaceAll('__PAGE_DESC__', () => escapeHtml(desc))
    .replace('__INLINE_META_JSON__', () => escapeInlineJson(meta));

  await fs.writeFile(path.join(outDir, 'index.html'), finalHtml, 'utf-8');

  const mp4Stat = await fs.stat(mp4Path);
  console.log(`\nDone! Static share page generated in: ${outDir}`);
  console.log(`  - index.html`);
  console.log(`  - flyover.mp4 (${(mp4Stat.size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  - poster.jpg`);
  console.log(`  - meta.json`);
}

export {
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
};

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
