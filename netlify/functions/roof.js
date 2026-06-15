// Netlify serverless function: address -> roof image URL + panel pixel data
// The Google API key is read from a secret env var (GOOGLE_API_KEY), never sent to the browser.

const ZOOM = 19;
const IMG_SIZE = 640;     // static maps tile size before scale
const SCALE = 2;          // -> 1280x1280 final
const IMG_PX = IMG_SIZE * SCALE;
const PANEL_KEEP = 0.70;  // export up to 70% of panels; calculator narrows per bill

function worldPx(lat, lng, zoom) {
  const s = 256 * Math.pow(2, zoom);
  const x = s * (lng / 360 + 0.5);
  let siny = Math.sin((lat * Math.PI) / 180);
  siny = Math.min(Math.max(siny, -0.9999), 0.9999);
  const y = s * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI));
  return [x, y];
}

function latLngToImgPx(lat, lng, cLat, cLng) {
  const [wx, wy] = worldPx(lat, lng, ZOOM);
  const [cx, cy] = worldPx(cLat, cLng, ZOOM);
  const half = IMG_PX / 2;
  return [(wx - cx) * SCALE + half, (wy - cy) * SCALE + half];
}

function metersPerPixel(lat) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, ZOOM) / SCALE;
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
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server missing API key" }) };
  }

  const address = (event.queryStringParameters && event.queryStringParameters.address || "").trim();
  if (!address) {
    return { statusCode: 400, body: JSON.stringify({ error: "No address provided" }) };
  }

  try {
    // 1. Geocode
    const geoR = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
    );
    const geo = await geoR.json();
    if (!geo.results || !geo.results.length) {
      return { statusCode: 404, body: JSON.stringify({ error: "Could not find that address" }) };
    }
    const loc = geo.results[0].geometry.location;

    // 2. Building insights (Solar API)
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

    const panels = sp.solarPanels;        // pre-sorted best-first
    const segments = sp.roofSegmentStats;
    const pw = sp.panelWidthMeters, ph = sp.panelHeightMeters;
    const capW = sp.panelCapacityWatts || 400;

    const bLat = data.center.latitude;
    const bLng = data.center.longitude;
    const mpp = metersPerPixel(bLat);

    const keepN = Math.max(1, Math.floor(panels.length * PANEL_KEEP));
    const out = [];
    for (let i = 0; i < keepN; i++) {
      const p = panels[i];
      const seg = segments[p.segmentIndex] || {};
      const az = seg.azimuthDegrees || 0;
      const [wM, hM] = p.orientation === "LANDSCAPE" ? [ph, pw] : [pw, ph];
      const [cx, cy] = latLngToImgPx(p.center.latitude, p.center.longitude, bLat, bLng);
      const corners = rotatedRect(cx, cy, wM / mpp, hM / mpp, az);
      out.push([Math.round(p.yearlyEnergyDcKwh * 10) / 10,
                corners[0][0], corners[0][1], corners[1][0], corners[1][1],
                corners[2][0], corners[2][1], corners[3][0], corners[3][1]]);
    }

    // 3. Satellite image URL (signed with key) - returned for the browser to load.
    // Note: this URL contains the key. To avoid exposing it, we proxy the image instead (see image endpoint).
    const imgUrl = `/.netlify/functions/sat?lat=${bLat}&lng=${bLng}`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
      body: JSON.stringify({
        address,
        center: { lat: bLat, lng: bLng },
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
