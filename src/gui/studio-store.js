// Persistent profiles for the hat-campaign studio: characters (the recurring AI model)
// and products (each hat). Stored as JSON next to the uploaded reference images.
import fs from 'fs';
import path from 'path';
import { get } from '../utils/config.js';

const DATA_DIR = path.resolve(get('flowHome', '.'), 'data');
const STORE_FILE = path.join(DATA_DIR, 'studio.json');
const KINDS = ['characters', 'products'];
const MAX_IMAGES = 3;

// User-added options for the shot builder, merged with the built-in presets in the page
const PRESET_GROUPS = ['poses', 'scenes', 'outfits', 'styles', 'motions'];

function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch {
    data = {};
  }
  for (const k of KINDS) data[k] ||= [];
  data.presets ||= {};
  for (const g of PRESET_GROUPS) data.presets[g] ||= [];
  return data;
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can't corrupt the store
  fs.writeFileSync(STORE_FILE + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(STORE_FILE + '.tmp', STORE_FILE);
}

export function listProfiles() {
  return load();
}

export function getProfile(kind, id) {
  return load()[kind]?.find(p => p.id === id) || null;
}

/** Create or update a character/product. Returns the saved profile. */
export function upsertProfile(kind, input) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown profile kind: ${kind}`);
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Cần đặt tên.');
  const images = (input.images || []).filter(u => typeof u === 'string' && u.startsWith('/uploads/')).slice(0, MAX_IMAGES);
  if (!images.length) throw new Error('Cần ít nhất 1 ảnh tham chiếu.');

  const data = load();
  const now = new Date().toISOString();
  const existing = data[kind].find(p => p.id === input.id);
  const profile = {
    id: existing?.id || `${kind[0]}_${Date.now()}`,
    name,
    description: String(input.description || '').trim(),
    images,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  data[kind] = existing ? data[kind].map(p => (p.id === profile.id ? profile : p)) : [...data[kind], profile];
  save(data);
  return profile;
}

/** Add a custom pose / scene / outfit / style. `text` is the prompt fragment. */
export function addPreset(group, input) {
  if (!PRESET_GROUPS.includes(group)) throw new Error(`Unknown preset group: ${group}`);
  const label = String(input.label || '').trim().slice(0, 60);
  const text = String(input.text || '').trim().slice(0, 500);
  if (!label) throw new Error('Cần đặt tên lựa chọn.');
  if (!text) throw new Error('Cần mô tả cho AI.');
  const preset = { id: `c_${Date.now()}`, label, text, custom: true };
  if (group === 'poses') preset.wear = input.wear !== false;
  const data = load();
  data.presets[group].push(preset);
  save(data);
  return preset;
}

export function deletePreset(group, id) {
  const data = load();
  if (!PRESET_GROUPS.includes(group)) throw new Error(`Unknown preset group: ${group}`);
  data.presets[group] = data.presets[group].filter(p => p.id !== id);
  save(data);
}

export function deleteProfile(kind, id) {
  const data = load();
  data[kind] = (data[kind] || []).filter(p => p.id !== id);
  save(data);
}
