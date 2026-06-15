// Proxies the Google Static Maps satellite image so the API key never reaches the browser.
const ZOOM = 19, IMG_SIZE = 640, SCALE = 2;

exports.handler = async (event) => {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { statusCode: 500, body: "Missing key" };

  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat), lng = parseFloat(q.lng);
  if (isNaN(lat) || isNaN(lng)) return { statusCode: 400, body: "Bad coords" };

  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${ZOOM}&size=${IMG_SIZE}x${IMG_SIZE}&scale=${SCALE}&maptype=satellite&key=${key}`;

  try {
    const r = await fetch(url);
    if (!r.ok) return { statusCode: 502, body: "Image fetch failed" };
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      statusCode: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return { statusCode: 500, body: "Proxy error" };
  }
};
