// Proxies the Google Static Maps satellite image so the API key never reaches the browser.
const ZOOM = 19, IMG_SIZE = 640, SCALE = 2;

exports.handler = async (event) => {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    return { statusCode: 500, headers: {"Content-Type":"text/plain"}, body: "NO_KEY" };
  }

  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat), lng = parseFloat(q.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return { statusCode: 400, headers: {"Content-Type":"text/plain"}, body: "BAD_COORDS" };
  }

  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}` +
              `&zoom=${ZOOM}&size=${IMG_SIZE}x${IMG_SIZE}&scale=${SCALE}` +
              `&maptype=satellite&key=${key}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      // surface Google's own error text so we can see WHY
      const errTxt = await r.text();
      return {
        statusCode: 502,
        headers: {"Content-Type":"text/plain"},
        body: `GOOGLE_${r.status}: ${errTxt.slice(0,300)}`,
      };
    }
    const arrayBuf = await r.arrayBuffer();
    const b64 = Buffer.from(arrayBuf).toString("base64");
    return {
      statusCode: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      body: b64,
      isBase64Encoded: true,
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: {"Content-Type":"text/plain"},
      body: "FETCH_THREW: " + String(e && e.message ? e.message : e),
    };
  }
};
