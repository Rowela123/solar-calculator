// Proxies a satellite image from MAPBOX (Google blocks satellite for EEA accounts).
// Stitches Mapbox 256-tiles at the given zoom, centered on lat/lng, to match the
// 256-convention projection used by roof.js. Uses sharp for compositing.

const sharp = require("sharp");

const IMG_SIZE = 640;
const SCALE = 2;
const IMG_PX = IMG_SIZE * SCALE;   // 1280
const TILE = 256;

function worldPx256(lat, lng, zoom) {
  const s = TILE * Math.pow(2, zoom);
  const x = s * (lng / 360 + 0.5);
  let siny = Math.sin((lat * Math.PI) / 180);
  siny = Math.min(Math.max(siny, -0.9999), 0.9999);
  const y = s * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI));
  return [x, y];
}

exports.handler = async (event) => {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: { "Content-Type": "text/plain" }, body: "NO_MAPBOX_TOKEN" };
  }
  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat), lng = parseFloat(q.lng);
  let zoom = parseInt(q.zoom, 10) || 19;
  if (zoom > 19) zoom = 19;   // Mapbox satellite tiles unreliable above 19
  if (isNaN(lat) || isNaN(lng)) {
    return { statusCode: 400, headers: { "Content-Type": "text/plain" }, body: "BAD_COORDS" };
  }

  try {
    // center in 256-world pixels; crop window is IMG_SIZE logical px (640) -> @2x device
    const [cwx, cwy] = worldPx256(lat, lng, zoom);
    const halfLogical = IMG_SIZE / 2;
    const left = cwx - halfLogical;
    const top = cwy - halfLogical;

    // pad by one tile each side so the crop window always fits the canvas
    const tx0 = Math.floor(left / TILE) - 1;
    const ty0 = Math.floor(top / TILE) - 1;
    const tx1 = Math.floor((left + IMG_SIZE) / TILE) + 1;
    const ty1 = Math.floor((top + IMG_SIZE) / TILE) + 1;

    const R = SCALE; // device scale (tiles fetched @2x = 512px)
    const canvasLogicalW = (tx1 - tx0 + 1) * TILE;
    const canvasLogicalH = (ty1 - ty0 + 1) * TILE;
    const canvasPxW = canvasLogicalW * R;
    const canvasPxH = canvasLogicalH * R;

    // fetch all tiles (@2x -> 512px each)
    const composites = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const url = `https://api.mapbox.com/v4/mapbox.satellite/${zoom}/${tx}/${ty}@2x.png?access_token=${token}`;
        const r = await fetch(url);
        if (!r.ok) {
          const t = await r.text();
          return { statusCode: 502, headers: { "Content-Type": "text/plain" }, body: `MAPBOX_${r.status}: ${t.slice(0,200)}` };
        }
        const buf = Buffer.from(await r.arrayBuffer());
        composites.push({ input: buf, left: (tx - tx0) * TILE * R, top: (ty - ty0) * TILE * R });
      }
    }

    // build the stitched canvas
    const stitched = await sharp({
      create: { width: canvasPxW, height: canvasPxH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).composite(composites).png().toBuffer();

    // crop to the exact window in device px
    let cl = Math.round((left - tx0 * TILE) * R);
    let ct = Math.round((top - ty0 * TILE) * R);
    // clamp so extract stays fully inside the canvas
    cl = Math.max(0, Math.min(cl, canvasPxW - IMG_PX));
    ct = Math.max(0, Math.min(ct, canvasPxH - IMG_PX));
    const final = await sharp(stitched)
      .extract({ left: cl, top: ct, width: IMG_PX, height: IMG_PX })
      .png()
      .toBuffer();

    return {
      statusCode: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      body: final.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return { statusCode: 502, headers: { "Content-Type": "text/plain" }, body: "STITCH_ERROR: " + String(e && e.message ? e.message : e) };
  }
};
