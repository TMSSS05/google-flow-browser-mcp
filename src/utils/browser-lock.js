// Cross-process "the Flow tab is busy" lock. Every GUI server (any port) and tool process
// drives the same browser tab, so a per-process flag isn't enough: two servers once ran a
// video each on the same tab and both downloaded the same result.
import fs from 'fs';
import path from 'path';
import { get } from './config.js';

const LOCK_FILE = path.resolve(get('flowHome', '.'), 'data', 'flow-busy.lock');

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by someone else
  }
}

/** Who holds the lock, if it's another live process: { pid, label, since } or null. */
export function otherHolder() {
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    if (holder.pid === process.pid || !isAlive(holder.pid)) return null; // ours, or stale
    return holder;
  } catch {
    return null; // no lock file
  }
}

/** Take the lock for this process. Returns false if another live process holds it. */
export function acquireLock(label) {
  if (otherHolder()) return false;
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, label, since: new Date().toISOString() }));
  return true;
}

export function releaseLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    if (holder.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* already gone */ }
}
