'use strict';

/*
 * Tests the browser upload engine (public/uploader.js) against a real server.
 * Node has no XMLHttpRequest, so a small shim built on fetch stands in for it.
 * The shim can also inject faults: dropped connections, 500s and corrupted bytes.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer } = require('./helpers');

const MB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

(async () => {
  const server = await startServer({ CHUNK_SIZE: String(MB) });
  const base = server.url;
  const realFetch = globalThis.fetch;

  // The engine uses relative URLs, which a browser resolves against the page.
  globalThis.fetch = (url, options) =>
    realFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, options);

  const store = new Map();
  const storage = {
    get: (key) => (store.has(key) ? store.get(key) : null),
    set: (key, value) => store.set(key, value),
    remove: (key) => store.delete(key),
  };

  const net = { puts: [], faults: new Map(), delay: 0 };

  class FakeXHR {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.status = 0;
      this.responseText = '';
      this.controller = new AbortController();
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    abort() {
      this.controller.abort();
    }
    async send(body) {
      try {
        let buf = body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(await body.arrayBuffer());
        const match = /\/chunks\/(\d+)$/.exec(this.url);
        const index = match ? Number(match[1]) : -1;
        const fault = (net.faults.get(index) || []).shift();
        net.puts.push(index);
        if (net.delay) await sleep(net.delay);
        if (this.controller.signal.aborted) return this.onabort();

        if (fault === 'net') return this.onerror();
        if (fault === 500) {
          this.status = 500;
          this.responseText = '{"error":"injected failure"}';
          return this.onload();
        }
        if (fault === 'corrupt') {
          buf = Buffer.from(buf);
          buf[0] ^= 0xff; // flipped after the client computed its checksum
        }

        this.upload.onprogress({ loaded: Math.floor(buf.length / 2) });
        const res = await realFetch(base + this.url, {
          method: this.method,
          headers: this.headers,
          body: buf,
          signal: this.controller.signal,
        });
        this.status = res.status;
        this.responseText = await res.text();
        this.upload.onprogress({ loaded: buf.length });
        this.onload();
      } catch (err) {
        if (this.controller.signal.aborted) this.onabort();
        else this.onerror();
      }
    }
  }
  globalThis.XMLHttpRequest = FakeXHR;

  require('../public/uploader.js');
  const { Upload, formatBytes, formatDuration } = globalThis.Uploader;

  const makeFile = (name, size) => {
    const bytes = crypto.randomBytes(size);
    return { bytes, file: new File([bytes], name, { lastModified: 1700000000000 }) };
  };
  const newUpload = (file) => new Upload(file, { storage, retryBaseMs: 10 });
  const downloadHash = async (name) => {
    const res = await fetch(`/files/${encodeURIComponent(name)}`);
    assert.equal(res.status, 200);
    return sha(Buffer.from(await res.arrayBuffer()));
  };
  const waitFor = async (predicate, ms = 5000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await sleep(5);
    }
  };

  await step('formats sizes and durations', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(50 * 1024 ** 3), '50.0 GB'.replace('.0', '.0'));
    assert.equal(formatDuration(75), '1m 15s');
    assert.equal(formatDuration(Infinity), '–');
  });

  await step('uploads a multi-chunk file intact', async () => {
    const { bytes, file } = makeFile('a.bin', 10 * MB + 4321);
    const up = newUpload(file);
    await up.run();
    assert.equal(up.state, 'done', up.error);
    assert.equal(up.fraction, 1);
    assert.equal(up.result.name, 'a.bin');
    assert.equal(await downloadHash('a.bin'), sha(bytes));
    assert.equal(store.size, 0, 'resume key is cleared after success');
  });

  await step('pause, then a fresh upload object (page reload) sends only what is missing', async () => {
    net.delay = 40;
    const { bytes, file } = makeFile('b.bin', 12 * MB);
    const first = newUpload(file);
    net.puts.length = 0;
    const running = first.run();
    await waitFor(() => net.puts.length >= 4);
    first.pause();
    await running;
    assert.equal(first.state, 'paused');
    assert.equal(store.size, 1, 'upload id is remembered');

    const status = await (await fetch(`/api/uploads/${first.session.id}`)).json();
    assert.ok(status.received.length > 0 && status.received.length < 12, `received ${status.received.length}`);

    net.puts.length = 0;
    const second = newUpload(file); // same name, size and lastModified, like re-adding after a reload
    await second.run();
    assert.equal(second.state, 'done', second.error);
    for (const index of status.received) {
      assert.ok(!net.puts.includes(index), `chunk ${index} was sent again`);
    }
    assert.equal(await downloadHash('b.bin'), sha(bytes));
    net.delay = 0;
  });

  await step('retries dropped connections, 500s and corrupted chunks', async () => {
    const { bytes, file } = makeFile('c.bin', 8 * MB + 1);
    net.puts.length = 0;
    net.faults.set(2, ['net', 'corrupt']);
    net.faults.set(5, [500, 500]);
    const up = newUpload(file);
    await up.run();
    assert.equal(up.state, 'done', up.error);
    assert.ok(net.puts.length >= 9 + 4, `only ${net.puts.length} requests, expected retries`);
    assert.equal(await downloadHash('c.bin'), sha(bytes));
  });

  await step('gives up with an error after too many failures, and can retry later', async () => {
    const { bytes, file } = makeFile('d.bin', 2 * MB);
    net.faults.set(1, Array(50).fill('net'));
    const up = new Upload(file, { storage, retryBaseMs: 1, maxRetries: 3 });
    await up.run();
    assert.equal(up.state, 'error');
    assert.match(up.error, /Network error/);

    net.faults.clear();
    up.resume();
    assert.equal(up.state, 'queued');
    await up.run();
    assert.equal(up.state, 'done', up.error);
    assert.equal(await downloadHash('d.bin'), sha(bytes));
  });

  await step('starts over when the server has forgotten the upload', async () => {
    net.delay = 40;
    const { bytes, file } = makeFile('e.bin', 6 * MB);
    const up = newUpload(file);
    net.puts.length = 0;
    const running = up.run();
    await waitFor(() => net.puts.length >= 2);
    up.pause();
    await running;
    const res = await fetch(`/api/uploads/${up.session.id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);

    net.delay = 0;
    up.resume();
    await up.run();
    assert.equal(up.state, 'done', up.error);
    assert.equal(await downloadHash('e.bin'), sha(bytes));
  });

  await step('cancel discards the upload on the server', async () => {
    net.delay = 40;
    const { file } = makeFile('f.bin', 6 * MB);
    const up = newUpload(file);
    net.puts.length = 0;
    const running = up.run();
    await waitFor(() => net.puts.length >= 2);
    const id = up.session.id;
    up.cancel();
    await running;
    assert.equal(up.state, 'canceled');
    assert.equal(store.size, 0);
    await waitFor(() => true);
    let status = 200;
    for (let i = 0; i < 20 && status !== 404; i++) {
      status = (await fetch(`/api/uploads/${id}`)).status;
      if (status !== 404) await sleep(50);
    }
    assert.equal(status, 404);
    net.delay = 0;
  });

  await step('uploads an empty file', async () => {
    const up = newUpload(new File([], 'zero.txt', { lastModified: 1 }));
    await up.run();
    assert.equal(up.state, 'done', up.error);
    assert.equal(up.result.size, 0);
  });

  await server.stop();
  console.log(failures ? `\n${failures} engine test(s) failed` : '\nAll engine tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
