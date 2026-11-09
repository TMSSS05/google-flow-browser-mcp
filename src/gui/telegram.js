// Send generated videos/images to a Telegram channel through a bot (Bot API).
// Config (.env): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (@channel_username or -100… id).
// The bot must be an admin of the channel with "Post messages" permission.
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

const BOT_UPLOAD_LIMIT = 50 * 1024 * 1024; // Bot API hard limit for uploads
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const token = () => (process.env.TELEGRAM_BOT_TOKEN || '').trim();
export const defaultChatId = () => (process.env.TELEGRAM_CHAT_ID || '').trim();
export const telegramEnabled = () => Boolean(token());

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const retry = data.parameters?.retry_after;
    const err = new Error(data.description || `Telegram HTTP ${res.status}`);
    err.retryAfter = retry;
    throw err;
  }
  return data.result;
}

async function sendOne(chatId, file, caption) {
  const ext = path.extname(file).toLowerCase();
  const size = fs.statSync(file).size;
  if (size > BOT_UPLOAD_LIMIT) {
    throw new Error(`${path.basename(file)} nặng ${(size / 1048576).toFixed(1)}MB — bot chỉ gửi được tối đa 50MB`);
  }
  const isVideo = VIDEO_EXTS.has(ext);
  const isPhoto = PHOTO_EXTS.has(ext) && size <= 10 * 1024 * 1024;
  const [method, field] = isVideo ? ['sendVideo', 'video'] : isPhoto ? ['sendPhoto', 'photo'] : ['sendDocument', 'document'];

  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption.slice(0, 1024));
  if (isVideo) form.append('supports_streaming', 'true');
  form.append(field, new Blob([fs.readFileSync(file)]), path.basename(file));

  try {
    return await call(method, form);
  } catch (err) {
    if (!err.retryAfter) throw err;
    await new Promise(r => setTimeout(r, (err.retryAfter + 1) * 1000)); // rate-limited: wait once and retry
    return await call(method, form);
  }
}

/** Send files one by one. Caption goes on the first file only. Returns per-file results. */
export async function sendFiles(files, { chatId = defaultChatId(), caption = '' } = {}) {
  if (!telegramEnabled()) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN trong .env');
  if (!chatId) throw new Error('Chưa cấu hình TELEGRAM_CHAT_ID trong .env (vd. @ten_channel hoặc -100…)');

  const results = [];
  for (const [i, file] of files.entries()) {
    try {
      await sendOne(chatId, file, i === 0 ? caption : '');
      results.push({ file: path.basename(file), ok: true });
    } catch (err) {
      logger.warn('Telegram send failed', { file, error: err.message });
      results.push({ file: path.basename(file), ok: false, error: err.message });
    }
    if (i < files.length - 1) await new Promise(r => setTimeout(r, 1200)); // stay under channel rate limits
  }
  logger.info('Telegram send done', { chatId, sent: results.filter(r => r.ok).length, total: files.length });
  return results;
}

/** Chats the bot has seen recently (e.g. right after being added as channel admin) — helps find the chat id. */
export async function recentChats() {
  if (!telegramEnabled()) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN trong .env');
  const updates = await call('getUpdates', { allowed_updates: ['my_chat_member', 'channel_post', 'message'] });
  const chats = new Map();
  for (const u of updates) {
    const chat = u.my_chat_member?.chat || u.channel_post?.chat || u.message?.chat;
    if (chat) chats.set(chat.id, { id: chat.id, type: chat.type, title: chat.title || chat.username || chat.first_name, username: chat.username || null });
  }
  return [...chats.values()];
}
