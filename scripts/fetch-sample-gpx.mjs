import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  // Xiaoyoukeng -> Qixing Main Peak -> Qixing East Peak -> Lengshuikeng (Yangmingshan, Taiwan)
  const url =
    'https://router.project-osrm.org/route/v1/foot/121.5476,25.1766;121.5535,25.1707;121.5567,25.1695;121.5637,25.1665?overview=full&geometries=geojson';
  console.log('Fetching trail geometry from OSRM...');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const data = await res.json();
  const coords = data.routes[0].geometry.coordinates;
  console.log(`Fetched ${coords.length} points.`);

  // Query elevation from Open-Meteo in chunks of 100
  const elevations = [];
  for (let i = 0; i < coords.length; i += 100) {
    const chunk = coords.slice(i, i + 100);
    const lats = chunk.map((c) => c[1].toFixed(6)).join(',');
    const lons = chunk.map((c) => c[0].toFixed(6)).join(',');
    const eleRes = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`
    );
    if (eleRes.ok) {
      const eleJson = await eleRes.json();
      elevations.push(...eleJson.elevation);
    } else {
      for (let j = 0; j < chunk.length; j++) {
        const t = (i + j) / Math.max(1, coords.length - 1);
        elevations.push(800 + Math.sin(t * Math.PI) * 320);
      }
    }
  }

  const startMs = Date.parse('2026-11-22T07:30:00Z');
  const totalDurationSec = 2 * 3600 + 18 * 60;

  const trkpts = coords
    .map((c, idx) => {
      const t = idx / Math.max(1, coords.length - 1);
      const timeIso = new Date(startMs + t * totalDurationSec * 1000).toISOString();
      const ele = (elevations[idx] ?? 850).toFixed(1);
      return `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}"><ele>${ele}</ele><time>${timeIso}</time></trkpt>`;
    })
    .join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="trackreel-sample" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Qixingshan Main &amp; East Peak Traverse</name>
    <time>2026-11-22T07:30:00Z</time>
  </metadata>
  <trk>
    <name>Qixingshan Main &amp; East Peak Traverse (Yangmingshan, Taiwan)</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;

  await fs.mkdir(path.resolve('sample'), { recursive: true });
  await fs.writeFile(path.resolve('sample/qixingshan.gpx'), gpx, 'utf-8');
  console.log('Saved sample/qixingshan.gpx');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
