const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const FISHIAL_TOKEN = process.env.FISHIAL_API_KEY;

if (!FISHIAL_TOKEN) {
  console.error('FISHIAL_API_KEY environment variable is required');
  process.exit(1);
}

// ── Fishial API helpers ──────────────────────────────────────────────────────

function httpsReq(options, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function identifyFish(imageBuffer, filename, mimeType) {
  const md5 = crypto.createHash('md5').update(imageBuffer).digest('base64');

  // Step 1: get GCS signed upload URL
  const uploadBody = JSON.stringify({
    blob: { filename, contentType: mimeType, byteSize: imageBuffer.length, checksum: md5 },
    meta: { aiSpeciesMatching: true, fishNamingThreshold: 0.1 }
  });
  const step1 = await httpsReq({
    hostname: 'api.fishial.ai', path: '/v2/recognition/upload', method: 'POST',
    headers: {
      'Token': FISHIAL_TOKEN,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(uploadBody)
    }
  }, uploadBody);

  if (step1.status !== 200) {
    throw new Error(`Upload init failed: ${step1.status}`);
  }

  const { signedId, directUpload: { url: gcsUrl, headers: gcsHdrs } } = JSON.parse(step1.body);

  // Step 2: upload image to GCS
  // Content-Type must be '' (empty) – Fishial signs the URL with empty Content-Type
  const gcsU = new URL(gcsUrl);
  const step2 = await httpsReq({
    hostname: gcsU.hostname,
    path: gcsU.pathname + gcsU.search,
    method: 'PUT',
    headers: { 'Content-Type': '', ...gcsHdrs, 'Content-Length': imageBuffer.length }
  }, imageBuffer);

  if (step2.status !== 200) {
    throw new Error(`GCS upload failed: ${step2.status}`);
  }

  // Step 3: call recognition
  const step3 = await httpsReq({
    hostname: 'api.fishial.ai',
    path: `/v2/recognition/image?q=${encodeURIComponent(signedId)}`,
    method: 'GET',
    headers: { 'Token': FISHIAL_TOKEN }
  });

  if (step3.status !== 200) {
    throw new Error(`Recognition failed: ${step3.status}`);
  }

  return JSON.parse(step3.body);
}

// ── Multipart body parser ─────────────────────────────────────────────────────

function bufIndexOf(buf, search, offset = 0) {
  for (let i = offset; i <= buf.length - search.length; i++) {
    let ok = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function parseMultipart(body, contentType) {
  const m = contentType.match(/boundary=([^\s;]+)/);
  if (!m) throw new Error('No boundary');
  const sep = Buffer.from('--' + m[1]);
  let pos = 0;
  const parts = [];

  while (pos < body.length) {
    const bPos = bufIndexOf(body, sep, pos);
    if (bPos === -1) break;
    const hStart = bPos + sep.length + 2;
    const hEnd = bufIndexOf(body, Buffer.from('\r\n\r\n'), hStart);
    if (hEnd === -1) break;
    const headers = body.slice(hStart, hEnd).toString();
    const dStart = hEnd + 4;
    const next = bufIndexOf(body, sep, dStart);
    if (next === -1) break;
    const dEnd = next - 2;
    const nameM = headers.match(/name="([^"]+)"/);
    const fileM = headers.match(/filename="([^"]+)"/);
    const ctM   = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    if (nameM) parts.push({
      name: nameM[1],
      filename: fileM ? fileM[1] : null,
      mimeType: ctM ? ctM[1].trim() : 'application/octet-stream',
      data: body.slice(dStart, dEnd)
    });
    pos = next;
  }
  return parts;
}

// ── HTTP utils ────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
  res.end(data);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // POST /api/identify
  if (req.method === 'POST' && url.pathname === '/api/identify') {
    try {
      const ct = req.headers['content-type'] || '';
      if (!ct.startsWith('multipart/form-data')) {
        return sendJSON(res, 400, { error: 'Expected multipart/form-data' });
      }
      const body = await readBody(req);
      const parts = parseMultipart(body, ct);
      const file = parts.find(p => p.filename);
      if (!file) return sendJSON(res, 400, { error: 'No image file found' });

      const result = await identifyFish(file.data, file.filename, file.mimeType);

      const fishes = (result.results || []).map((fish, idx) => ({
        id: idx,
        detectionScore: fish.detectionScore,
        species: (fish.species || []).slice(0, 5).map(s => ({
          scientificName: s.name,
          commonName: s.fishanglerData?.title || s.name,
          commonNames: s.fishanglerData?.commonNames?.slice(0, 4) || [],
          accuracy: Math.round(s.accuracy * 100),
          photo: s.fishanglerData?.photo?.mediaUri || null,
          description: (s.fishanglerData?.description || '').slice(0, 300),
          distribution: (s.fishanglerData?.distribution || '').slice(0, 300),
          family: s.fishanglerData?.commonFamily || '',
          order: s.fishanglerData?.order || '',
        }))
      }));

      sendJSON(res, 200, { fishes, modelVersion: result.info?.classificationModelVersion });
    } catch (err) {
      console.error('[identify]', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // GET /  – main UI
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  // GET /viewer  – original 3D embedding viewer
  if (req.method === 'GET' && url.pathname === '/viewer') {
    sendFile(res, path.join(__dirname, 'static', 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Fish ID server on port ${PORT}`));
