// Local web GUI for entering prompts and generating images in Google Flow.
// Run: npm run gui → http://127.0.0.1:4321
// Uses the same browser (CDP) and tool handlers as the MCP server.
import http from 'http';
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { launchKiaraProfile, navigateToFlow } from '../browser/launch-profile.js';
import { getPage, setBrowser, isBrowserConnected } from '../browser/connect.js';
import { verifyAccount, readSignedInEmail } from '../browser/account-check.js';
import { handleGenerateImage } from '../tools/generate-image.js';
import { handleGenerateVideo, resolveVideoModel } from '../tools/generate-video.js';
import { acquireLock, releaseLock, otherHolder } from '../utils/browser-lock.js';
import Anthropic from '@anthropic-ai/sdk';
import { extractProductInfo, hasCredentials, SUPPORTED_DOC_EXTS } from './doc-extract.js';
import { sendFiles, recentChats, telegramEnabled, defaultChatId } from './telegram.js';
import { startTelegramWatcher, watcherRunning, listInbox, getItem, updateItem, knownChats } from './telegram-inbox.js';
import { cutoutOnWhite, notebookUrl, askGemini, drawWithGemini } from './gemini.js';
import { fetchTikTokHashtags, fetchGoogleTrends, loadTrendsCache, saveTrendsCache } from './trends.js';
import { outfitIdeasPrompt, parseOutfitIdeas, flatlayPrompt } from './outfit-ideas.js';
import { getContext } from '../browser/connect.js';
import { listProfiles, getProfile, upsertProfile, deleteProfile, addPreset, deletePreset } from './studio-store.js';

const PORT = Number(process.env.FLOW_GUI_PORT) || 4321;
const HOST = '127.0.0.1';
const OUTPUTS_DIR = path.resolve(get('flowHome', '.'), 'outputs');
// Reference images (product / character) uploaded from the GUI
const UPLOADS_DIR = path.resolve(get('flowHome', '.'), 'uploads');
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const INDEX_HTML = path.join(import.meta.dirname, 'index.html');
const STUDIO_HTML = path.join(import.meta.dirname, 'studio.html');

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const SERVE_MIME = { ...MIME, '.mp4': 'video/mp4' };
const VIDEO_EXTS = ['.mp4'];

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error('Request body too large');
  }
  return data ? JSON.parse(data) : {};
}

async function readRawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`Ảnh quá lớn (tối đa ${limit / 1024 / 1024}MB)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Map an /uploads/<name> URL (as the page sends it) back to a file inside UPLOADS_DIR. */
function uploadUrlToPath(url) {
  const name = path.basename(decodeURIComponent(String(url).replace(/^\/uploads\//, '')));
  const filePath = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(filePath)) throw new Error(`Ảnh tham chiếu không còn trên máy: ${name}`);
  return filePath;
}

/**
 * Image files under outputs/images (or one product's subfolder), newest first,
 * as URLs the page can load. Batch shots live in outputs/images/<productId>/.
 */
function listImages({ limit = 24, sub = '', kind = 'images' } = {}) {
  const root = path.join(OUTPUTS_DIR, kind, path.basename(sub));
  const wanted = ext => (kind === 'videos' ? VIDEO_EXTS.includes(ext) : !!MIME[ext]);
  if (!fs.existsSync(root)) return [];
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (wanted(path.extname(entry.name).toLowerCase())) files.push({ full, mtime: fs.statSync(full).mtimeMs });
    }
  };
  walk(root);
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(f => ({ name: path.basename(f.full), url: toOutputUrl(f.full), createdAt: new Date(f.mtime).toISOString() }));
}

function toOutputUrl(filePath) {
  const rel = path.relative(OUTPUTS_DIR, path.resolve(filePath));
  return '/outputs/' + rel.split(path.sep).map(encodeURIComponent).join('/');
}

/**
 * Minimal uncompressed ZIP (images are already compressed) — no dependency needed.
 * entries: [{ name, data: Buffer, mtime: Date }]
 */
function buildZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, mtime } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = zlib.crc32(data);
    const d = mtime || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** /outputs/... URL → absolute file path inside OUTPUTS_DIR, or null. */
function outputUrlToPath(u) {
  if (typeof u !== 'string' || !u.startsWith('/outputs/')) return null;
  const filePath = path.resolve(OUTPUTS_DIR, decodeURIComponent(u.slice('/outputs/'.length)));
  return filePath.startsWith(OUTPUTS_DIR + path.sep) && fs.existsSync(filePath) ? filePath : null;
}

async function connect() {
  const result = await launchKiaraProfile(false);
  if (result.browser) setBrowser(result.browser);
  const nav = await navigateToFlow(getPage());
  if (nav?.authenticated === false) return { connected: true, oauthRequired: true, account: null };
  const account = await verifyAccount().catch(e => ({ verified: false, error: e.message }));
  return { connected: true, oauthRequired: false, account };
}

/**
 * Before any generation: connected, and the tab is inside the signed-in Flow app
 * (not the public /about page or Google sign-in). Throws a clear message otherwise.
 */
async function ensureFlowReady() {
  if (!isBrowserConnected()) await connect();
  const nav = await navigateToFlow(getPage()); // no-op when already in the app
  if (nav?.authenticated === false) {
    throw new Error(`Chrome chưa đăng nhập Google Flow. Hãy đăng nhập ${get('expectedAccount')} trong cửa sổ Chrome đang mở, rồi bấm lại.`);
  }
}

// One generation at a time: the browser page is shared state — also across processes
// (another GUI server on a different port drives the same tab), hence the lock file.
let busy = false;
function setBusy(on) {
  busy = on;
  if (on) acquireLock(`GUI :${PORT}`);
  else releaseLock();
}
// Approved Telegram hats wait here until the browser is free, then go through Gemini one by one.
const geminiQueue = [];
let geminiRunning = false;
async function runGeminiQueue() {
  if (geminiRunning) return;
  geminiRunning = true;
  try {
    while (geminiQueue.length) {
      if (busyReason()) { await new Promise(r => setTimeout(r, 5000)); continue; } // Flow is generating
      const id = geminiQueue.shift();
      const item = getItem(id);
      if (!item || item.status !== 'queued') continue;
      setBusy(true);
      updateItem(id, { status: 'processing', startedAt: new Date().toISOString() });
      try {
        if (!isBrowserConnected()) await connect();
        const source = path.join(UPLOADS_DIR, path.basename(item.images[0]));
        const outName = `ref_${Date.now()}_${id}_white.png`;
        await cutoutOnWhite(getContext(), source, path.join(UPLOADS_DIR, outName));
        const product = upsertProfile('products', {
          name: item.name,
          description: '',
          images: [`/uploads/${outName}`],
          notes: item.caption,
          source: 'telegram',
        });
        updateItem(id, { status: 'done', result: `/uploads/${outName}`, productId: product.id, finishedAt: new Date().toISOString() });
        logger.info('Telegram hat ready', { id, productId: product.id });
      } catch (err) {
        updateItem(id, { status: 'error', error: err.message });
      } finally {
        setBusy(false);
      }
    }
  } finally {
    geminiRunning = false;
  }
}

/** Why a new generation can't start now, or null if it can. */
function busyReason() {
  if (busy) return 'Đang có một lượt tạo khác, vui lòng chờ.';
  const other = otherHolder();
  if (other) return `Flow đang được dùng bởi tiến trình khác (${other.label || 'pid ' + other.pid}) — hãy chờ nó xong, hoặc tắt server/cửa sổ kia.`;
  return null;
}

// Google Translate's public web endpoints (unofficial, no key). Tried in order: each one
// gets rate-limited (HTTP 429) on its own, so a second endpoint keeps translation working.
const TRANSLATE_ENDPOINTS = [
  {
    url: t => 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=' + encodeURIComponent(t),
    parse: data => (data?.[0] || []).map(part => part?.[0] || '').join('').trim(),
  },
  {
    url: t => 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en&q=' + encodeURIComponent(t),
    // Returns ["text"] or [["text", "vi"]] depending on the source-language detection
    parse: data => String(Array.isArray(data?.[0]) ? data[0][0] : data?.[0] || '').trim(),
  },
];
const translations = new Map(); // same phrase → no repeat request

// ---- Hat-campaign batches: one Flow generation per pose, run in the background ----
const batches = new Map();

function batchView(b) {
  const { id, kind = 'image', productId, characterId, createdAt, finishedAt, error, cancelled } = b;
  const items = b.items.map(({ startFile, endFile, ...rest }) => rest);
  return { id, kind, productId, characterId, items, createdAt, finishedAt, error, cancelled, running: !finishedAt };
}

async function runVideoBatch(batch, { maxCredits, outputFolder, ...settings }) {
  setBusy(true);
  try {
    await ensureFlowReady();
    for (const item of batch.items) {
      if (batch.cancelled) { item.status = 'cancelled'; continue; }
      item.status = 'running';
      try {
        const r = await handleGenerateVideo({
          ...settings, prompt: item.prompt, start_frame: item.startFile, end_frame: item.endFile || undefined,
          auto_confirm: true, max_credits: maxCredits, output_folder: outputFolder,
        });
        item.status = 'done';
        item.videos = (r.files || []).map(toOutputUrl);
      } catch (err) {
        item.status = 'error';
        item.error = err.message;
        logger.warn('Video failed', { batch: batch.id, label: item.label, error: err.message });
      }
    }
  } catch (err) {
    batch.error = err.message;
    for (const item of batch.items) if (item.status === 'pending') { item.status = 'error'; item.error = err.message; }
  } finally {
    batch.finishedAt = new Date().toISOString();
    setBusy(false);
  }
}

async function runBatch(batch, { references, model, ratio, outputFolder }) {
  setBusy(true);
  try {
    await ensureFlowReady();
    for (const item of batch.items) {
      if (batch.cancelled) { item.status = 'cancelled'; continue; }
      item.status = 'running';
      try {
        const r = await handleGenerateImage({
          prompt: item.prompt, model, ratio, quantity: 1,
          reference_images: [...references, ...(item.extraRefs || [])], auto_confirm: true, output_folder: outputFolder,
        });
        item.status = 'done';
        item.images = (r.files || []).map(toOutputUrl);
      } catch (err) {
        // One failed shot shouldn't sink the batch — record it and move on
        item.status = 'error';
        item.error = err.message;
        logger.warn('Batch shot failed', { batch: batch.id, pose: item.pose, error: err.message });
      }
    }
  } catch (err) {
    batch.error = err.message;
    for (const item of batch.items) if (item.status === 'pending') { item.status = 'error'; item.error = err.message; }
  } finally {
    batch.finishedAt = new Date().toISOString();
    setBusy(false);
  }
}

/** Resolve the character + hat profiles of a batch request into local reference image paths. */
function batchReferences(body) {
  const character = getProfile('characters', body.characterId);
  const product = getProfile('products', body.productId);
  if (!character) throw Object.assign(new Error('Chưa chọn nhân vật.'), { status: 400 });
  if (!product) throw Object.assign(new Error('Chưa chọn mũ.'), { status: 400 });
  // Order matters: the prompt says "the first N images are the character, the next M the hat"
  return { character, product, references: [...character.images, ...product.images].map(uploadUrlToPath) };
}

const routes = {
  // "/" = hat-campaign studio; "/custom" = the free-form ad configurator
  'GET /': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(STUDIO_HTML).pipe(res);
  },
  'GET /custom': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(INDEX_HTML).pipe(res);
  },

  'GET /api/status': async (req, res) => {
    const connected = isBrowserConnected();
    let account = null;
    let url = null;
    if (connected) {
      const page = getPage();
      url = page.url();
      account = await readSignedInEmail(page);
    }
    sendJson(res, 200, { connected, account, expectedAccount: get('expectedAccount'), url, busy });
  },

  'POST /api/connect': async (req, res) => {
    sendJson(res, 200, await connect());
  },

  'GET /api/options': (req, res) => {
    sendJson(res, 200, {
      // Drop aliases (several names mapping to the same model id)
      models: Object.entries(get('imageModels', {}))
        .filter(([, id], i, all) => all.findIndex(([, other]) => other === id) === i)
        .map(([name]) => name),
      ratios: get('ratios', []),
      quantities: get('quantities', [1, 2, 3, 4]),
      docExtract: { enabled: hasCredentials(), exts: SUPPORTED_DOC_EXTS },
      video: {
        models: Object.keys(get('videoModels', {})),
        credits: get('videoCredits', {}),
        ratios: get('videoRatios', ['9:16', '16:9']),
      },
    });
  },

  'GET /api/videos': (req, res, url) => sendJson(res, 200,
    listImages({ kind: 'videos', sub: url.searchParams.get('product') || '', limit: Number(url.searchParams.get('limit')) || 24 })),

  // ---- Image → video (Flow Video › Frames). confirm=false: set up the first one in Flow and
  // report Flow's credit cost; confirm=true: generate all in the background (a "batch" of kind video).
  'POST /api/video': async (req, res) => {
    if (busyReason()) return sendJson(res, 409, { error: busyReason() });
    const body = await readBody(req);
    // Frames: generated images (/outputs/…) or a hat's reference image (/uploads/…, e.g. the intro video)
    const frameFile = u => {
      if (outputUrlToPath(u)) return outputUrlToPath(u);
      if (typeof u === 'string' && u.startsWith('/uploads/')) { try { return uploadUrlToPath(u); } catch { return null; } }
      return null;
    };
    const frames = [...new Set(body.images || [])].map(u => ({ url: u, file: frameFile(u) }));
    if (!frames.length) return sendJson(res, 400, { error: 'Chưa chọn ảnh nào.' });
    const missing = frames.find(f => !f.file);
    if (missing) return sendJson(res, 400, { error: `Không tìm thấy ảnh: ${missing.url}` });
    if (body.pair && frames.length !== 2) return sendJson(res, 400, { error: 'Chế độ chuyển cảnh cần đúng 2 ảnh.' });
    const model = resolveVideoModel(body.model);
    if (!model) return sendJson(res, 400, { error: `Model video không hợp lệ: ${body.model}` });
    const items = body.pair
      ? [{ start: frames[0], end: frames[1], label: 'Ảnh 1 → ảnh 2' }]
      : frames.map((f, i) => ({ start: f, label: `Video ${i + 1}` }));
    // One prompt per video (each scene has its own actions); a single `prompt` applies to all
    const prompts = Array.isArray(body.prompts) ? body.prompts : [body.prompt];
    items.forEach((it, i) => { it.prompt = String(prompts[i] ?? prompts[0] ?? '').trim(); });
    const empty = items.find(it => !it.prompt);
    if (empty) return sendJson(res, 400, { error: `Chưa có hành động hay mô tả cho ${empty.label}.` });
    const settings = { model, ratio: body.ratio || '9:16', duration: Number(body.duration) || 8, quantity: 1, audio: body.audio === true };

    if (body.confirm !== true) {
      setBusy(true);
      try {
        await ensureFlowReady();
        const r = await handleGenerateVideo({
          ...settings, prompt: items[0].prompt, start_frame: items[0].start.file, end_frame: items[0].end?.file, auto_confirm: false,
        });
        return sendJson(res, 200, {
          ...r, count: items.length, total_credits: r.credits * items.length,
          screenshotUrl: r.screenshot ? `/screenshot?path=${encodeURIComponent(r.screenshot)}` : null,
        });
      } finally {
        setBusy(false);
      }
    }

    const maxCredits = Number(body.maxCredits);
    if (!(maxCredits > 0)) return sendJson(res, 400, { error: 'Thiếu số credit đã đồng ý (bấm "Kiểm tra trên Flow" trước).' });
    // Frames live in outputs/images/<productId>/ — keep the videos next to the same hat
    const productId = path.basename(path.dirname(frames[0].file));
    const batch = {
      id: `v_${Date.now()}`,
      kind: 'video',
      productId,
      createdAt: new Date().toISOString(),
      items: items.map(it => ({
        label: it.label, prompt: it.prompt, status: 'pending', images: [], videos: [],
        frame: it.start.url, endFrame: it.end?.url || null, startFile: it.start.file, endFile: it.end?.file || null,
      })),
    };
    batches.set(batch.id, batch);
    void runVideoBatch(batch, { ...settings, maxCredits, outputFolder: path.join(OUTPUTS_DIR, 'videos', productId) });
    sendJson(res, 200, batchView(batch));
  },

  'GET /api/images': (req, res, url) => sendJson(res, 200,
    listImages({ sub: url.searchParams.get('product') || '', limit: Number(url.searchParams.get('limit')) || 24 })),

  // Download several generated images as one .zip: /api/zip?name=x&f=/outputs/...&f=...
  'GET /api/zip': (req, res, url) => {
    const files = [...new Set(url.searchParams.getAll('f').map(outputUrlToPath).filter(Boolean))].slice(0, 200);
    if (!files.length) return sendJson(res, 404, { error: 'Không tìm thấy ảnh để tải.' });
    const used = new Set();
    const entries = files.map(f => {
      let name = path.basename(f);
      for (let i = 2; used.has(name); i++) name = `${path.parse(f).name}_${i}${path.extname(f)}`;
      used.add(name);
      return { name, data: fs.readFileSync(f), mtime: fs.statSync(f).mtime };
    });
    const zipName = (url.searchParams.get('name') || 'flow-images').replace(/[^\w.-]+/g, '_').slice(0, 60) + '.zip';
    const buf = buildZip(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="${zipName}"`,
    });
    res.end(buf);
  },

  // ---- Telegram (bot → channel) ----
  'GET /api/telegram': (req, res) => sendJson(res, 200, { enabled: telegramEnabled(), chatId: defaultChatId() || null }),
  'GET /api/telegram/chats': async (req, res) => {
    // While the watcher long-polls, a second getUpdates would conflict (409): use what it recorded
    if (watcherRunning()) return sendJson(res, 200, knownChats());
    try { sendJson(res, 200, await recentChats()); }
    catch (err) { sendJson(res, 400, { error: err.message }); }
  },

  // ---- Fashion trends → outfit ideas (Gemini) → outfit presets ----
  'GET /api/trends': (req, res) => sendJson(res, 200, loadTrendsCache() || {}),
  'POST /api/trends/refresh': async (req, res) => {
    const body = await readBody(req);
    const country = /^[A-Z]{2}$/.test(body.country) ? body.country : 'VN';
    const period = [7, 30, 120].includes(Number(body.period)) ? Number(body.period) : 7;
    const out = { country, period, fetchedAt: new Date().toISOString(), tiktok: null, google: null, errors: [] };
    try {
      if (!isBrowserConnected()) await connect();
      out.tiktok = await fetchTikTokHashtags(getContext(), { country, period });
    } catch (err) { out.errors.push(`TikTok: ${err.message}`); }
    try { out.google = await fetchGoogleTrends(country); }
    catch (err) { out.errors.push(`Google Trends: ${err.message}`); }
    saveTrendsCache(out);
    sendJson(res, 200, out);
  },
  'POST /api/trends/outfits': async (req, res) => {
    if (busyReason()) return sendJson(res, 409, { error: busyReason() });
    const body = await readBody(req);
    const hashtags = (body.hashtags || []).map(String).slice(0, 15);
    const searches = (body.searches || []).map(String).slice(0, 15);
    if (!hashtags.length && !searches.length) return sendJson(res, 400, { error: 'Chọn ít nhất 1 hashtag hoặc từ khoá.' });
    setBusy(true);
    try {
      if (!isBrowserConnected()) await connect();
      const { text } = await askGemini(getContext(), outfitIdeasPrompt({
        hashtags, searches, hat: String(body.hat || '').slice(0, 200), country: body.countryName || 'Việt Nam',
        count: Math.min(Math.max(Number(body.count) || 8, 3), 12),
      }));
      sendJson(res, 200, { ideas: parseOutfitIdeas(text) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    } finally {
      setBusy(false);
    }
  },
  'POST /api/trends/flatlay': async (req, res) => {
    if (busyReason()) return sendJson(res, 409, { error: busyReason() });
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: 'Thiếu mô tả outfit.' });
    setBusy(true);
    try {
      if (!isBrowserConnected()) await connect();
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const name = `ref_${Date.now()}_outfit_flatlay.png`;
      await drawWithGemini(getContext(), flatlayPrompt(text), path.join(UPLOADS_DIR, name));
      sendJson(res, 200, { url: `/uploads/${name}` });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    } finally {
      setBusy(false);
    }
  },

  // ---- Telegram inbox → Gemini white-background cut-out → new hat profile ----
  'GET /api/inbox': (req, res) => sendJson(res, 200, {
    watching: watcherRunning(), notebook: notebookUrl(), items: listInbox().slice(0, 30),
  }),
  'POST /api/inbox/approve': async (req, res) => {
    const body = await readBody(req);
    const item = getItem(body.id);
    if (!item) return sendJson(res, 404, { error: 'Không tìm thấy mục này.' });
    if (['queued', 'processing'].includes(item.status)) return sendJson(res, 200, item);
    const name = String(body.name || item.name).trim().slice(0, 60) || item.name;
    const updated = updateItem(item.id, { status: 'queued', name, error: null });
    geminiQueue.push(item.id);
    runGeminiQueue();
    sendJson(res, 200, updated);
  },
  'POST /api/inbox/dismiss': async (req, res) => {
    const body = await readBody(req);
    try { sendJson(res, 200, updateItem(body.id, { status: 'dismissed' })); }
    catch (err) { sendJson(res, 404, { error: err.message }); }
  },
  'POST /api/telegram/send': async (req, res) => {
    const body = await readBody(req);
    const files = [...new Set((body.files || []).map(outputUrlToPath).filter(Boolean))].slice(0, 50);
    if (!files.length) return sendJson(res, 400, { error: 'Không tìm thấy file để gửi.' });
    try {
      const results = await sendFiles(files, { caption: String(body.caption || ''), chatId: body.chatId || undefined });
      sendJson(res, 200, { sent: results.filter(r => r.ok).length, total: results.length, results });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  },

  // ---- Character / hat profiles ----
  'GET /api/studio': (req, res) => sendJson(res, 200, listProfiles()),
  'POST /api/studio/characters': async (req, res) => sendJson(res, 200, upsertProfile('characters', await readBody(req))),
  'POST /api/studio/products': async (req, res) => sendJson(res, 200, upsertProfile('products', await readBody(req))),
  // Translate a short phrase to English for prompts (Google Translate's public web endpoint;
  // unofficial — may be rate-limited, the page lets the user type the text by hand instead).
  'GET /api/translate': async (req, res, url) => {
    const text = (url.searchParams.get('text') || '').trim().slice(0, 1000);
    if (!text) return sendJson(res, 400, { error: 'Không có chữ để dịch.' });
    if (translations.has(text)) return sendJson(res, 200, { text: translations.get(text), cached: true });
    const errors = [];
    for (const endpoint of TRANSLATE_ENDPOINTS) {
      try {
        const r = await fetch(endpoint.url(text), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const translated = endpoint.parse(await r.json());
        if (!translated) throw new Error('kết quả rỗng');
        translations.set(text, translated);
        return sendJson(res, 200, { text: translated });
      } catch (err) {
        errors.push(err.message); // rate-limited (429) or changed — try the next endpoint
      }
    }
    sendJson(res, 502, { error: `Google Dịch lỗi (${errors.join(', ')}). Thử lại sau ít phút, hoặc gõ mô tả tay.` });
  },

  // body: { group: poses|scenes|outfits|styles, label, text, wear? }
  'POST /api/studio/presets': async (req, res) => {
    const { group, ...input } = await readBody(req);
    sendJson(res, 200, addPreset(group, input));
  },
  'POST /api/studio/presets/delete': async (req, res) => {
    const { group, id } = await readBody(req);
    deletePreset(group, id);
    sendJson(res, 200, { ok: true });
  },
  'POST /api/studio/delete': async (req, res) => {
    const { kind, id } = await readBody(req);
    if (!['characters', 'products'].includes(kind)) return sendJson(res, 400, { error: 'kind không hợp lệ' });
    deleteProfile(kind, id);
    sendJson(res, 200, { ok: true });
  },

  // body: { characterId, productId, model, ratio, confirm, shots: [{ pose, label, prompt }] }
  // confirm=false → prepare the FIRST shot only, no credits (returns a screenshot).
  // confirm=true  → start a background batch (credits per shot); poll GET /api/batch?id=
  'POST /api/batch': async (req, res) => {
    if (busyReason()) return sendJson(res, 409, { error: busyReason() });
    const body = await readBody(req);
    const shots = (body.shots || []).filter(s => s.prompt?.trim());
    if (!shots.length) return sendJson(res, 400, { error: 'Chưa chọn pose nào.' });
    let refs;
    try { refs = batchReferences(body); } catch (err) { return sendJson(res, err.status || 500, { error: err.message }); }
    // Per-shot extra references (e.g. the outfit's flat-lay image), attached after character + hat
    let shotRefs;
    try {
      shotRefs = shots.map(s => (Array.isArray(s.refs) ? s.refs : []).filter(u => typeof u === 'string' && u.startsWith('/uploads/')).slice(0, 2).map(uploadUrlToPath));
    } catch (err) { return sendJson(res, 400, { error: err.message }); }

    if (body.confirm !== true) {
      setBusy(true);
      try {
        await ensureFlowReady();
        const r = await handleGenerateImage({
          prompt: shots[0].prompt.trim(), model: body.model, ratio: body.ratio, quantity: 1,
          reference_images: [...refs.references, ...shotRefs[0]], auto_confirm: false,
        });
        return sendJson(res, 200, { ...r, screenshotUrl: r.screenshot ? `/screenshot?path=${encodeURIComponent(r.screenshot)}` : null });
      } finally {
        setBusy(false);
      }
    }

    const batch = {
      id: `b_${Date.now()}`,
      productId: refs.product.id,
      characterId: refs.character.id,
      createdAt: new Date().toISOString(),
      items: shots.map((s, i) => ({ pose: s.pose, label: s.label || s.pose, prompt: s.prompt.trim(), extraRefs: shotRefs[i], status: 'pending', images: [] })),
    };
    batches.set(batch.id, batch);
    void runBatch(batch, { // background; runBatch never rejects (errors are recorded on the batch)
      references: refs.references, model: body.model, ratio: body.ratio,
      outputFolder: path.join(OUTPUTS_DIR, 'images', refs.product.id),
    });
    sendJson(res, 200, batchView(batch));
  },

  'GET /api/batch': (req, res, url) => {
    const batch = batches.get(url.searchParams.get('id'));
    if (!batch) return sendJson(res, 404, { error: 'Không tìm thấy lượt tạo này (server có thể đã khởi động lại).' });
    sendJson(res, 200, batchView(batch));
  },

  // Stops after the shot currently generating; that shot still finishes (and is charged).
  'POST /api/batch/cancel': async (req, res) => {
    const batch = batches.get((await readBody(req)).id);
    if (!batch) return sendJson(res, 404, { error: 'Không tìm thấy lượt tạo này.' });
    batch.cancelled = true;
    sendJson(res, 200, batchView(batch));
  },

  // Raw image bytes in the body; X-Filename header carries the original name.
  // Saved with a unique name because Flow identifies uploads by file name.
  'POST /api/upload': async (req, res) => {
    const original = decodeURIComponent(req.headers['x-filename'] || 'image.jpg');
    const ext = path.extname(original).toLowerCase();
    if (!MIME[ext]) return sendJson(res, 400, { error: 'Chỉ nhận ảnh JPG, PNG hoặc WEBP.' });
    const data = await readRawBody(req, MAX_UPLOAD_BYTES);
    if (!data.length) return sendJson(res, 400, { error: 'File rỗng.' });

    const base = path.basename(original, ext).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    const name = `ref_${Date.now()}_${base}${ext}`;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, name), data);
    sendJson(res, 200, { name, url: `/uploads/${encodeURIComponent(name)}` });
  },

  // Raw document bytes; X-Filename header. Claude reads it and returns form fields.
  // Costs Anthropic API tokens (not Flow credits).
  'POST /api/extract': async (req, res) => {
    const original = decodeURIComponent(req.headers['x-filename'] || '');
    const ext = path.extname(original).toLowerCase();
    if (!SUPPORTED_DOC_EXTS.includes(ext)) {
      return sendJson(res, 400, { error: `Chỉ nhận ${SUPPORTED_DOC_EXTS.join(', ')}` });
    }
    if (!hasCredentials()) {
      return sendJson(res, 503, { error: 'Chưa có ANTHROPIC_API_KEY. Đặt biến môi trường rồi khởi động lại "npm run gui".' });
    }
    const data = await readRawBody(req, 25 * 1024 * 1024);
    try {
      sendJson(res, 200, await extractProductInfo(ext, data));
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        return sendJson(res, 401, { error: 'ANTHROPIC_API_KEY không hợp lệ.' });
      }
      if (err instanceof Anthropic.RateLimitError) {
        return sendJson(res, 429, { error: 'Claude API đang giới hạn tốc độ, thử lại sau ít phút.' });
      }
      if (err instanceof Anthropic.APIError) {
        return sendJson(res, 502, { error: `Claude API lỗi ${err.status}: ${err.message}` });
      }
      throw err;
    }
  },

  // body: { prompt, model, ratio, quantity, confirm, references: ["/uploads/…"] }
  // confirm=false → prepare only (no credits). confirm=true → click Generate (credits).
  'POST /api/generate': async (req, res) => {
    if (busyReason()) return sendJson(res, 409, { error: busyReason() });
    const body = await readBody(req);
    if (!body.prompt?.trim()) return sendJson(res, 400, { error: 'Prompt trống.' });

    const referenceImages = (body.references || []).map(uploadUrlToPath);

    setBusy(true);
    try {
      await ensureFlowReady();
      const result = await handleGenerateImage({
        prompt: body.prompt.trim(),
        model: body.model,
        ratio: body.ratio,
        quantity: Number(body.quantity) || 1,
        reference_images: referenceImages,
        auto_confirm: body.confirm === true,
      });
      sendJson(res, 200, {
        ...result,
        images: (result.files || []).map(toOutputUrl),
        screenshotUrl: result.screenshot ? `/screenshot?path=${encodeURIComponent(result.screenshot)}` : null,
      });
    } finally {
      setBusy(false);
    }
  },
};

function serveFile(res, root, relPath, attachment = false, req = null) {
  const filePath = path.resolve(root, relPath);
  // Only serve files inside root (no ../ escapes)
  if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const size = fs.statSync(filePath).size;
  const headers = {
    'Content-Type': SERVE_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  if (attachment) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req?.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) return await handler(req, res, url);

    if (req.method === 'GET' && url.pathname.startsWith('/outputs/')) {
      return serveFile(res, OUTPUTS_DIR, decodeURIComponent(url.pathname.slice('/outputs/'.length)),
        url.searchParams.has('download'), req);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      return serveFile(res, UPLOADS_DIR, path.basename(decodeURIComponent(url.pathname.slice('/uploads/'.length))));
    }
    if (req.method === 'GET' && url.pathname === '/screenshot') {
      const root = path.resolve(get('flowHome', '.'), 'screenshots-debug');
      return serveFile(res, root, path.basename(url.searchParams.get('path') || ''));
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    logger.error('GUI request failed', { path: url.pathname, error: err.message });
    if (!res.headersSent) sendJson(res, 500, { error: err.message, code: err.code });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[GUI] Cổng ${PORT} đang bị một tiến trình khác dùng (có thể là một "npm run gui" khác đang chạy).\n` +
      `      Tắt nó trước, hoặc chạy cổng khác:  $env:FLOW_GUI_PORT=4322; npm run gui\n` +
      `      Tìm tiến trình:  Get-NetTCPConnection -LocalPort ${PORT} | Select OwningProcess\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  logger.info(`Flow GUI running at http://${HOST}:${PORT}`);
  // Jobs cut off by a restart can be retried from the GUI
  for (const it of listInbox()) {
    if (['queued', 'processing'].includes(it.status)) updateItem(it.id, { status: 'error', error: 'Bị gián đoạn do server khởi động lại — bấm Thử lại.' });
  }
  if (telegramEnabled() && process.env.TELEGRAM_WATCH !== 'false') startTelegramWatcher();
});
