# BackupServer

A small web app for uploading very large files reliably, It help you to create a backupserver that is comptible with PC's and Phones. It has **no dependencies**: you only need Node.js 18.15 or newer, and there is nothing to `npm install`.

## Run it

```bash
node server.js
# then open http://localhost:3000
```

Uploaded files are stored in `./data/files`. Unfinished uploads live in `./data/incoming` and are deleted after 24 hours.

## What it does

- **Chunked uploads.** The browser cuts each file into 8 MB pieces and sends three at a time, so there is no single huge request that proxies and timeouts can kill.
- **Resumable.** Progress is saved on the server. After a dropped connection, a closed tab or a server restart, add the same file again and only the missing pieces are sent.
- **Automatic retries** with backoff for network errors, 5xx responses and corrupted chunks.
- **Integrity checks.** Each chunk carries a SHA-256 checksum that the server verifies. (Browsers only expose the hashing API on `https://` and `localhost`; elsewhere the server still checks each chunk's length.)
- **Pause, resume and cancel** per file, with progress, speed and time remaining.
- **Downloads** with range support, plus a file list and delete.
- **Safe by default.** File names are sanitized, existing files are never overwritten (`report (1).pdf`), and downloads are always sent as attachments so an uploaded HTML file can never run on your site.

## Configuration

Set these environment variables before starting the server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to bind (`127.0.0.1` for local only) |
| `UPLOAD_DIR` | `./data` | Where files and unfinished uploads are kept |
| `MAX_FILE_SIZE` | `53687091200` (50 GB) | Largest file accepted, in bytes |
| `CHUNK_SIZE` | `8388608` (8 MB) | Chunk size in bytes, between 64 KB and 64 MB |
| `BASIC_AUTH` | empty | `user:password`. When set, the whole site asks for it |
| `STALE_UPLOAD_HOURS` | `24` | Unfinished uploads older than this are removed |

Example: `BASIC_AUTH=team:change-me MAX_FILE_SIZE=107374182400 node server.js`

## Before you put it on the internet

1. **Add authentication.** `BASIC_AUTH` is a simple shared password. For real users, put the app behind your login system or add accounts to `server.js`. Without it, anyone who can reach the server can upload and download.
2. **Use HTTPS.** Run it behind a reverse proxy (nginx, Caddy, a cloud load balancer) that terminates TLS. Basic auth sends the password in every request.
3. **Raise the proxy's body limit to at least the chunk size.** nginx defaults to `client_max_body_size 1m`, which rejects 8 MB chunks. Set it to `16m`. Also turn off request buffering for the upload path if you can (`proxy_request_buffering off;`).
4. **Watch disk space.** The server refuses an upload when the disk cannot hold it, but it does not enforce per-user quotas.
5. **Single server only.** Upload sessions are tracked in one process, so run one instance, not several behind a load balancer.
6. **No virus scanning.** Files are stored exactly as received.

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /api/config` | `{ chunkSize, maxFileSize }` |
| `POST /api/uploads` | Start an upload. Body `{ name, size }`, returns `{ id, chunkSize, total, received }` |
| `GET /api/uploads/:id` | Which chunks the server already has |
| `PUT /api/uploads/:id/chunks/:index` | Send one chunk (raw bytes). Optional header `X-Chunk-SHA256` |
| `POST /api/uploads/:id/complete` | Finish. Returns `409` with `missing` if chunks are absent |
| `DELETE /api/uploads/:id` | Abandon an upload |
| `GET /api/files` | List stored files |
| `GET /files/:name` | Download (supports `Range`) |
| `DELETE /api/files/:name` | Delete a stored file |

## Tests

```bash
npm test      # or: node test/api.test.js && node test/engine.test.js
```

`api.test.js` starts a real server and exercises the API: out-of-order chunks, bad checksums, restart recovery, range requests, path traversal, size limits and auth. `engine.test.js` runs the browser upload code (`public/uploader.js`) against a real server with injected faults: dropped connections, server errors, corrupted bytes, pause and resume after a reload, and an upload the server has forgotten.

## Files

```
server.js            the whole server
public/index.html    page
public/style.css     styles (light and dark)
public/uploader.js   upload engine (chunking, retries, resume), no DOM access
public/app.js        page logic: drop zone, queue, file list
test/                tests
```
