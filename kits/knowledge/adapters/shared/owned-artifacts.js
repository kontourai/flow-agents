import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

const supportProbe = "import os,sys; sys.exit(0 if os.name == 'posix' and all(fn in os.supports_dir_fd for fn in (os.open, os.stat, os.unlink)) and hasattr(os, 'O_NOFOLLOW') else 'descriptor-relative POSIX file operations are unavailable')";
const publisher = `
import os, sys, hashlib, json, stat
name, mode = sys.argv[1:]
if not name or name in ('.', '..') or '/' in name or '\\\\' in name: raise ValueError('unsafe artifact filename')
if not stat.S_ISDIR(os.fstat(3).st_mode): raise ValueError('artifact parent is not a directory')
content = sys.stdin.buffer.read()
flags = os.O_NOFOLLOW | os.O_WRONLY
flags |= os.O_APPEND if mode == 'append' else os.O_CREAT | os.O_EXCL
fd = os.open(name, flags, 0o600, dir_fd=3)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode): raise RuntimeError('artifact is not a regular file')
    with os.fdopen(fd, 'ab' if mode == 'append' else 'wb', closefd=False) as stream:
        stream.write(content)
        stream.flush()
        os.fsync(fd)
    read_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=3)
    try:
        opened, readback = os.fstat(fd), os.fstat(read_fd)
        if (opened.st_dev, opened.st_ino) != (readback.st_dev, readback.st_ino): raise RuntimeError('artifact identity changed')
        with os.fdopen(read_fd, 'rb', closefd=False) as stream: persisted = stream.read()
    finally: os.close(read_fd)
    if mode != 'append' and persisted != content: raise RuntimeError('artifact readback changed')
    print(json.dumps({'digest': hashlib.sha256(persisted).hexdigest(), 'dev': opened.st_dev, 'ino': opened.st_ino}))
except:
    if mode != 'append':
        try:
            named = os.stat(name, dir_fd=3, follow_symlinks=False)
            opened = os.fstat(fd)
            if (named.st_dev, named.st_ino) == (opened.st_dev, opened.st_ino): os.unlink(name, dir_fd=3)
        except FileNotFoundError: pass
    raise
finally: os.close(fd)
`;

export function requireOwnedArtifactPublisher(pythonCommand = ["python3"]) {
  const [binary, ...prefix] = pythonCommand;
  const result = spawnSync(binary, [...prefix, "-c", supportProbe], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`INGEST_PREREQUISITE: POSIX Python 3 with descriptor-relative file operations is required: ${result.error?.message || result.stderr}`);
  }
}

export function openOwnedDirectory(directory) {
  const named = fs.lstatSync(directory);
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(descriptor);
  if (named.isSymbolicLink() || !opened.isDirectory() || named.dev !== opened.dev || named.ino !== opened.ino) {
    fs.closeSync(descriptor);
    throw new Error("UNSAFE_INGEST_PATH: directory changed while opening custody descriptor");
  }
  return descriptor;
}

export function publishOwnedArtifact(directoryFd, name, content, { append = false, pythonCommand = ["python3"] } = {}) {
  const [binary, ...prefix] = pythonCommand;
  const result = spawnSync(binary, [...prefix, "-c", publisher, name, append ? "append" : "create"], {
    input: content, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "pipe", directoryFd],
  });
  if (result.error || result.status !== 0) throw new Error(`INGEST_PUBLICATION_FAILED: ${result.error?.message || result.stderr}`);
  return JSON.parse(result.stdout);
}
