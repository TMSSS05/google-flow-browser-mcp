import path from 'path';
import fs from 'fs';
import { getFlowHome } from './config.js';
import { logger } from './logger.js';

const OUTPUT_BASE = path.join(getFlowHome(), 'outputs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateFilename(type, model, jobId, index) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const modelSlug = (model || 'unknown').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const ext = type === 'image' ? 'png' : 'mp4';
  const idx = String(index || 1).padStart(3, '0');
  return `flow_${dateStr}_${timeStr}_${modelSlug}_${type}_${jobId}_${idx}.${ext}`;
}

export function getOutputDir(type) {
  const dir = path.join(OUTPUT_BASE, type === 'image' ? 'images' : 'videos');
  ensureDir(dir);
  return dir;
}

export function saveMetadata(jobId, data) {
  const metaDir = path.join(OUTPUT_BASE, 'metadata');
  ensureDir(metaDir);
  const filePath = path.join(metaDir, `${jobId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  logger.info('Metadata saved', { jobId, path: filePath });
  return filePath;
}

export function prepareDownload(type, model, jobId, index = 1) {
  const dir = getOutputDir(type);
  const filename = generateFilename(type, model, jobId, index);
  const fullPath = path.join(dir, filename);
  return { dir, filename, fullPath };
}

export function findNewFiles(dir, beforeMs) {
  const files = fs.readdirSync(dir).map(f => path.join(dir, f));
  return files.filter(f => {
    const stat = fs.statSync(f);
    return stat.isFile() && stat.mtimeMs > beforeMs && !f.startsWith('.');
  }).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
