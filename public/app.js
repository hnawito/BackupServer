/* Page logic: drop zone, upload queue and file list. The transfer work is in uploader.js. */
(() => {
  'use strict';

  const { Upload, formatBytes, formatDuration } = window.Uploader;
  const MAX_ACTIVE_FILES = 2;

  const $ = (selector) => document.querySelector(selector);
  const dropEl = $('#drop');
  const inputEl = $('#file-input');
  const limitsEl = $('#limits');
  const queueEl = $('#queue');
  const queueEmptyEl = $('#queue-empty');
  const filesEl = $('#files');
  const filesEmptyEl = $('#files-empty');
  const liveEl = $('#live');

  let config = { maxFileSize: Infinity };
  const uploads = [];
  const rows = new Map(); // Upload -> { li, ... } element references

  // File names come from users, so everything below uses textContent, never innerHTML.
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function announce(message) {
    liveEl.textContent = message;
  }

  // ---- queue -----------------------------------------------------------------

  function createRow(upload) {
    const li = make('li', 'item');
    const top = make('div', 'item-top');
    const name = make('span', 'item-name', upload.file.name);
    name.title = upload.file.name;
    const size = make('span', 'item-size');
    top.append(name, size);

    const bar = make('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `Upload progress for ${upload.file.name}`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const fill = make('div', 'bar-fill');
    bar.append(fill);

    const bottom = make('div', 'item-bottom');
    const status = make('span', 'item-status');
    const actions = make('div', 'item-actions');
    const primary = make('button', 'btn btn-primary');
    primary.type = 'button';
    const secondary = make('button', 'btn');
    secondary.type = 'button';
    actions.append(primary, secondary);
    bottom.append(status, actions);

    primary.addEventListener('click', () => {
      if (upload.state === 'uploading' || upload.state === 'queued') upload.pause();
      else upload.resume();
    });
    secondary.addEventListener('click', () => upload.cancel());

    li.append(top, bar, bottom);
    queueEl.append(li);
    rows.set(upload, { li, size, bar, fill, status, primary, secondary });
  }

  function statusText(upload, percent) {
    switch (upload.state) {
      case 'queued':
        return 'Waiting to start…';
      case 'uploading': {
        if (upload.note) return upload.note;
        const parts = [`${percent}%`];
        if (upload.speed > 0) parts.push(`${formatBytes(upload.speed)}/s`);
        if (upload.speed > 0 && Number.isFinite(upload.eta)) {
          parts.push(`${formatDuration(upload.eta)} left`);
        }
        return parts.join(' · ');
      }
      case 'paused':
        return `Paused at ${percent}%`;
      case 'error':
        return upload.error;
      case 'done':
        return 'Uploaded';
      default:
        return '';
    }
  }

  function renderRow(upload) {
    const row = rows.get(upload);
    if (!row) return;
    const percent = Math.floor(upload.fraction * 100);
    const active = upload.state === 'uploading' || upload.state === 'queued';

    row.li.dataset.state = upload.state;
    row.fill.style.width = `${percent}%`;
    row.bar.setAttribute('aria-valuenow', String(percent));
    row.size.textContent = active || upload.state === 'paused'
      ? `${formatBytes(upload.bytesDone())} of ${formatBytes(upload.file.size)}`
      : formatBytes(upload.file.size);
    row.status.textContent = statusText(upload, percent);

    if (upload.state === 'done') {
      row.primary.hidden = true;
      row.secondary.hidden = true;
      return;
    }
    row.primary.hidden = upload.state === 'error' && upload.fatal;
    row.primary.textContent = active ? 'Pause' : upload.state === 'error' ? 'Retry' : 'Resume';
    row.secondary.hidden = false;
    row.secondary.textContent = upload.state === 'error' ? 'Dismiss' : 'Cancel';
  }

  function removeUpload(upload) {
    const row = rows.get(upload);
    if (row) row.li.remove();
    rows.delete(upload);
    const index = uploads.indexOf(upload);
    if (index !== -1) uploads.splice(index, 1);
    syncEmptyStates();
  }

  function syncEmptyStates() {
    queueEmptyEl.hidden = uploads.length > 0;
  }

  /** Start queued uploads while there is room. Safe to call at any time. */
  function pump() {
    let active = uploads.filter((u) => u.state === 'uploading').length;
    for (const upload of uploads) {
      if (active >= MAX_ACTIVE_FILES) break;
      if (upload.state === 'queued') {
        upload.run();
        active++;
      }
    }
  }

  function onUpdate(upload) {
    if (upload.state === 'canceled') {
      removeUpload(upload);
      announce(`Canceled ${upload.file.name}`);
    } else {
      renderRow(upload);
      if (upload.state === 'done' && !upload.announced) {
        upload.announced = true;
        announce(`${upload.file.name} uploaded`);
        loadFiles();
        setTimeout(() => removeUpload(upload), 4000);
      }
      if (upload.state === 'error' && !upload.announced) {
        upload.announced = true;
        announce(`${upload.file.name} failed: ${upload.error}`);
      }
      if (upload.state === 'uploading') upload.announced = false;
    }
    pump();
  }

  function addFiles(files) {
    let duplicates = 0;
    for (const file of files) {
      const key = Upload.keyFor(file);
      const busy = uploads.some((u) => u.key === key && u.state !== 'done');
      if (busy) {
        duplicates++;
        continue;
      }
      const upload = new Upload(file, { onUpdate });
      if (file.size > config.maxFileSize) {
        upload.state = 'error';
        upload.fatal = true;
        upload.error = `Larger than the ${formatBytes(config.maxFileSize)} limit`;
      }
      uploads.push(upload);
      createRow(upload);
      renderRow(upload);
    }
    syncEmptyStates();
    if (duplicates) announce(`${duplicates} file(s) already in the queue were skipped`);
    pump();
  }

  // ---- uploaded files --------------------------------------------------------

  function renderFiles(files) {
    filesEl.textContent = '';
    for (const file of files) {
      const li = make('li', 'item file-row');
      const info = make('div', 'file-info');
      const link = make('a', 'file-name', file.name);
      link.href = `/files/${encodeURIComponent(file.name)}`;
      link.setAttribute('download', file.name);
      const meta = make(
        'span',
        'file-meta',
        `${formatBytes(file.size)} · ${new Date(file.modified).toLocaleString()}`,
      );
      info.append(link, meta);

      const remove = make('button', 'btn btn-danger', 'Delete');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete ${file.name}`);
      remove.addEventListener('click', () => deleteFile(file.name));

      li.append(info, remove);
      filesEl.append(li);
    }
    filesEmptyEl.hidden = files.length > 0;
  }

  async function loadFiles() {
    try {
      const res = await fetch('/api/files');
      if (!res.ok) return;
      renderFiles((await res.json()).files);
    } catch {
      /* offline: keep what is shown */
    }
  }

  async function deleteFile(name) {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      announce(`Deleted ${name}`);
    } catch {
      announce(`Could not delete ${name}`);
    }
    loadFiles();
  }

  // ---- drag and drop ---------------------------------------------------------

  function filesFromDrop(dataTransfer) {
    const files = [];
    let folders = 0;
    if (dataTransfer.items && dataTransfer.items.length) {
      for (const item of dataTransfer.items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) {
          folders++;
          continue;
        }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    } else {
      files.push(...dataTransfer.files);
    }
    return { files, folders };
  }

  dropEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropEl.classList.add('dragging');
  });
  dropEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropEl.classList.add('dragging');
  });
  dropEl.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && dropEl.contains(e.relatedTarget)) return;
    dropEl.classList.remove('dragging');
  });
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('dragging');
    const { files, folders } = filesFromDrop(e.dataTransfer);
    if (folders) announce('Folders cannot be uploaded. Choose files instead.');
    addFiles(files);
  });

  // A file dropped outside the zone must not make the browser navigate to it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  inputEl.addEventListener('change', () => {
    const files = [...inputEl.files];
    inputEl.value = '';
    addFiles(files);
  });

  window.addEventListener('beforeunload', (e) => {
    if (uploads.some((u) => u.state === 'uploading')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---- start -----------------------------------------------------------------

  fetch('/api/config')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      config = data;
      limitsEl.textContent = `Up to ${formatBytes(data.maxFileSize)} per file`;
    })
    .catch(() => {});

  syncEmptyStates();
  loadFiles();
})();
