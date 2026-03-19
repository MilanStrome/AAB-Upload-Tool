#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          Play Release Manager — Local Proxy Server           ║
 * ║                                                              ║
 * ║  Zero npm dependencies — uses only Node.js built-ins.        ║
 * ║  Requires Node.js 18+ (for native fetch / AbortSignal).      ║
 * ║                                                              ║
 * ║  Start:  node server.js                                      ║
 * ║  Port:   7842  (http://localhost:7842)                       ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * HOW IT WORKS
 * ────────────
 * The browser cannot upload large binary files directly to the
 * Google Play Developer API because:
 *   1. CORS blocks binary XHR/fetch from browsers
 *   2. btoa() / ArrayBuffer blow the JS heap for files > ~300 MB
 *
 * This server acts as a thin local proxy:
 *   Browser  →  POST /upload (multipart form, streams the file)
 *            →  server initiates a Google resumable upload session
 *            →  streams the file to Google in 8 MB chunks
 *            →  returns the Google JSON response to the browser
 *
 * The file is NEVER fully loaded into memory — it is piped in
 * chunks from the incoming request directly into the outgoing
 * Google upload stream.  Works for files of any size.
 *
 * ROUTES
 * ──────
 *  GET  /ping    Health check — returns {"ok":true}
 *  POST /upload  Main proxy upload endpoint
 */

'use strict';

const http  = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// ── Configuration ────────────────────────────────────────────────
const PORT          = 7842;
const CHUNK_SIZE    = 8 * 1024 * 1024;   // 8 MB — Google's minimum recommended chunk
const MAX_RETRIES   = 3;                  // retry failed chunks this many times
const RETRY_DELAY   = 2000;              // ms between retries

// Google Play upload API base (same endpoint the HTML was calling)
const GOOGLE_UPLOAD_HOST = 'androidpublisher.googleapis.com';

// CORS origins allowed — localhost only (internal tool)
const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'null',  // file:// pages send Origin: null
];

// ── Helpers ──────────────────────────────────────────────────────

/** Send a JSON response */
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(json);
}

/** Log with timestamp */
function log(level, ...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

/** Sleep for ms milliseconds */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Parse a multipart/form-data request into fields and one file stream.
 *
 * Returns a Promise that resolves to:
 *   { fields: { key: value, … }, fileStream, fileName, fileSize }
 *
 * The fileStream is a PassThrough stream that receives the raw file bytes.
 * We parse headers and text fields synchronously as we scan the incoming
 * buffer, and pipe file bytes directly — no temp files, no full buffering.
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return reject(new Error('No multipart boundary found'));

    const boundary    = Buffer.from('--' + boundaryMatch[1]);
    const finalBound  = Buffer.from('--' + boundaryMatch[1] + '--');
    const CRLF        = Buffer.from('\r\n');
    const CRLFCRLF    = Buffer.from('\r\n\r\n');

    const fields = {};
    let   fileStream = null;
    let   fileName   = '';
    let   fileSize   = parseInt(req.headers['content-length'] || '0', 10);

    // We accumulate chunks until we find each boundary, then process parts.
    // For the file part we pipe directly to fileStream without buffering.
    let   buf          = Buffer.alloc(0);
    let   inFilePart   = false;
    let   resolved     = false;

    // PassThrough-like: we create a simple push stream for the file data
    const { PassThrough } = require('node:stream');
    const pt = new PassThrough();

    function tryResolve() {
      if (!resolved && fileStream) {
        resolved = true;
        resolve({ fields, fileStream, fileName, fileSize });
      }
    }

    req.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);

      // Keep processing as long as we can find boundaries
      while (true) {
        if (!inFilePart) {
          // Look for a boundary
          const bIdx = indexOf(buf, boundary);
          if (bIdx === -1) break; // need more data

          // Skip past boundary + CRLF
          let pos = bIdx + boundary.length;
          if (buf[pos] === 0x0d && buf[pos+1] === 0x0a) pos += 2;
          else if (buf[pos] === 0x2d && buf[pos+1] === 0x2d) break; // final boundary

          // Read headers of this part
          const headerEnd = indexOf(buf, CRLFCRLF, pos);
          if (headerEnd === -1) break; // need more data

          const rawHeaders = buf.slice(pos, headerEnd).toString('utf8');
          const bodyStart  = headerEnd + 4;

          // Parse Content-Disposition
          const dispMatch = rawHeaders.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
          const nameAttr  = dispMatch ? dispMatch[1] : '';
          const fileMatch = rawHeaders.match(/filename="([^"]+)"/i);

          if (fileMatch) {
            // This is the file part
            fileName   = fileMatch[1];
            fileStream = pt;
            inFilePart = true;
            buf = buf.slice(bodyStart);
            tryResolve();
            // fall through to inFilePart handler below
          } else {
            // Text field — find end of value (next boundary)
            const nextB = indexOf(buf, boundary, bodyStart);
            if (nextB === -1) break; // need more data
            // Value is from bodyStart to nextB minus CRLF
            let valEnd = nextB;
            if (buf[valEnd-2] === 0x0d && buf[valEnd-1] === 0x0a) valEnd -= 2;
            fields[nameAttr] = buf.slice(bodyStart, valEnd).toString('utf8');
            buf = buf.slice(nextB); // reprocess from next boundary
          }
        }

        if (inFilePart) {
          // Look for closing boundary in current buffer
          const bIdx = indexOf(buf, boundary);
          if (bIdx !== -1) {
            // Write everything before the CRLF before boundary
            let endPos = bIdx;
            if (endPos >= 2 && buf[endPos-2] === 0x0d && buf[endPos-1] === 0x0a) endPos -= 2;
            if (endPos > 0) pt.push(buf.slice(0, endPos));
            pt.push(null); // EOF
            buf = buf.slice(bIdx);
            inFilePart = false;
            break;
          } else {
            // Safe to emit everything except the last boundary.length bytes
            const safe = buf.length - boundary.length - 4;
            if (safe > 0) {
              pt.push(buf.slice(0, safe));
              buf = buf.slice(safe);
            }
            break;
          }
        }

        if (!inFilePart) break;
      }
    });

    req.on('end', () => {
      if (inFilePart) {
        // Flush remaining buffer as file data (strip trailing CRLF + final boundary)
        let end = buf.length;
        const fb = indexOf(buf, finalBound);
        if (fb !== -1) end = fb;
        else { const b = indexOf(buf, boundary); if (b !== -1) end = b; }
        if (end >= 2 && buf[end-2] === 0x0d && buf[end-1] === 0x0a) end -= 2;
        if (end > 0) pt.push(buf.slice(0, end));
        pt.push(null);
      }
      tryResolve();
    });

    req.on('error', err => {
      pt.destroy(err);
      reject(err);
    });
  });
}

/** Buffer.indexOf polyfill for sub-buffer searching */
function indexOf(haystack, needle, offset = 0) {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

/** Make an HTTPS request and return { statusCode, headers, body (Buffer) } */
function httpsRequest(method, urlStr, reqHeaders, bodyStream) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  reqHeaders,
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers:    res.headers,
        body:       Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (bodyStream) bodyStream.pipe(req);
    else req.end();
  });
}

/** Read a stream fully into a Buffer */
function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ── Upload Handler ───────────────────────────────────────────────

/**
 * Main upload handler — SSE streaming progress edition.
 *
 * The HTTP response is already open as text/event-stream before this is
 * called. Progress is pushed to the browser via sseWrite() after each
 * chunk is confirmed by Google. The browser never "stalls" because it
 * receives a live event for every 8 MB that lands on Google's servers.
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse}  res   — already has SSE headers written
 * @param {Function}        emit  — sseWrite(res, event, data)
 */
async function handleUpload(req, res, emit) {
  log('info', 'Upload request received');

  let parsed;
  try {
    parsed = await parseMultipart(req);
  } catch (e) {
    log('error', 'Multipart parse failed:', e.message);
    return emit(res, 'error', { message: 'Failed to parse upload: ' + e.message });
  }

  const { fields, fileStream, fileName } = parsed;
  const token      = fields.token;
  const targetUrl  = fields.url;
  const totalBytes = parseInt(fields.fileSize || '0', 10);

  if (!token)      return emit(res, 'error', { message: 'Missing OAuth token' });
  if (!targetUrl)  return emit(res, 'error', { message: 'Missing target URL' });
  if (!totalBytes) return emit(res, 'error', { message: 'Missing or zero fileSize field' });

  log('info', `Uploading "${fileName}" — ${(totalBytes/1048576).toFixed(1)} MB`);
  emit(res, 'progress', { uploaded: 0, total: totalBytes, pct: 0, speed: '', phase: 'initiating' });

  // ── Step 1: Initiate Google resumable upload session ──────────
  let sessionUri;
  try {
    sessionUri = await initiateResumableSession(token, targetUrl, totalBytes);
    log('info', 'Resumable session obtained');
    emit(res, 'progress', { uploaded: 0, total: totalBytes, pct: 0, speed: '', phase: 'uploading' });
  } catch (e) {
    log('error', 'Session initiation failed:', e.message);
    return emit(res, 'error', { message: 'Failed to initiate upload session: ' + e.message });
  }

  // ── Step 2: Stream chunks browser → proxy → Google ────────────
  const reader   = makeChunkReader(fileStream);
  let offset     = 0;
  let lastResp   = null;
  let speedBytes = 0;   // bytes confirmed in last interval
  let speedTime  = Date.now();

  while (offset < totalBytes) {
    const remaining = totalBytes - offset;
    const wantBytes = Math.min(CHUNK_SIZE, remaining);
    const isLast    = (offset + wantBytes) >= totalBytes;

    let chunk;
    try {
      chunk = await reader.read(wantBytes);
    } catch (e) {
      return emit(res, 'error', { message: 'Error reading file stream: ' + e.message });
    }

    if (!chunk || chunk.length === 0) {
      log('warn', 'Stream ended early at offset', offset);
      break;
    }

    const end          = offset + chunk.length - 1;
    const contentRange = isLast
      ? `bytes ${offset}-${end}/${totalBytes}`
      : `bytes ${offset}-${end}/*`;

    let attempt   = 0;
    let chunkDone = false;

    while (attempt < MAX_RETRIES && !chunkDone) {
      attempt++;
      log('info', `Chunk ${offset}–${end}/${totalBytes}  (attempt ${attempt})`);

      try {
        const t0        = Date.now();
        const chunkResp = await putChunk(sessionUri, chunk, contentRange);
        const elapsed   = (Date.now() - t0) / 1000 || 0.001;
        const bps       = chunk.length / elapsed;

        if (chunkResp.statusCode === 200 || chunkResp.statusCode === 201) {
          lastResp  = chunkResp;
          chunkDone = true;
          offset    = totalBytes;
          log('info', `Upload complete — HTTP ${chunkResp.statusCode}`);
          emit(res, 'progress', {
            uploaded: totalBytes, total: totalBytes, pct: 100,
            speed: fmtSpeed(bps), phase: 'done'
          });

        } else if (chunkResp.statusCode === 308) {
          const rangeHdr = chunkResp.headers['range'];
          offset = rangeHdr
            ? parseInt(rangeHdr.split('-')[1], 10) + 1
            : end + 1;
          chunkDone = true;
          log('info', `Chunk accepted → offset ${offset}`);

          // Push real Google-side progress to the browser
          const pct = Math.min(99, Math.round((offset / totalBytes) * 100));
          emit(res, 'progress', {
            uploaded: offset, total: totalBytes, pct,
            speed: fmtSpeed(bps), phase: 'uploading'
          });

        } else {
          const errBody = chunkResp.body.toString();
          log('warn', `Chunk HTTP ${chunkResp.statusCode}: ${errBody}`);
          if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY * attempt);
          else return emit(res, 'error', {
            message: `Chunk failed after ${MAX_RETRIES} attempts: HTTP ${chunkResp.statusCode} — ${errBody}`
          });
        }
      } catch (e) {
        log('warn', `Chunk attempt ${attempt} error: ${e.message}`);
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY * attempt);
        else return emit(res, 'error', { message: 'Chunk network error: ' + e.message });
      }
    }
  }

  // ── Step 3: Send final Google response via SSE ────────────────
  if (lastResp) {
    let body;
    try { body = JSON.parse(lastResp.body.toString()); }
    catch (e) { body = { raw: lastResp.body.toString() }; }
    log('info', 'Upload done — sending result to browser');
    emit(res, 'done', body);
  } else {
    emit(res, 'error', { message: 'Upload ended without a final response from Google' });
  }
}

/** Format bytes/sec to human-readable speed string */
function fmtSpeed(bps) {
  if (!bps || bps < 0) return '';
  if (bps < 1024)       return bps.toFixed(0) + ' B/s';
  if (bps < 1048576)    return (bps/1024).toFixed(1) + ' KB/s';
  if (bps < 1073741824) return (bps/1048576).toFixed(1) + ' MB/s';
  return (bps/1073741824).toFixed(2) + ' GB/s';
}

// ── Upload sub-helpers ───────────────────────────────────────────

/**
 * Initiate a Google resumable upload session.
 * Returns the session URI string.
 */
function initiateResumableSession(token, targetUrl, totalBytes) {
  return new Promise((resolve, reject) => {
    const url     = new URL(targetUrl);
    const bodyBuf = Buffer.from('{}');
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Authorization':            'Bearer ' + token,
        'Content-Type':             'application/json; charset=UTF-8',
        'X-Upload-Content-Type':    'application/octet-stream',
        'X-Upload-Content-Length':  totalBytes,
        'Content-Length':           bodyBuf.length,
      },
    };
    const r = https.request(opts, res2 => {
      const parts = [];
      res2.on('data', c => parts.push(c));
      res2.on('end', () => {
        if (res2.statusCode < 200 || res2.statusCode > 299) {
          const body = Buffer.concat(parts).toString();
          return reject(new Error(`HTTP ${res2.statusCode}: ${body}`));
        }
        const location = res2.headers['location'];
        if (!location) return reject(new Error('No Location header in session initiation response'));
        resolve(location);
      });
    });
    r.on('error', reject);
    r.write(bodyBuf);
    r.end();
  });
}

/**
 * PUT one chunk to the Google resumable session URI.
 * Returns { statusCode, headers, body }.
 */
function putChunk(sessionUri, chunk, contentRange) {
  return new Promise((resolve, reject) => {
    const url  = new URL(sessionUri);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'PUT',
      headers: {
        'Content-Length': chunk.length,
        'Content-Range':  contentRange,
      },
    };
    const r = https.request(opts, res2 => {
      const parts = [];
      res2.on('data', c => parts.push(c));
      res2.on('end', () => resolve({
        statusCode: res2.statusCode,
        headers:    res2.headers,
        body:       Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.write(chunk);
    r.end();
  });
}

/**
 * Wrap a Readable stream in a pull-based reader that lets us await
 * exactly N bytes at a time — decouples stream backpressure from our
 * chunk loop so we never buffer more than CHUNK_SIZE + one event.
 */
function makeChunkReader(stream) {
  let pending  = Buffer.alloc(0);
  let ended    = false;
  let waiters  = [];  // { want, resolve, reject }

  function tryFlush() {
    while (waiters.length > 0) {
      const { want, resolve } = waiters[0];
      if (pending.length >= want || ended) {
        waiters.shift();
        const slice = pending.slice(0, want);
        pending     = pending.slice(want);
        resolve(slice.length > 0 ? slice : null);
      } else {
        break;
      }
    }
  }

  stream.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    tryFlush();
  });
  stream.on('end', () => {
    ended = true;
    tryFlush();
    // Resolve any remaining waiters with whatever is left
    while (waiters.length > 0) {
      const { resolve } = waiters.shift();
      resolve(pending.length > 0 ? pending : null);
      pending = Buffer.alloc(0);
    }
  });
  stream.on('error', err => {
    waiters.forEach(({ reject }) => reject(err));
    waiters = [];
  });

  return {
    /** Read up to `want` bytes. Resolves when enough data arrives or stream ends. */
    read(want) {
      return new Promise((resolve, reject) => {
        if (pending.length >= want || ended) {
          const slice = pending.slice(0, want);
          pending     = pending.slice(want);
          return resolve(slice.length > 0 ? slice : null);
        }
        waiters.push({ want, resolve, reject });
      });
    }
  };
}

// ── Small file upload handler (mapping.txt, native symbols) ────────────────
/**
 * Handle /upload-small
 * Buffers the entire file (mapping/symbols are small), builds a
 * multipart/related body, and POSTs it to Google server-side.
 */
async function handleSmallUpload(req, res) {
  log('info', 'Small upload request received');

  // Collect entire request body
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  // Extract multipart boundary
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=([^\s;]+)/);
  if (!bm) return sendJson(res, 400, { error: { message: 'No multipart boundary' } });
  const boundary = bm[1];

  const bound    = Buffer.from('--' + boundary);
  const SEP      = Buffer.from('\r\n\r\n');

  function bufFind(hay, needle, from) {
    from = from || 0;
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  const fields = {};
  let fileBytes = null;
  let fileName  = 'file';
  let pos       = 0;

  while (pos < rawBody.length) {
    const bIdx = bufFind(rawBody, bound, pos);
    if (bIdx === -1) break;

    let partStart = bIdx + bound.length;
    if (rawBody[partStart] === 0x0d && rawBody[partStart + 1] === 0x0a) partStart += 2;
    if (rawBody[partStart] === 0x2d && rawBody[partStart + 1] === 0x2d) break; // final --

    const hEnd = bufFind(rawBody, SEP, partStart);
    if (hEnd === -1) break;

    const headers   = rawBody.slice(partStart, hEnd).toString('utf8');
    const bodyStart = hEnd + 4;
    const nextB     = bufFind(rawBody, bound, bodyStart);
    let   bodyEnd   = nextB === -1 ? rawBody.length : nextB;
    if (bodyEnd >= 2 && rawBody[bodyEnd - 2] === 0x0d && rawBody[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const partBody  = rawBody.slice(bodyStart, bodyEnd);

    // Parse name and optional filename from Content-Disposition
    const nameM = headers.match(/name="([^"]+)"/i);
    const fileM = headers.match(/filename="([^"]+)"/i);
    const name  = nameM ? nameM[1] : '';

    if (fileM) {
      fileName  = fileM[1];
      fileBytes = partBody;
    } else if (name) {
      fields[name] = partBody.toString('utf8');
    }

    pos = nextB === -1 ? rawBody.length : nextB;
  }

  const token     = (fields.token || '').trim();
  const targetUrl = (fields.url   || '').trim();

  if (!token)     return sendJson(res, 400, { error: { message: 'Missing token' } });
  if (!targetUrl) return sendJson(res, 400, { error: { message: 'Missing url' } });
  if (!fileBytes) return sendJson(res, 400, { error: { message: 'No file data received' } });

  log('info', `Small upload: "${fileName}" (${(fileBytes.length / 1024).toFixed(1)} KB)`);

  // Build upload URL — add uploadType=multipart, preserving all existing path and params
  const hasQuery  = targetUrl.includes('?');
  const alreadyHasUploadType = targetUrl.includes('uploadType=');
  let uploadUrl;
  if (alreadyHasUploadType) {
    // Replace existing uploadType value with multipart
    uploadUrl = targetUrl.replace(/uploadType=[^&]*/, 'uploadType=multipart');
  } else {
    uploadUrl = targetUrl + (hasQuery ? '&' : '?') + 'uploadType=multipart';
  }
  log('info', 'Small upload URL: ' + uploadUrl);

  // Build multipart/related body as a single Buffer
  const bnd     = 'prm_s_' + Date.now().toString(36);
  const meta    = Buffer.from('--' + bnd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n');
  const fhdr    = Buffer.from('--' + bnd + '\r\nContent-Type: application/octet-stream\r\n\r\n');
  const close   = Buffer.from('\r\n--' + bnd + '--');
  const body    = Buffer.concat([meta, fhdr, fileBytes, close]);

  // POST to Google
  const googleResp = await new Promise((resolve, reject) => {
    const u    = new URL(uploadUrl);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'multipart/related; boundary="' + bnd + '"',
        'Content-Length': body.length,
      },
    };
    const r = https.request(opts, r2 => {
      const parts = [];
      r2.on('data', c => parts.push(c));
      r2.on('end', () => resolve({ statusCode: r2.statusCode, body: Buffer.concat(parts) }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });

  let parsed;
  try { parsed = JSON.parse(googleResp.body.toString()); }
  catch (e) { parsed = { raw: googleResp.body.toString() }; }

  if (googleResp.statusCode < 200 || googleResp.statusCode >= 300) {
    const msg = parsed?.error?.message || googleResp.body.toString() || `HTTP ${googleResp.statusCode}`;
    log('error', `Small upload Google error ${googleResp.statusCode}:`, msg);
    return sendJson(res, 502, { error: { message: msg } });
  }

  log('info', `Small upload done — HTTP ${googleResp.statusCode}`);
  sendJson(res, 200, parsed);
}

// ── SSE helper ──────────────────────────────────────────────────
/**
 * Send one Server-Sent Event frame.
 * event: optional named event type
 * data:  any JSON-serialisable value
 */
function sseWrite(res, event, data) {
  try {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    if (event) res.write(`event: ${event}\ndata: ${payload}\n\n`);
    else        res.write(`data: ${payload}\n\n`);
  } catch(_) {}
}

// ── HTTP Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS — allow all localhost origins (file:// sends Origin: null)
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control');
  res.setHeader('Access-Control-Expose-Headers','*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── GET /ping ─────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/ping') {
    return sendJson(res, 200, { ok: true, version: '2.0.0', port: PORT });
  }

  // ── POST /upload  (SSE streaming progress) ────────────────────
  //
  // Response is text/event-stream.  The server emits:
  //   event: progress  data: { uploaded, total, pct, speed, phase }
  //   event: done      data: { ...googleResponse }
  //   event: error     data: { message }
  //
  if (req.method === 'POST' && url.pathname === '/upload') {
    // Start SSE immediately so the browser has a live channel
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',   // disable nginx buffering if behind a proxy
    });
    res.flushHeaders();
    // Send a heartbeat right away so the browser knows the connection is alive
    sseWrite(res, 'heartbeat', { ts: Date.now() });

    try {
      await handleUpload(req, res, sseWrite);
    } catch (e) {
      log('error', 'Unhandled upload error:', e.message, e.stack);
      sseWrite(res, 'error', { message: 'Proxy internal error: ' + e.message });
    }
    res.end();
    return;
  }

  // ── POST /upload-small  (mapping.txt, native symbols zip) ───────────────
  //
  // For files that are small enough to buffer in memory (mapping, symbols).
  // Receives multipart/form-data with fields: token, url, file.
  // Forwards the file to Google using uploadType=multipart (single POST).
  // Returns Google's JSON response directly — no SSE needed.
  //
  if (req.method === 'POST' && url.pathname === '/upload-small') {
    try {
      await handleSmallUpload(req, res);
    } catch (e) {
      log('error', 'Small upload error:', e.message);
      sendJson(res, 500, { error: { message: 'Proxy error: ' + e.message } });
    }
    return;
  }

  // ── 404 for everything else ───────────────────────────────────
  sendJson(res, 404, { error: { message: 'Not found' } });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} is already in use.`);
    console.error(`    Kill the existing process or change PORT in server.js\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│       Play Release Manager — Proxy Server        │');
  console.log('├─────────────────────────────────────────────────┤');
  console.log(`│  ✅  Listening on  http://localhost:${PORT}         │`);
  console.log('│  📡  Routes:  GET /ping   POST /upload            │');
  console.log('│  🔒  Bound to 127.0.0.1 (local only)             │');
  console.log('│                                                   │');
  console.log('│  Open play-release-manager.html in your browser  │');
  console.log('│  and the proxy badge will turn green.             │');
  console.log('│                                                   │');
  console.log('│  Press Ctrl+C to stop                            │');
  console.log('└─────────────────────────────────────────────────┘');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT',  () => { log('info', 'Shutting down'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'Shutting down'); server.close(); process.exit(0); });
