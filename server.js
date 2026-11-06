'use strict';

/**
 * Big-file upload server. Zero dependencies, Node >= 18.15.
 *
 * Files arrive in fixed-size chunks that are written straight into a pre-allocated
 * temp file, so an upload survives a dropped connection, a closed tab or a server
 * restart. When every chunk is in, the temp file is moved into place atomically.
 *
 * Configuration (environment variables):
 *   PORT                3000          HOST                0.0.0.0
 *   UPLOAD_DIR          ./data        MAX_FILE_SIZE       53687091200 (50 GB)
 *   CHUNK_SIZE          8388608 (8 MB, allowed 64 KB .. 64 MB)
 *   BASIC_AUTH          "user:password" (optional, protects the whole site)
 *   STALE_UPLOAD_HOURS  24            (unfinished uploads older than this are deleted)
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

// ------------------------------------------------------------------ config

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const INCOMING_DIR = path.join(DATA_DIR, 'incoming');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 50 * 1024 ** 3;
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE) || 8 * 1024 ** 2;
const BASIC_AUTH = process.env.BASIC_AUTH || '';
const STALE_UPLOAD_MS = (Number(process.env.STALE_UPLOAD_HOURS) || 24) * 3600 * 1000;
const MAX_NAME_BYTES = 200;

if (!Number.isInteger(CHUNK_SIZE) || CHUNK_SIZE < 64 * 1024 || CHUNK_SIZE > 64 * 1024 ** 2) {
  console.error('CHUNK_SIZE must be an integer between 64 KB and 64 MB.');
  process.exit(1);
}

// ----------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

async function readJson(req, limit = 64 * 1024) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    parts.push(part);
  }
  if (!parts.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Turn a client-supplied name into a safe single path segment. */
function sanitizeName(raw) {
  let name = String(raw ?? '').normalize('NFC');
  name = name.split(/[\\/]/).pop(); // drop any directory part
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  name = name.replace(/^\.+/, ''); // no hidden files, no "..", no "."
  name = name.replace(/[. ]+$/, ''); // trailing dots/spaces confuse Windows
  if (!name) name = 'file';

  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    let ext = path.extname(name);
    if (Buffer.byteLength(ext) > 20) ext = '';
    let base = Array.from(name.slice(0, name.length - ext.length));
    while (base.length && Buffer.byteLength(base.join('') + ext) > MAX_NAME_BYTES) base.pop();
    name = (base.join('') || 'file') + ext;
  }
  return name;
}

function filePath(name) {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new HttpError(400, 'Invalid file name');
  }
  const full = path.join(FILES_DIR, name);
  if (path.dirname(full) !== FILES_DIR) throw new HttpError(400, 'Invalid file name');
  return full;
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'Malformed URL');
  }
}

function authorized(req) {
  if (!BASIC_AUTH) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(digest(given), digest(BASIC_AUTH));
}

// ---------------------------------------------------------- upload sessions

const ID_RE = /^[a-f0-9]{32}$/;
const partPath = (id) => path.join(INCOMING_DIR, `${id}.part`);
const metaPath = (id) => path.join(INCOMING_DIR, `${id}.json`);
const chunksPath = (id) => path.join(INCOMING_DIR, `${id}.chunks`);

/** id -> { meta, received: Set<number>, lastActivity, completing } */
const sessions = new Map();

function getSession(id) {
  const session = ID_RE.test(id) ? sessions.get(id) : undefined;
  if (!session) throw new HttpError(404, 'Upload not found');
  return session;
}

function describeSession(s) {
  const { id, name, size, chunkSize, total } = s.meta;
  return { id, name, size, chunkSize, total, received: [...s.received].sort((a, b) => a - b) };
}

function outstandingBytes() {
  let n = 0;
  for (const s of sessions.values()) {
    n += Math.max(0, s.meta.size - s.received.size * s.meta.chunkSize);
  }
  return n;
}

async function assertDiskSpace(bytes) {
  let free;
  try {
    const st = await fsp.statfs(DATA_DIR);
    free = st.bavail * st.bsize;
  } catch {
    return; // statfs not available here: skip the check
  }
  if (free < outstandingBytes() + bytes) {
    throw new HttpError(507, 'Not enough free disk space on the server');
  }
}

async function discardSession(id) {
  sessions.delete(id);
  await Promise.all(
    [partPath(id), metaPath(id), chunksPath(id)].map((p) => fsp.rm(p, { force: true })),
  );
}

async function loadSessions() {
  for (const entry of await fsp.readdir(INCOMING_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
      const stat = await fsp.stat(partPath(id));
      const received = new Set();
      const log = await fsp.readFile(chunksPath(id), 'utf8').catch(() => '');
      for (const line of log.split('\n')) {
        const n = Number(line);
        if (line !== '' && Number.isInteger(n) && n >= 0 && n < meta.total) received.add(n);
      }
      sessions.set(id, { meta, received, lastActivity: stat.mtimeMs, completing: false });
    } catch {
      await discardSession(id); // half-written leftovers
    }
  }
}

async function cleanupStale() {
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  for (const [id, s] of [...sessions]) {
    if (s.lastActivity < cutoff && !s.completing) await discardSession(id).catch(() => {});
  }
}

/** Link the finished file into FILES_DIR without ever overwriting an existing file. */
async function moveIntoPlace(src, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : `${base} (${n})${ext}`;
    try {
      await fsp.link(src, path.join(FILES_DIR, candidate));
      await fsp.unlink(src);
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new HttpError(500, 'Could not choose a unique file name');
}

// ------------------------------------------------------------------ routes

async function createUpload(req, res) {
  const body = await readJson(req);
  const size = body.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new HttpError(400, 'size must be a non-negative integer');
  }
  if (size > MAX_FILE_SIZE) {
    throw new HttpError(413, `File is larger than the ${formatBytes(MAX_FILE_SIZE)} limit`);
  }
  await assertDiskSpace(size);

  const id = crypto.randomBytes(16).toString('hex');
  const meta = {
    id,
    name: sanitizeName(body.name),
    size,
    chunkSize: CHUNK_SIZE,
    total: Math.ceil(size / CHUNK_SIZE),
    createdAt: new Date().toISOString(),
  };

  const handle = await fsp.open(partPath(id), 'w');
  try {
    await handle.truncate(size); // sparse pre-allocation, chunks land at their own offset
  } finally {
    await handle.close();
  }
  await fsp.writeFile(metaPath(id), JSON.stringify(meta));
  const session = { meta, received: new Set(), lastActivity: Date.now(), completing: false };
  sessions.set(id, session);
  sendJson(res, 201, describeSession(session));
}

function uploadStatus(res, id) {
  sendJson(res, 200, describeSession(getSession(id)));
}

async function abortUpload(res, id) {
  getSession(id);
  await discardSession(id);
  sendNoContent(res);
}

async function putChunk(req, res, id, indexText) {
  const session = getSession(id);
  const { size, chunkSize, total } = session.meta;
  if (!/^\d+$/.test(indexText)) throw new HttpError(400, 'Invalid chunk index');
  const index = Number(indexText);
  if (index >= total) throw new HttpError(400, 'Chunk index out of range');
  if (session.completing) throw new HttpError(409, 'Upload is already being finalized');

  const offset = index * chunkSize;
  const expected = Math.min(chunkSize, size - offset);

  // A chunk we already hold is immutable: drain the body and acknowledge.
  if (session.received.has(index)) {
    for await (const _ of req) {
      /* discard */
    }
    session.lastActivity = Date.now();
    return sendJson(res, 200, { index, duplicate: true, received: session.received.size, total });
  }

  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) !== expected) {
    throw new HttpError(400, `Chunk must be ${expected} bytes, got ${declared}`);
  }

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const piece of source) {
          bytes += piece.length;
          if (bytes > expected) throw new HttpError(413, 'Chunk is larger than expected');
          hash.update(piece);
          yield piece;
        }
      },
      fs.createWriteStream(partPath(id), { flags: 'r+', start: offset }),
    );
  } catch (err) {
    if (err.code === 'ENOSPC') throw new HttpError(507, 'The server is out of disk space');
    if (err.code === 'ENOENT') throw new HttpError(404, 'Upload not found');
    throw err;
  }

  if (bytes !== expected) throw new HttpError(400, `Chunk must be ${expected} bytes, got ${bytes}`);
  const wanted = String(req.headers['x-chunk-sha256'] || '').toLowerCase();
  if (wanted && wanted !== hash.digest('hex')) {
    throw new HttpError(422, 'Checksum mismatch, please resend the chunk');
  }

  if (!session.received.has(index)) {
    await fsp.appendFile(chunksPath(id), `${index}\n`);
    session.received.add(index);
  }
  session.lastActivity = Date.now();
  sendJson(res, 200, { index, received: session.received.size, total });
}

async function completeUpload(res, id) {
  const session = getSession(id);
  if (session.completing) throw new HttpError(409, 'Upload is already being finalized');

  const missing = [];
  for (let i = 0; i < session.meta.total && missing.length < 100; i++) {
    if (!session.received.has(i)) missing.push(i);
  }
  if (missing.length) {
    throw new HttpError(409, 'Some chunks have not arrived yet', { missing });
  }

  session.completing = true;
  try {
    const stat = await fsp.stat(partPath(id));
    if (stat.size !== session.meta.size) throw new HttpError(500, 'Stored size does not match');
    const stored = await moveIntoPlace(partPath(id), session.meta.name);
    sessions.delete(id);
    await Promise.all([
      fsp.rm(metaPath(id), { force: true }),
      fsp.rm(chunksPath(id), { force: true }),
    ]);
    sendJson(res, 200, {
      name: stored,
      size: session.meta.size,
      url: `/files/${encodeURIComponent(stored)}`,
    });
  } finally {
    session.completing = false;
  }
}

async function listFiles(res) {
  const entries = await fsp.readdir(FILES_DIR, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const st = await fsp.stat(path.join(FILES_DIR, entry.name));
      files.push({ name: entry.name, size: st.size, modified: st.mtime.toISOString() });
    } catch {
      /* removed while listing */
    }
  }
  files.sort((a, b) => b.modified.localeCompare(a.modified));
  sendJson(res, 200, { files });
}

async function serveDownload(req, res, name) {
  const file = filePath(name);
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (!st.isFile()) throw new HttpError(404, 'File not found');

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && st.size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, st.size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
    }
  }

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(name),
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
}

async function deleteFile(res, name) {
  try {
    await fsp.unlink(filePath(name));
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, 'File not found');
    throw err;
  }
  sendNoContent(res);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/uploader.js': ['uploader.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

async function serveStatic(req, res, [file, type]) {
  const data = await fsp.readFile(path.join(PUBLIC_DIR, file));
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean).map(decodeSegment);
  const method = req.method;

  if (method === 'GET' || method === 'HEAD') {
    const entry = STATIC[url.pathname];
    if (entry) return serveStatic(req, res, entry);
    if (url.pathname === '/api/config') {
      return sendJson(res, 200, { chunkSize: CHUNK_SIZE, maxFileSize: MAX_FILE_SIZE });
    }
    if (seg[0] === 'api' && seg[1] === 'files' && seg.length === 2) return listFiles(res);
    if (seg[0] === 'files' && seg.length === 2) return serveDownload(req, res, seg[1]);
  }

  if (seg[0] === 'api' && seg[1] === 'uploads') {
    const id = seg[2];
    if (seg.length === 2 && method === 'POST') return createUpload(req, res);
    if (id && seg.length === 3 && method === 'GET') return uploadStatus(res, id);
    if (id && seg.length === 3 && method === 'DELETE') return abortUpload(res, id);
    if (id && seg.length === 4 && seg[3] === 'complete' && method === 'POST') {
      return completeUpload(res, id);
    }
    if (id && seg.length === 5 && seg[3] === 'chunks' && method === 'PUT') {
      return putChunk(req, res, id, seg[4]);
    }
  }

  if (seg[0] === 'api' && seg[1] === 'files' && seg.length === 3 && method === 'DELETE') {
    return deleteFile(res, seg[2]);
  }

  throw new HttpError(404, 'Not found');
}

function handleError(req, res, err) {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  if (!req.complete) res.setHeader('Connection', 'close'); // don't reuse a half-read connection
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message, ...err.extra });
  } else {
    console.error(err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );

  if (!authorized(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Uploads", charset="UTF-8"',
      'Content-Type': 'application/json; charset=utf-8',
    });
    return res.end(JSON.stringify({ error: 'Authentication required' }));
  }
  route(req, res).catch((err) => handleError(req, res, err));
}

// -------------------------------------------------------------------- main

async function main() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  await fsp.mkdir(INCOMING_DIR, { recursive: true });
  await loadSessions();

  const server = http.createServer(handler);
  server.requestTimeout = 15 * 60 * 1000; // one chunk may take a while on a slow link
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 65 * 1000;

  setInterval(() => cleanupStale().catch(() => {}), 60 * 60 * 1000).unref();

  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const shown = addr.address === '0.0.0.0' || addr.address === '::' ? 'localhost' : addr.address;
    console.log(`Listening on http://${shown}:${addr.port}`);
    console.log(`Files are stored in ${FILES_DIR}`);
    if (!BASIC_AUTH) {
      console.log(
        'Note: BASIC_AUTH is not set, so anyone who can reach this server can upload and download.',
      );
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
