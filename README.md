# trackreel

Turn any `.gpx` GPS track into a cinematic **3D terrain flyover video (`MP4`)** and an **instant-loading static share page (`HTML`)** — built for hikes, runs, bike rides, and road trips.

**Design philosophy:** Do all the heavy 3D rendering offline at build time so viewers open a lightweight static page that plays immediately with zero 3D map engine overhead, zero tile API quotas, and full mobile compatibility.

## Features

- **Zero API keys required:** Uses free open-source [MapLibre GL JS](https://maplibre.org/), Esri World Imagery satellite tiles, and AWS Terrarium 3D DEM elevation tiles.
- **True 3D floating route tube:** Renders the GPS path as a smooth Three.js `TubeGeometry` floating slightly above the 3D terrain mesh — uniform width across steep ridges with natural terrain occlusion.
- **Stabilized cinematic camera:** Locks camera heading to the main route axis with gentle monotonic sweep and smoothed valley gliding (no motion-sickness whiplash on switchbacks).
- **Effort-based auto duration:** Automatically scales video length using Naismith-style effort distance ($\text{effort} = \text{distance}_{\text{km}} + \text{gain}_{\text{m}} / 100$) on a square-root curve (`min 15s`, no upper cap), unaffected by mid-activity rest stops.
- **Instant-loading static share page:** Single-activity `index.html` (~15 KB, zero external JS dependencies) with `faststart` H.264 MP4 playback, `1x / 1.5x / 2x` speed controls, and a click-to-seek SVG elevation profile synced to video playback.

## Prerequisites

- **Node.js** 18+
- **Google Chrome / Chromium** (auto-detected on macOS, Linux, and Windows, or pass `--chrome <path>`)
- **FFmpeg** on `PATH` (`brew install ffmpeg` or `sudo apt install ffmpeg`)

## Quick Start

```bash
npm install

# Optional: fetch the sample GPX track (Qixingshan, Yangmingshan, Taiwan)
npm run sample

# Render 3D flyover MP4 + static share page into dist/
node src/render.mjs sample/qixingshan.gpx \
  --out dist \
  --title "Qixingshan Main & East Peak Traverse"
```

## CLI Options

```text
Usage: trackreel <input.gpx> [options]

Options:
  --out <dir>              Output directory (default: dist)
  --title <text>           Activity title shown in video HUD and page header
  --duration <auto|sec>    Video duration in seconds, or "auto" (default: auto)
  --fps <num>              Rendered frames per second (default: 30)
  --width <px>             Video width in pixels, rounded to even (default: 1280)
  --height <px>            Video height in pixels, rounded to even (default: 720)
  --exaggeration <num>     3D terrain vertical exaggeration factor (default: 1.4)
  --interpolate-fps <num>  Optional FFmpeg motion interpolation target FPS (default: 0 / off)
  --chrome <path>          Explicit path to Chrome/Chromium executable
  -h, --help               Show this help message
```

### Auto Duration Formula

When `--duration auto` (the default) is used:

```text
effortKm = distanceKm + (elevationGainM / 100)
duration = max(15, round(8 + 7.5 * sqrt(effortKm)))
```

Examples:
- `2 km`, `+0 m` walk → `19s`
- `3.8 km`, `+464 m` mountain hike → `30s`
- `21 km`, `+100 m` half marathon → `43s`
- `16 km`, `+1400 m` summit day → `49s`

Viewers can always speed up playback on the static share page using the built-in `1x / 1.5x / 2x` controls.

## Output Structure (`dist/`)

- `index.html` — Self-contained static single-activity share page (embeds `meta.json` inline)
- `flyover.mp4` — H.264 (`yuv420p`, `+faststart`) MP4 optimized for instant mobile streaming
- `poster.jpg` — High-angle 3D terrain overview poster image
- `meta.json` — Computed activity stats and downsampled elevation profile

Deploy the `dist/` directory directly to **GitHub Pages**, **Cloudflare Pages**, **Netlify**, or **Vercel**, or embed it into a personal blog.

## License

MIT
