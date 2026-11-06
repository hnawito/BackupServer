/*
 * Upload engine. No DOM access, so it can be tested in Node with a few shims.
 *
 * A file is cut into chunks (size chosen by the server). Several chunks travel in
 * parallel, each with a SHA-256 checksum when the browser can compute one. Failed
 * chunks are retried with backoff. Progress is saved on the server, and the upload
 * id is remembered in localStorage, so re-adding the same file after a reload or a
 * crash only sends the chunks that are still missing.
 */
(() => {
  'use strict';

  const DEFAULTS = { concurrency: 3, maxRetries: 6, retryBaseMs: 500, retryMaxMs: 15000 };
  const KEY_PREFIX = 'uploader:v1:';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const toHex = (buf) =>
    Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const abortedError = () => Object.assign(new Error('Aborted'), { aborted: true });
  const networkError = () =>
    Object.assign(new Error('Network error. Check your connection.'), { retryable: true });

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '–';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  function safeStorage() {
    let store = null;
    try {
      store = globalThis.localStorage || null;
    } catch {
      store = null;
    }
    return {
      get(key) {
        try {
          return store ? store.getItem(key) : null;
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          if (store) store.setItem(key, value);
        } catch {
          /* storage full or blocked: resume-after-reload just won't work */
        }
      },
      remove(key) {
        try {
          if (store) store.removeItem(key);
        } catch {
          /* ignore */
        }
      },
    };
  }

  function httpError(status, text) {
    let message = `Server error (${status})`;
    try {
      const body = JSON.parse(text);
      if (body && body.error) message = body.error;
    } catch {
      /* not JSON */
    }
    const err = new Error(message);
    err.status = status;
    err.retryable =
      status === 408 || status === 422 || status === 429 || (status >= 500 && status !== 507);
    err.sessionLost = status === 404;
    return err;
  }

  async function api(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch {
      throw networkError();
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpError(res.status, text);
    return text ? JSON.parse(text) : null;
  }

  /** PUT one chunk with XMLHttpRequest, because fetch cannot report upload progress. */
  function putChunk(url, body, headers, onProgress, xhrs) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrs.add(xhr);
      const finish = (fn, value) => {
        xhrs.delete(xhr);
        fn(value);
      };
      xhr.open('PUT', url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.timeout = 5 * 60 * 1000;
      xhr.upload.onprogress = (event) => onProgress(event.loaded);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) finish(resolve);
        else finish(reject, httpError(xhr.status, xhr.responseText));
      };
      xhr.onerror = () => finish(reject, networkError());
      xhr.ontimeout = () => finish(reject, networkError());
      xhr.onabort = () => finish(reject, abortedError());
      xhr.send(body);
    });
  }

  class Upload {
    static keyFor(file) {
      return `${KEY_PREFIX}${file.name}|${file.size}|${file.lastModified}`;
    }

    constructor(file, options = {}) {
      this.file = file;
      this.opts = { ...DEFAULTS, ...options };
      this.onUpdate = options.onUpdate || (() => {});
      this.storage = options.storage || safeStorage();
      this.key = Upload.keyFor(file);

      this.state = 'queued'; // queued | uploading | paused | done | error | canceled
      this.error = '';
      this.note = '';
      this.fatal = false; // an error that retrying cannot fix
      this.result = null;
      this.session = null;
      this.received = new Set();
      this.completedBytes = 0;
      this.inflight = new Map(); // chunk index -> bytes sent so far
      this.xhrs = new Set();
      this.samples = [];
      this.stop = null; // null | 'pause' | 'cancel'
      this.running = false;
    }

    // ---- progress ---------------------------------------------------------

    bytesDone() {
      let total = this.completedBytes;
      for (const loaded of this.inflight.values()) total += loaded;
      return Math.min(total, this.file.size);
    }

    get fraction() {
      if (this.state === 'done') return 1;
      return this.file.size ? this.bytesDone() / this.file.size : 0;
    }

    get speed() {
      if (this.samples.length < 2) return 0;
      const first = this.samples[0];
      const last = this.samples[this.samples.length - 1];
      const seconds = (last.t - first.t) / 1000;
      return seconds > 0 ? Math.max(0, (last.bytes - first.bytes) / seconds) : 0;
    }

    get eta() {
      const speed = this.speed;
      return speed > 0 ? (this.file.size - this.bytesDone()) / speed : Infinity;
    }

    sample() {
      const now = Date.now();
      this.samples.push({ t: now, bytes: this.bytesDone() });
      while (this.samples.length > 2 && now - this.samples[0].t > 5000) this.samples.shift();
      this.update();
    }

    update() {
      this.onUpdate(this);
    }

    // ---- controls ---------------------------------------------------------

    pause() {
      if (this.state === 'queued') {
        this.state = 'paused';
        this.update();
      } else if (this.state === 'uploading' && !this.stop) {
        this.stop = 'pause';
        this.abortInflight();
      }
    }

    resume() {
      if (this.state === 'paused' || (this.state === 'error' && !this.fatal)) {
        this.state = 'queued';
        this.error = '';
        this.update();
      }
    }

    cancel() {
      if (this.state === 'done' || this.state === 'canceled') return;
      this.stop = 'cancel';
      if (this.running) {
        this.abortInflight();
      } else {
        this.settleStopped();
        this.update();
      }
    }

    abortInflight() {
      for (const xhr of [...this.xhrs]) xhr.abort();
    }

    forget() {
      this.storage.remove(this.key);
    }

    // ---- the upload itself ------------------------------------------------

    async run() {
      if (this.running) return;
      this.running = true;
      this.stop = null;
      this.state = 'uploading';
      this.error = '';
      this.note = 'Starting…';
      this.samples = [];
      this.update();
      const timer = setInterval(() => this.sample(), 500);

      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await this.transfer();
            break;
          } catch (err) {
            // The server forgot this upload (for example it was cleaned up): start over once.
            if (err.sessionLost && attempt === 0 && !this.stop) {
              this.forget();
              this.session = null;
              continue;
            }
            throw err;
          }
        }
        if (this.result) this.settleDone();
        else this.settleStopped();
      } catch (err) {
        if (err.aborted || this.stop) {
          this.settleStopped();
        } else {
          this.state = 'error';
          this.error = err.message || 'Upload failed';
          this.note = '';
        }
      } finally {
        clearInterval(timer);
        this.running = false;
        this.inflight.clear();
        this.update();
      }
    }

    settleDone() {
      this.forget();
      this.state = 'done';
      this.note = '';
      this.completedBytes = this.file.size;
    }

    settleStopped() {
      this.note = '';
      if (this.stop === 'cancel') {
        const id = (this.session && this.session.id) || this.storage.get(this.key);
        this.forget();
        this.session = null;
        this.state = 'canceled';
        if (id) fetch(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
      } else {
        this.state = 'paused';
      }
    }

    async transfer() {
      for (let pass = 0; pass < 3; pass++) {
        await this.retrying(() => this.openSession());
        await this.sendAllChunks();
        if (this.stop) return;

        this.note = 'Finalizing…';
        this.update();
        try {
          this.result = await this.retrying(() =>
            api(`/api/uploads/${this.session.id}/complete`, { method: 'POST' }),
          );
          return;
        } catch (err) {
          if (err.status === 409 && pass < 2) continue; // chunks missing: send them and retry
          throw err;
        }
      }
    }

    /** Find (or create) the server-side session and learn which chunks it already has. */
    async openSession() {
      let session = null;
      const savedId = (this.session && this.session.id) || this.storage.get(this.key);
      if (savedId) {
        try {
          session = await api(`/api/uploads/${savedId}`);
        } catch (err) {
          if (!err.sessionLost) throw err;
          this.forget();
        }
      }
      if (!session) {
        session = await api('/api/uploads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.file.name, size: this.file.size }),
        });
        this.storage.set(this.key, session.id);
      }
      this.session = session;
      this.received = new Set(session.received);
      this.inflight.clear();
      this.completedBytes = 0;
      for (const index of this.received) this.completedBytes += this.chunkLength(index);
    }

    chunkLength(index) {
      const { chunkSize } = this.session;
      return Math.min(chunkSize, this.file.size - index * chunkSize);
    }

    async sendAllChunks() {
      const pending = [];
      for (let i = 0; i < this.session.total; i++) if (!this.received.has(i)) pending.push(i);

      let failure = null;
      const worker = async () => {
        while (!this.stop && !failure) {
          const index = pending.shift();
          if (index === undefined) return;
          try {
            await this.retrying(() => this.sendChunk(index));
          } catch (err) {
            if (err.aborted) return;
            failure = failure || err;
            this.abortInflight(); // stop the other workers promptly
            return;
          }
        }
      };
      const count = Math.min(this.opts.concurrency, pending.length);
      await Promise.all(Array.from({ length: count }, worker));
      if (failure) throw failure;
    }

    async sendChunk(index) {
      const { chunkSize, id } = this.session;
      const start = index * chunkSize;
      const blob = this.file.slice(start, start + this.chunkLength(index));
      const headers = { 'Content-Type': 'application/octet-stream' };
      let body = blob;

      try {
        const subtle = globalThis.crypto && globalThis.crypto.subtle;
        if (subtle) {
          // Only available on https and localhost; without it the server still checks length.
          const buffer = await blob.arrayBuffer();
          headers['X-Chunk-SHA256'] = toHex(await subtle.digest('SHA-256', buffer));
          body = buffer;
        }
      } catch {
        const err = new Error('Could not read this file. Was it moved, renamed or changed?');
        err.fatal = true;
        throw err;
      }
      if (this.stop) throw abortedError();

      this.inflight.set(index, 0);
      try {
        await putChunk(
          `/api/uploads/${id}/chunks/${index}`,
          body,
          headers,
          (loaded) => this.inflight.set(index, loaded),
          this.xhrs,
        );
        this.received.add(index);
        this.completedBytes += this.chunkLength(index);
        this.note = '';
      } finally {
        this.inflight.delete(index);
      }
    }

    /** Run fn, retrying transient failures with exponential backoff and jitter. */
    async retrying(fn) {
      for (let attempt = 0; ; attempt++) {
        if (this.stop) throw abortedError();
        try {
          return await fn();
        } catch (err) {
          if (err.aborted || this.stop || !err.retryable || attempt >= this.opts.maxRetries) {
            throw err;
          }
          this.note = `Connection problem, retrying (${attempt + 1}/${this.opts.maxRetries})…`;
          this.update();
          const delay = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * 2 ** attempt);
          await this.wait(delay * (0.5 + Math.random() / 2));
        }
      }
    }

    async wait(ms) {
      const end = Date.now() + ms;
      while (!this.stop && Date.now() < end) await sleep(Math.min(100, end - Date.now()));
    }
  }

  globalThis.Uploader = { Upload, formatBytes, formatDuration };
})();
