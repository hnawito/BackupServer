'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Start server.js on a random port. Resolves with { url, dir, filesDir, stop }. */
function startServer(extraEnv = {}, dir) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'uploader-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      UPLOAD_DIR: dataDir,
      BASIC_AUTH: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 10000);
    child.stderr.on('data', (d) => {
      output += d;
    });
    child.once('exit', () => reject(new Error(`Server exited early:\n${output}`)));
    child.stdout.on('data', (d) => {
      output += d;
      const match = /Listening on (http:\/\/\S+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        url: match[1],
        dir: dataDir,
        filesDir: path.join(dataDir, 'files'),
        stop: () =>
          new Promise((done) => {
            if (exited) return done();
            child.once('exit', done);
            child.kill('SIGTERM');
          }),
      });
    });
  });
}

module.exports = { startServer };
