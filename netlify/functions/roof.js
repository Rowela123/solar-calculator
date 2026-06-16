// Netlify serverless function: address -> roof image URL + panel pixel data
// Google API key stays server-side. Satellite image comes from Mapbox (via sat.js)
// because Google blocks satellite imagery for EEA billing accounts.

const IMG_SIZE = 640;
const SCALE = 2;
const IMG_PX = IMG_SIZE * SCALE;   // 1280
const PANEL_KEEP = 0.70;

function worldPx(lat, lng, zoom) {
  const s = 256 * Math.pow(2, zoom);
  const x = s * (lng / 360 + 0.5);
  let siny = Math.sin((lat * Math.PI) / 180);
  siny = Math.min(Math.max(siny, -0.9999), 0.9999);
  const y = s * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI));
  return [x, y];
}

function latLngToImgPx(lat, lng, cLat, cLng, zoom) {
  const [wx, wy] = worldPx(lat, lng, zoom);
  const [cx, cy] = worldPx(cLat, cLng, zoom);
  const half = IMG_PX / 2;
  return [(wx - cx) * SCALE + half, (wy - cy) * SCALE + half];
}

function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom) / SCALE;
}

// Pick the largest zoom at which the building's bounding box fits ~85% of the frame.
function chooseZoom(bbox, lat) {
  const spanLatM = Math.abs(bbox.ne.latitude - bbox.sw.latitude) * 111320;
  const spanLngM = Math.abs(bbox.ne.longitude - bbox.sw.longitude) * 111320 * Math.cos((lat * Math.PI) / 180);
  const spanM = Math.max(spanLatM, spanLngM);
  if (spanM <= 0) return 19;
  const targetPx = IMG_PX * 0.85;
  for (const z of [20, 19, 18, 17, 16]) {
    const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z) / SCALE;
    if (spanM / mpp <= targetPx) return z;
  }
  return 16;
}

function rotatedRect(cx, cy, wPx, hPx, azimuthDeg) {
  const a = (azimuthDeg * Math.PI) / 180;
  const cosA = Math.cos(a), sinA = Math.sin(a);
  const hw = wPx / 2, hh = hPx / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return corners.map(([x, y]) => {
    const rx = x * cosA - y * sinA;
    const ry = x * sinA + y * cosA;
    return [Math.round((cx + rx) * 10) / 10, Math.round((cy + ry) * 10) / 10];
  });
}

exports.handler = async (event) => {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: "Server missing API key" }) };

  const address = ((event.queryStringParameters && event.queryStringParameters.address) || "").trim();
  if (!address) return { statusCode: 400, body: JSON.stringify({ error: "No address provided" }) };

  try {
    const geoR = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
    );
    const geo = await geoR.json();
    if (!geo.results || !geo.results.length) {
      return { statusCode: 404, body: JSON.stringify({ error: "Could not find that address" }) };
    }
    const loc = geo.results[0].geometry.location;

    const solR = await fetch(
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${loc.lat}&location.longitude=${loc.lng}&requiredQuality=HIGH&key=${key}`
    );
    if (solR.status === 404) {
      return { statusCode: 404, body: JSON.stringify({ error: "No solar data available for this building" }) };
    }
    const data = await solR.json();
    const sp = data.solarPotential;
    if (!sp || !sp.solarPanels) {
      return { statusCode: 404, body: JSON.stringify({ error: "No roof data available for this building" }) };
    }

    const panels = sp.solarPanels;
    const segments = sp.roofSegmentStats;
    const pw = sp.panelWidthMeters, ph = sp.panelHeightMeters;
    const capW = sp.panelCapacityWatts || 400;

    const bLat = data.center.latitude;
    const bLng = data.center.longitude;

    // auto-zoom so the whole building fits the frame
    const zoom = chooseZoom(data.boundingBox, bLat);
    const mpp = metersPerPixel(bLat, zoom);

    const keepN = Math.max(1, Math.floor(panels.length * PANEL_KEEP));
    const out = [];
    for (let i = 0; i < keepN; i++) {
      const p = panels[i];
      const seg = segments[p.segmentIndex] || {};
      const az = seg.azimuthDegrees || 0;
      const [wM, hM] = p.orientation === "LANDSCAPE" ? [ph, pw] : [pw, ph];
      const [cx, cy] = latLngToImgPx(p.center.latitude, p.center.longitude, bLat, bLng, zoom);
      const corners = rotatedRect(cx, cy, wM / mpp, hM / mpp, az);
      out.push([Math.round(p.yearlyEnergyDcKwh * 10) / 10,
                corners[0][0], corners[0][1], corners[1][0], corners[1][1],
                corners[2][0], corners[2][1], corners[3][0], corners[3][1]]);
    }

    // image proxied from Mapbox via sat.js; pass the zoom so it matches
    const imgUrl = `/.netlify/functions/sat?lat=${bLat}&lng=${bLng}&zoom=${zoom}`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
      body: JSON.stringify({
        address,
        center: { lat: bLat, lng: bLng },
        zoom,
        width: IMG_PX, height: IMG_PX,
        capW,
        maxPanels: panels.length,
        image: imgUrl,
        panels: out,
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Lookup failed", detail: String(e) }) };
  }
};
