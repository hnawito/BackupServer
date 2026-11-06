'use strict';

/* End-to-end tests of the HTTP API against a real server process. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer } = require('./helpers');

const MB = 1024 * 1024;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shuffled = (list) => [...list].sort(() => Math.random() - 0.5);

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

(async () => {
  let srv = await startServer({ CHUNK_SIZE: String(MB) });
  const api = (p, options) => fetch(srv.url + p, options);
  const create = (name, size) =>
    api('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, size }),
    });
  const sendChunk = (id, index, buf, hash = sha(buf)) =>
    api(`/api/uploads/${id}/chunks/${index}`, {
      method: 'PUT',
      headers: { 'X-Chunk-SHA256': hash },
      body: buf,
    });
  const slice = (data, index) => data.subarray(index * MB, Math.min(data.length, (index + 1) * MB));
  const sendMany = (id, data, indexes) =>
    Promise.all(
      indexes.map(async (i) => {
        const res = await sendChunk(id, i, slice(data, i));
        assert.equal(res.status, 200, `chunk ${i}`);
      }),
    );

  const data = crypto.randomBytes(10 * MB + 12345); // 11 chunks, the last one partial
  let id;
  let stored;

  await step('serves the page with security headers, and nothing else from disk', async () => {
    const res = await api('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    for (const p of ['/uploader.js', '/app.js', '/style.css', '/api/config']) {
      assert.equal((await api(p)).status, 200, p);
    }
    for (const p of ['/server.js', '/package.json', '/public/app.js', '/nope']) {
      assert.equal((await api(p)).status, 404, p);
    }
  });

  await step('creates an upload and sanitizes a hostile file name', async () => {
    const res = await create('../../evil name.bin', data.length);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.name, 'evil name.bin');
    assert.equal(body.chunkSize, MB);
    assert.equal(body.total, 11);
    assert.deepEqual(body.received, []);
    id = body.id;
  });

  await step('rejects bad sizes and over-limit uploads', async () => {
    assert.equal((await create('a', -1)).status, 400);
    assert.equal((await create('a', 1.5)).status, 400);
    assert.equal((await create('a', 'ten')).status, 400);
  });

  await step('rejects bad chunks and never records them', async () => {
    assert.equal((await sendChunk(id, 11, slice(data, 0))).status, 400, 'index out of range');
    assert.equal((await sendChunk(id, 'x', slice(data, 0))).status, 400, 'index not a number');
    assert.equal((await sendChunk(id, 0, data.subarray(0, 100))).status, 400, 'wrong length');
    assert.equal((await sendChunk(id, 0, slice(data, 0), 'deadbeef')).status, 422, 'bad checksum');
    assert.equal((await sendChunk('0'.repeat(32), 0, slice(data, 0))).status, 404, 'unknown id');
    const status = await (await api(`/api/uploads/${id}`)).json();
    assert.deepEqual(status.received, []);
  });

  await step('refuses to finish while chunks are missing', async () => {
    await sendMany(id, data, shuffled([0, 1, 2, 3, 4, 5]));
    const res = await api(`/api/uploads/${id}/complete`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.deepEqual((await res.json()).missing, [6, 7, 8, 9, 10]);
  });

  await step('keeps progress across a server restart', async () => {
    await srv.stop();
    srv = await startServer({ CHUNK_SIZE: String(MB) }, srv.dir);
    const status = await (await api(`/api/uploads/${id}`)).json();
    assert.deepEqual(status.received, [0, 1, 2, 3, 4, 5]);
  });

  await step('ignores a corrupt re-send of a chunk it already holds', async () => {
    const res = await sendChunk(id, 3, crypto.randomBytes(MB));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duplicate, true);
  });

  await step('completes the upload and stores the exact bytes', async () => {
    await sendMany(id, data, shuffled([6, 7, 8, 9, 10]));
    const res = await api(`/api/uploads/${id}/complete`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'evil name.bin');
    assert.equal(body.size, data.length);
    stored = body.name;

    const download = await api(`/files/${encodeURIComponent(stored)}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment/);
    assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(data));
    assert.deepEqual(fs.readdirSync(srv.filesDir), ['evil name.bin']);
    assert.equal(fs.existsSync(path.join(srv.dir, '..', 'evil name.bin')), false);
    assert.deepEqual(fs.readdirSync(path.join(srv.dir, 'incoming')), []);
  });

  await step('supports range requests', async () => {
    const url = `/files/${encodeURIComponent(stored)}`;
    let res = await api(url, { headers: { Range: 'bytes=5-99' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 5-99/${data.length}`);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(data.subarray(5, 100)));

    res = await api(url, { headers: { Range: 'bytes=-10' } });
    assert.equal(res.status, 206);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(data.subarray(data.length - 10)));

    res = await api(url, { headers: { Range: `bytes=${data.length + 5}-` } });
    assert.equal(res.status, 416);
  });

  await step('never overwrites: a second upload with the same name gets a suffix', async () => {
    const small = crypto.randomBytes(MB + 7);
    const { id: id2 } = await (await create('evil name.bin', small.length)).json();
    await sendMany(id2, small, [1, 0]);
    const body = await (await api(`/api/uploads/${id2}/complete`, { method: 'POST' })).json();
    assert.equal(body.name, 'evil name (1).bin');
    assert.deepEqual(fs.readdirSync(srv.filesDir).sort(), ['evil name (1).bin', 'evil name.bin']);
  });

  await step('handles an empty file', async () => {
    const { id: id3, total } = await (await create('empty.txt', 0)).json();
    assert.equal(total, 0);
    const res = await api(`/api/uploads/${id3}/complete`, { method: 'POST' });
    assert.equal(res.status, 200);
    const download = await api('/files/empty.txt');
    assert.equal(download.status, 200);
    assert.equal((await download.arrayBuffer()).byteLength, 0);
  });

  await step('lists and deletes files', async () => {
    let { files } = await (await api('/api/files')).json();
    assert.deepEqual(files.map((f) => f.name).sort(), ['empty.txt', 'evil name (1).bin', 'evil name.bin']);
    assert.equal(files.find((f) => f.name === 'evil name.bin').size, data.length);

    assert.equal((await api('/api/files/empty.txt', { method: 'DELETE' })).status, 204);
    assert.equal((await api('/api/files/empty.txt', { method: 'DELETE' })).status, 404);
    ({ files } = await (await api('/api/files')).json());
    assert.equal(files.length, 2);
  });

  await step('blocks path traversal on download and delete', async () => {
    fs.writeFileSync(path.join(srv.dir, 'secret.txt'), 'top secret');
    for (const p of ['..%2Fsecret.txt', '..%5Csecret.txt', '%2e%2e%2fsecret.txt']) {
      const res = await api(`/files/${p}`);
      assert.notEqual(res.status, 200, `GET ${p}`);
      const del = await api(`/api/files/${p}`, { method: 'DELETE' });
      assert.ok(del.status === 400 || del.status === 404, `DELETE ${p}`);
    }
    // fetch() collapses literal dot segments before sending, so send these paths raw.
    // The server's URL parser normalizes them too ("/files/.." becomes "/"), which must
    // never expose anything outside the public pages.
    const raw = (rawPath) =>
      new Promise((resolve, reject) => {
        const { port } = new URL(srv.url);
        const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
          const parts = [];
          res.on('data', (d) => parts.push(d));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
        });
        req.on('error', reject);
        req.end();
      });
    for (const p of ['/files/..', '/files/../secret.txt', '/files/../../secret.txt', '/files/%2e%2e/secret.txt']) {
      const res = await raw(p);
      assert.ok(!res.body.includes('top secret'), `GET ${p} leaked a file`);
      if (res.status === 200) assert.match(res.body, /<title>Upload large files<\/title>/, `GET ${p}`);
      else assert.ok(res.status === 400 || res.status === 404, `GET ${p} returned ${res.status}`);
    }
    assert.equal(fs.existsSync(path.join(srv.dir, 'secret.txt')), true);
  });

  await step('can abort an upload and clean up after it', async () => {
    const { id: id4 } = await (await create('abandon.bin', 3 * MB)).json();
    await sendChunk(id4, 0, crypto.randomBytes(MB));
    assert.equal((await api(`/api/uploads/${id4}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/uploads/${id4}`)).status, 404);
    assert.deepEqual(fs.readdirSync(path.join(srv.dir, 'incoming')), []);
  });

  await srv.stop();

  await step('enforces the size limit and basic auth', async () => {
    srv = await startServer({ MAX_FILE_SIZE: '1000', BASIC_AUTH: 'alice:s3cret' });
    const auth = { Authorization: 'Basic ' + Buffer.from('alice:s3cret').toString('base64') };
    const bad = { Authorization: 'Basic ' + Buffer.from('alice:wrong').toString('base64') };

    let res = await api('/');
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /^Basic/);
    assert.equal((await api('/', { headers: bad })).status, 401);
    assert.equal((await api('/', { headers: auth })).status, 200);

    res = await api('/api/uploads', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'big.bin', size: 2000 }),
    });
    assert.equal(res.status, 413);
    await srv.stop();
  });

  console.log(failures ? `\n${failures} API test(s) failed` : '\nAll API tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
