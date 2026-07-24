#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const [expectedDev, expectedIno, coordinationDir] = process.argv.slice(2);
const eventFile = 'events.jsonl';
const sleep = new Int32Array(new SharedArrayBuffer(4));

function marker(name, content = '') {
  fs.writeFileSync(path.join(coordinationDir, name), content, { flag: 'wx', mode: 0o600 });
}

function waitForDecision() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(coordinationDir, 'commit'))) return 'commit';
    if (fs.existsSync(path.join(coordinationDir, 'rollback'))) return 'rollback';
    Atomics.wait(sleep, 0, 0, 10);
  }
  return 'rollback';
}

let descriptor;
let created = false;
let opened;
let initialSize = 0;
let content;
try {
  const cwd = fs.statSync('.');
  if (!cwd.isDirectory() || String(cwd.dev) !== expectedDev || String(cwd.ino) !== expectedIno) {
    throw new Error('anchored agent directory identity mismatch');
  }
  content = fs.readFileSync(path.join(coordinationDir, 'payload'));
  try {
    descriptor = fs.openSync(eventFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    descriptor = fs.openSync(
      eventFile,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
        | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
  }
  opened = fs.fstatSync(descriptor);
  if (!opened.isFile()) throw new Error('anchored JSONL target must be a regular file');
  initialSize = opened.size;
  fs.writeFileSync(descriptor, content);
  fs.fsyncSync(descriptor);
  marker('ready');

  if (waitForDecision() === 'rollback') {
    fs.ftruncateSync(descriptor, initialSize);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (created) fs.unlinkSync(eventFile);
  }
  if (descriptor !== undefined) fs.closeSync(descriptor);
  marker('done');
} catch (error) {
  try {
    if (descriptor !== undefined) {
      if (opened) {
        fs.ftruncateSync(descriptor, initialSize);
        fs.fsyncSync(descriptor);
      }
      fs.closeSync(descriptor);
    }
    if (created && fs.existsSync(eventFile)) fs.unlinkSync(eventFile);
  } catch {}
  try {
    marker('error', error instanceof Error ? error.message : String(error));
  } catch {}
  process.exit(1);
}
