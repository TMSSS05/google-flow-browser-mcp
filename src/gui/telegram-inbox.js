// Watch the Telegram channel for new hat posts (photo + caption) and keep them in an inbox
// until the user approves (→ Gemini white-background cut-out) or dismisses them.
// Uses Bot API long polling; the bot must be an admin of the channel.
import fs from 'fs';
import path from 'path';
import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const DATA_DIR = path.resolve(get('flowHome', '.'), 'data');
const UPLOADS_DIR = path.resolve(get('flowHome', '.'), 'uploads');
const STORE_FILE = path.join(DATA_DIR, 'telegram-inbox.json');
const MAX_IMAGES = 3;
const ALBUM_WAIT_MS = 2500; // photos of one album arrive as separate updates

const token = () => (process.env.TELEGRAM_BOT_TOKEN || '').trim();
// Channel the hat photos come IN from (separate from TELEGRAM_CHAT_ID, where videos are sent OUT)
const chatFilter = () => (process.env.TELEGRAM_INBOX_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim();

// ---------- store ----------
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    return { offset: d.offset || 0, items: d.items || [], chats: d.chats || [] };
  } catch {
    return { offset: 0, items: [], chats: [] };
  }
}
function save(d) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(STORE_FILE + '.tmp', STORE_FILE);
}

export function listInbox() {
  return load().items.filter(i => i.status !== 'dismissed').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function getItem(id) {
  return load().items.find(i => i.id === id) || null;
}
/** Merge fields into an inbox item and persist. Returns the updated item. */
export function updateItem(id, patch) {
  const d = load();
  const item = d.items.find(i => i.id === id);
  if (!item) throw new Error('Không tìm thấy mục này trong hộp thư.');
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  save(d);
  return item;
}
/** Chats the bot has seen (to look up the channel id). */
export function knownChats() {
  return load().chats;
}

// ---------- Bot API ----------
async function call(method, body, signal) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(data.description || `Telegram HTTP ${res.status}`);
    err.code = data.error_code;
    throw err;
  }
  return data.result;
}

async function downloadFile(fileId, label) {
  const f = await call('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token()}/${f.file_path}`);
  if (!res.ok) throw new Error(`Tải ảnh Telegram lỗi HTTP ${res.status}`);
  const ext = (path.extname(f.file_path) || '.jpg').toLowerCase();
  const name = `ref_${Date.now()}_${label}${ext === '.jpeg' ? '.jpg' : ext}`;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, name), Buffer.from(await res.arrayBuffer()));
  return `/uploads/${name}`;
}

/**
 * Telegram Web (K) shows channel ids without the Bot API's "-100" prefix (#-4335366156 is
 * -1004335366156 for the bot), so accept both forms. Several ids can be given, comma-separated.
 */
function matchesChat(chat) {
  const wants = chatFilter().split(',').map(s => s.trim()).filter(Boolean);
  const id = String(chat.id);
  return wants.some(want => {
    if (want.startsWith('@')) return Boolean(chat.username) && `@${chat.username}`.toLowerCase() === want.toLowerCase();
    const digits = want.replace(/^-(100)?/, '');
    return id === want || id === `-100${digits}` || id === `-${digits}`;
  });
}

/** Largest photo, or an image sent "as file". */
function imageFileId(post) {
  if (post.photo?.length) return post.photo[post.photo.length - 1].file_id;
  if (post.document?.mime_type?.startsWith('image/')) return post.document.file_id;
  return null;
}

/** First caption line is the hat name; the whole caption is kept as notes. */
function nameFromCaption(caption, fallback) {
  const line = (caption || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  const clean = line.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean || fallback;
}

// ---------- watcher ----------
const albums = new Map(); // media_group_id -> { posts, timer }
let listeners = [];
export function onNewItem(fn) { listeners.push(fn); }

async function createItem(posts) {
  const first = posts[0];
  const caption = posts.map(p => p.caption).find(Boolean) || '';
  const id = `tg_${first.chat.id}_${first.message_id}`;
  if (getItem(id)) return; // already have it (e.g. offset not saved before a restart)

  const images = [];
  for (const [n, p] of posts.slice(0, MAX_IMAGES).entries()) {
    images.push(await downloadFile(imageFileId(p), `tg${first.message_id}_${n + 1}`));
  }
  const item = {
    id,
    source: 'telegram',
    chat: first.chat.title || first.chat.username || String(first.chat.id),
    messageId: first.message_id,
    caption,
    name: nameFromCaption(caption, `Mũ Telegram #${first.message_id}`),
    images,
    status: 'new', // new → queued → processing → done | error ; or dismissed
    createdAt: new Date((first.date || Date.now() / 1000) * 1000).toISOString(),
  };
  const d = load();
  d.items.push(item);
  save(d);
  logger.info('Telegram: new hat post', { id, images: images.length, name: item.name });
  for (const fn of listeners) { try { fn(item); } catch { /* listener errors don't stop the watcher */ } }
}

function handlePost(post) {
  if (!matchesChat(post.chat) || !imageFileId(post)) return;
  if (!post.media_group_id) {
    createItem([post]).catch(e => logger.warn('Telegram: could not save post', { error: e.message }));
    return;
  }
  const group = albums.get(post.media_group_id) || { posts: [] };
  group.posts.push(post);
  clearTimeout(group.timer);
  group.timer = setTimeout(() => {
    albums.delete(post.media_group_id);
    group.posts.sort((a, b) => a.message_id - b.message_id);
    createItem(group.posts).catch(e => logger.warn('Telegram: could not save album', { error: e.message }));
  }, ALBUM_WAIT_MS);
  albums.set(post.media_group_id, group);
}

function rememberChat(chat) {
  const d = load();
  if (d.chats.some(c => c.id === chat.id)) return;
  d.chats.push({ id: chat.id, type: chat.type, title: chat.title || chat.username || chat.first_name || '', username: chat.username || null });
  save(d);
}

let running = false;
export function watcherRunning() { return running; }

export function startTelegramWatcher() {
  if (running || !token()) return false;
  running = true;
  logger.info('Telegram watcher started', { chat: chatFilter() || '(TELEGRAM_CHAT_ID not set — only recording chats)' });

  (async () => {
    while (running) {
      try {
        const d = load();
        const updates = await call('getUpdates', {
          offset: d.offset,
          timeout: 30,
          allowed_updates: ['channel_post', 'message', 'my_chat_member'],
        }, AbortSignal.timeout(45000));
        for (const u of updates) {
          const post = u.channel_post || u.message;
          const chat = post?.chat || u.my_chat_member?.chat;
          if (chat) rememberChat(chat);
          if (post) handlePost(post);
        }
        if (updates.length) {
          const fresh = load();
          fresh.offset = updates[updates.length - 1].update_id + 1;
          save(fresh);
        }
      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') continue;
        // 409 = another getUpdates/webhook is active (e.g. a second GUI server)
        logger.warn('Telegram watcher error', { error: err.message, code: err.code });
        await new Promise(r => setTimeout(r, err.code === 409 ? 10000 : 5000));
      }
    }
  })();
  return true;
}

export function stopTelegramWatcher() { running = false; }
