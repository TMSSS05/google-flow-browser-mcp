// Simple video editor on top of ffmpeg: join clips with transitions (xfade), fade in/out,
// per-clip text (fading in/out with a soft box), trim, background music, watermark.
// ffmpeg is found on PATH, via FFMPEG_PATH / config `ffmpegPath`, or in winget's install folders
// (a freshly installed package isn't on the PATH of an already running server).
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const TMP_DIR = path.resolve(get('flowHome', '.'), 'data', 'edit-tmp');
const FPS = 30;

// Fonts with Vietnamese glyphs. Key = what the page sends; first existing path wins.
const FONTS = {
  arial: ['C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial Bold.ttf'],
  segoe: ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  tahoma: ['C:/Windows/Fonts/tahomabd.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  bahnschrift: ['C:/Windows/Fonts/bahnschrift.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  impact: ['C:/Windows/Fonts/impact.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
};
export const FONT_LABELS = { arial: 'Arial đậm', segoe: 'Segoe UI đậm', tahoma: 'Tahoma đậm', bahnschrift: 'Bahnschrift', impact: 'Impact' };
export const TRANSITIONS = {
  fade: 'Mờ dần (crossfade)', fadeblack: 'Qua màu đen', fadewhite: 'Qua màu trắng', dissolve: 'Hoà tan',
  slideleft: 'Trượt sang trái', slideright: 'Trượt sang phải', wipeleft: 'Lau sang trái', circleopen: 'Mở vòng tròn',
  smoothleft: 'Lướt mượt', none: 'Không (cắt thẳng)',
};
const TEXT_POSITIONS = ['top', 'center', 'bottom'];
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
export const MAX_STILL_SECONDS = 60; // a still image can be shown up to this long
const WM_POSITIONS = ['tl', 'tr', 'bl', 'br'];

// ---------- locating ffmpeg ----------
function toolCandidates(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const list = [];
  const configured = (process.env.FFMPEG_PATH || get('ffmpegPath') || '').trim();
  if (configured) list.push(name === 'ffmpeg' ? configured : path.join(path.dirname(configured), exe));
  const local = process.env.LOCALAPPDATA;
  if (local) {
    list.push(path.join(local, 'Microsoft', 'WinGet', 'Links', exe));
    const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(packages)) {
        if (!d.startsWith('Gyan.FFmpeg')) continue;
        for (const sub of fs.readdirSync(path.join(packages, d))) list.push(path.join(packages, d, sub, 'bin', exe));
      }
    } catch { /* no winget packages */ }
  }
  list.push(`C:/ffmpeg/bin/${exe}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`);
  return list;
}

const tools = {};
function toolPath(name) {
  if (!tools[name]) tools[name] = toolCandidates(name).find(p => fs.existsSync(p)) || name; // fall back to PATH
  return tools[name];
}

function run(cmd, args, { maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

let infoCache = null;
/** { available, path, version } — cached once ffmpeg answers. */
export async function ffmpegInfo() {
  if (infoCache?.available) return infoCache;
  try {
    const { stdout } = await run(toolPath('ffmpeg'), ['-version']);
    const version = /ffmpeg version (\S+)/.exec(stdout)?.[1] || '?';
    infoCache = { available: true, path: toolPath('ffmpeg'), version };
  } catch (err) {
    tools.ffmpeg = null; // try to locate it again next time (e.g. right after an install)
    infoCache = { available: false, path: null, error: err.code === 'ENOENT' ? 'Không tìm thấy ffmpeg' : err.message };
  }
  return infoCache;
}

/** Duration / size / audio presence of a media file. */
export async function probe(file) {
  const { stdout } = await run(toolPath('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find(s => s.codec_type === 'video');
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  const duration = Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;
  const [num, den] = String(v?.r_frame_rate || '30/1').split('/').map(Number);
  const rotated = Math.abs(Number(v?.side_data_list?.find(s => s.rotation != null)?.rotation || v?.tags?.rotate || 0)) % 180 === 90;
  return {
    duration: Math.round(duration * 100) / 100,
    width: rotated ? v?.height : v?.width, height: rotated ? v?.width : v?.height,
    fps: den ? Math.round((num / den) * 100) / 100 : 30,
    hasVideo: Boolean(v), hasAudio: Boolean(a),
  };
}

/** Save the last frame of a video as a PNG (start frame of the next, continuing clip). */
export async function lastFrame(videoFile, outFile) {
  for (const back of ['-0.1', '-0.4', '-1']) {
    try {
      await run(toolPath('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', '-sseof', back, '-i', videoFile, '-frames:v', '1', '-update', '1', outFile]);
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return outFile;
    } catch { /* try a bit earlier in the clip */ }
  }
  throw new Error('Không lấy được khung cuối của video (cần ffmpeg).');
}

// ---------- request → ffmpeg plan ----------
const clamp = (n, lo, hi, dflt) => { const x = Number(n); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt; };
const even = n => Math.max(2, Math.round(n / 2) * 2);
const hexColor = (c, dflt) => (/^#?[0-9a-f]{6}$/i.test(String(c || '')) ? '0x' + String(c).replace('#', '') : dflt);
// Inside a filtergraph a quoted path still needs ':' and '\' escaped
const fpath = p => `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")}'`;
const fnum = n => String(Math.round(n * 1000) / 1000);

function fontFile(key) {
  const list = FONTS[key] || FONTS.arial;
  return list.find(p => fs.existsSync(p)) || Object.values(FONTS).flat().find(p => fs.existsSync(p)) || null;
}

/**
 * Validate the page's request and resolve it into numbers ffmpeg needs.
 * `resolve(url)` maps /outputs/… and /uploads/… URLs to local files (throws when missing).
 */
export async function planEdit(body, resolve) {
  const clipsIn = Array.isArray(body.clips) ? body.clips.slice(0, 20) : [];
  if (!clipsIn.length) throw Object.assign(new Error('Chưa chọn video nào.'), { status: 400 });

  const transition = TRANSITIONS[body.transition?.type] ? body.transition.type : 'fade';
  const tDur = transition === 'none' ? 0 : clamp(body.transition?.duration, 0.2, 2, 0.5);
  const fadeIn = clamp(body.fadeIn, 0, 3, 0.5);
  const fadeOut = clamp(body.fadeOut, 0, 3, 0.5);

  const clips = [];
  for (const [i, c] of clipsIn.entries()) {
    const file = resolve(c.file);
    const still = IMAGE_RE.test(file);
    const info = await probe(file);
    if (!info.hasVideo) throw Object.assign(new Error(`Video ${i + 1} không có hình.`), { status: 400 });
    if (still) { info.duration = MAX_STILL_SECONDS; info.hasAudio = false; }
    const start = still ? 0 : clamp(c.start, 0, Math.max(0, info.duration - 0.5), 0);
    const end = still ? clamp(Number(c.end) - Number(c.start || 0), 0.5, MAX_STILL_SECONDS, 3)
      : clamp(c.end, start + 0.5, info.duration, info.duration);
    const len = Math.round((end - start) * 100) / 100;
    const minLen = Math.max(1, (i === 0 || i === clipsIn.length - 1 ? 1 : 2) * tDur + 0.2);
    if (len < minLen) {
      throw Object.assign(new Error(`Video ${i + 1} chỉ dài ${len}s — cần ít nhất ${fnum(minLen)}s với chuyển cảnh ${tDur}s. Giảm thời gian chuyển cảnh hoặc cắt ít hơn.`), { status: 400 });
    }
    const text = String(c.text?.content || '').replace(/\r/g, '').trim().slice(0, 200);
    clips.push({
      file, info, start, len, still,
      text: text ? { content: text, position: TEXT_POSITIONS.includes(c.text?.position) ? c.text.position : 'bottom' } : null,
    });
  }

  const first = clips[0].info;
  const W = even(clamp(body.width, 240, 4096, first.width || 1080));
  const H = even(clamp(body.height, 240, 4096, first.height || 1920));
  const base = Math.min(W, H);
  const ts = body.textStyle || {};
  const textStyle = {
    font: fontFile(ts.font),
    size: Math.round(clamp(ts.size, 20, 200, Math.round(base * 0.055))),
    color: hexColor(ts.color, 'white'),
    box: ts.box !== false,
    boxColor: hexColor(ts.boxColor, 'black'),
    boxAlpha: clamp(ts.boxAlpha, 0, 1, 0.45),
    fade: clamp(ts.fade, 0, 1.5, 0.4),
  };
  if (clips.some(c => c.text) && !textStyle.font) throw new Error('Không tìm thấy font chữ nào trên máy (cần C:/Windows/Fonts/arialbd.ttf).');

  const keepAudio = body.audio !== 'mute';
  const music = body.music?.file ? {
    file: resolve(body.music.file),
    volume: clamp(body.music.volume, 0, 1.5, 0.3),
  } : null;
  const wm = body.watermark?.file ? {
    file: resolve(body.watermark.file),
    position: WM_POSITIONS.includes(body.watermark.position) ? body.watermark.position : 'tr',
    size: clamp(body.watermark.size, 0.05, 0.6, 0.18),
    opacity: clamp(body.watermark.opacity, 0.05, 1, 0.85),
    margin: Math.round(clamp(body.watermark.margin, 0, 200, Math.round(base * 0.03))),
  } : null;

  const total = Math.round((clips.reduce((s, c) => s + c.len, 0) - (clips.length - 1) * tDur) * 100) / 100;
  return { clips, W, H, transition, tDur, fadeIn: Math.min(fadeIn, total / 3), fadeOut: Math.min(fadeOut, total / 3), textStyle, keepAudio, music, wm, total };
}

/** Build the ffmpeg argument list + filter script for a plan. Returns { args, total }. */
function buildArgs(plan, workDir, outFile) {
  const { clips, W, H, transition, tDur, fadeIn, fadeOut, textStyle, keepAudio, music, wm, total } = plan;
  const args = ['-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1'];
  clips.forEach(c => {
    if (c.still) { args.push('-loop', '1', '-framerate', String(FPS), '-t', fnum(c.len), '-i', c.file); return; }
    if (c.start > 0) args.push('-ss', fnum(c.start));
    args.push('-t', fnum(c.len), '-i', c.file);
  });
  const musicIdx = music ? clips.length : -1;
  if (music) args.push('-stream_loop', '-1', '-i', music.file);
  const wmIdx = wm ? clips.length + (music ? 1 : 0) : -1;
  if (wm) args.push('-i', wm.file);

  const f = [];
  const textY = { top: fnum(H * 0.1), center: '(h-text_h)/2', bottom: `h-text_h-${fnum(H * 0.14)}` };
  clips.forEach((c, i) => {
    f.push(`[${i}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
    if (c.text) {
      const txt = path.join(workDir, `text_${i}.txt`);
      fs.writeFileSync(txt, c.text.content, 'utf8');
      const box = textStyle.box ? `:box=1:boxcolor=${textStyle.boxColor}@${fnum(textStyle.boxAlpha)}:boxborderw=${Math.round(textStyle.size * 0.35)}` : ':borderw=2:bordercolor=black@0.6';
      const tf = Math.min(textStyle.fade, c.len / 3);
      f.push(`color=c=black@0.0:s=${W}x${H}:r=${FPS}:d=${fnum(c.len)},format=rgba,` +
        `drawtext=fontfile=${fpath(textStyle.font)}:textfile=${fpath(txt)}:fontsize=${textStyle.size}:fontcolor=${textStyle.color}` +
        `:x=(w-text_w)/2:y=${textY[c.text.position]}:line_spacing=${Math.round(textStyle.size * 0.2)}${box}` +
        (tf > 0 ? `,fade=t=in:st=0:d=${fnum(tf)}:alpha=1,fade=t=out:st=${fnum(c.len - tf)}:d=${fnum(tf)}:alpha=1` : '') + `[t${i}]`);
      f.push(`[v${i}][t${i}]overlay=0:0:format=auto:shortest=1,format=yuv420p[vt${i}]`);
    } else {
      f.push(`[v${i}]null[vt${i}]`);
    }
    if (keepAudio) {
      f.push(c.info.hasAudio
        ? `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=0:${fnum(c.len)},apad=whole_dur=${fnum(c.len)}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${fnum(c.len)},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });

  // Join
  let v = 'vt0', a = 'a0';
  if (clips.length > 1) {
    if (transition === 'none') {
      f.push(clips.map((_, i) => `[vt${i}]`).join('') + `concat=n=${clips.length}:v=1:a=0[vx]`);
      v = 'vx';
      if (keepAudio) { f.push(clips.map((_, i) => `[a${i}]`).join('') + `concat=n=${clips.length}:v=0:a=1[ax]`); a = 'ax'; }
    } else {
      let offset = 0;
      for (let k = 1; k < clips.length; k++) {
        offset += clips[k - 1].len - tDur;
        f.push(`[${v}][vt${k}]xfade=transition=${transition}:duration=${fnum(tDur)}:offset=${fnum(offset)}[vx${k}]`);
        v = `vx${k}`;
        if (keepAudio) { f.push(`[${a}][a${k}]acrossfade=d=${fnum(tDur)}:c1=tri:c2=tri[ax${k}]`); a = `ax${k}`; }
      }
    }
  }

  // Black fade in / out
  const fades = [];
  if (fadeIn > 0) fades.push(`fade=t=in:st=0:d=${fnum(fadeIn)}:color=black`);
  if (fadeOut > 0) fades.push(`fade=t=out:st=${fnum(Math.max(0, total - fadeOut))}:d=${fnum(fadeOut)}:color=black`);
  f.push(`[${v}]${fades.length ? fades.join(',') : 'null'}[vf]`);
  v = 'vf';

  // Watermark
  if (wm) {
    const m = wm.margin;
    const pos = { tl: `${m}:${m}`, tr: `W-w-${m}:${m}`, bl: `${m}:H-h-${m}`, br: `W-w-${m}:H-h-${m}` }[wm.position];
    f.push(`[${wmIdx}:v]scale=${even(W * wm.size)}:-2,format=rgba,colorchannelmixer=aa=${fnum(wm.opacity)}[wm]`);
    f.push(`[${v}][wm]overlay=${pos}:format=auto,format=yuv420p[vw]`);
    v = 'vw';
  }

  // Audio: clip sound (faded with the picture) and/or looped music
  let aout = null;
  if (keepAudio) {
    const af = [];
    if (fadeIn > 0) af.push(`afade=t=in:st=0:d=${fnum(fadeIn)}`);
    if (fadeOut > 0) af.push(`afade=t=out:st=${fnum(Math.max(0, total - fadeOut))}:d=${fnum(fadeOut)}`);
    f.push(`[${a}]${af.length ? af.join(',') : 'anull'}[af]`);
    aout = 'af';
  }
  if (music) {
    const mo = Math.min(2, total / 2);
    f.push(`[${musicIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${fnum(music.volume)},` +
      `atrim=0:${fnum(total)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fnum(Math.min(1, mo))},afade=t=out:st=${fnum(total - mo)}:d=${fnum(mo)}[mus]`);
    if (aout) { f.push(`[${aout}][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]`); aout = 'amix'; }
    else aout = 'mus';
  }

  const script = path.join(workDir, 'filter.txt');
  fs.writeFileSync(script, f.join(';\n'), 'utf8');
  // "-/opt file" = read the option's value from a file (ffmpeg ≥ 7; -filter_complex_script is gone in 9)
  args.push('-/filter_complex', script, '-map', `[${v}]`);
  if (aout) args.push('-map', `[${aout}]`, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-movflags', '+faststart', '-t', fnum(total), outFile);
  return { args, total };
}

// ---------- jobs ----------
const jobs = new Map();
let current = null;

export function jobView(j) {
  if (!j) return null;
  const { id, status, progress, output, error, total, createdAt, finishedAt, clips } = j;
  return { id, status, progress, output, error, total, createdAt, finishedAt, clips, running: status === 'running' };
}
export const getJob = id => jobs.get(id) || null;
export const currentJob = () => current;
export const editBusy = () => current?.status === 'running';

/**
 * Start rendering in the background. `outFile` is the mp4 to write; `toUrl(file)` turns it into a page URL.
 * Returns the job right away; poll getJob(id) for progress.
 */
export function startEdit(plan, outFile, toUrl) {
  if (editBusy()) throw Object.assign(new Error('Đang ghép một video khác — chờ xong đã.'), { status: 409 });
  const id = `e_${Date.now()}`;
  const workDir = path.join(TMP_DIR, id);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const job = {
    id, status: 'running', progress: 0, output: null, error: null, total: plan.total,
    clips: plan.clips.length, createdAt: new Date().toISOString(), finishedAt: null, child: null,
  };
  jobs.set(id, job);
  current = job;

  let args;
  try {
    ({ args } = buildArgs(plan, workDir, outFile));
  } catch (err) {
    finish(job, 'error', err.message, workDir);
    return job;
  }
  logger.info('Edit: ffmpeg start', { id, clips: job.clips, total: plan.total, out: path.basename(outFile) });
  const child = spawn(toolPath('ffmpeg'), args, { windowsHide: true });
  job.child = child;
  const errTail = [];
  let outBuf = '';
  child.stdout.on('data', d => {
    outBuf += d.toString();
    const lines = outBuf.split('\n');
    outBuf = lines.pop();
    for (const line of lines) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
      if (m && plan.total > 0) job.progress = Math.min(99, Math.round((Number(m[1]) / 1e6 / plan.total) * 100));
    }
  });
  child.stderr.on('data', d => { for (const l of d.toString().split('\n')) if (l.trim()) { errTail.push(l.trim()); if (errTail.length > 40) errTail.shift(); } });
  child.on('error', err => finish(job, 'error', err.code === 'ENOENT' ? 'Không chạy được ffmpeg (chưa cài?).' : err.message, workDir));
  child.on('close', code => {
    if (job.status !== 'running') return; // cancelled
    if (code === 0 && fs.existsSync(outFile)) {
      job.output = toUrl(outFile);
      job.progress = 100;
      finish(job, 'done', null, workDir);
    } else {
      const reason = [...errTail].reverse().find(l => /error|invalid|failed|no such|not found|cannot/i.test(l)) || errTail.at(-1) || `ffmpeg thoát mã ${code}`;
      logger.warn('Edit: ffmpeg failed', { id, code, tail: errTail.slice(-8) });
      finish(job, 'error', reason, workDir);
    }
  });
  return job;
}

export function cancelEdit(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return job || null;
  job.status = 'cancelled';
  job.finishedAt = new Date().toISOString();
  try { job.child?.kill(); } catch { /* already gone */ }
  return job;
}

function finish(job, status, error, workDir) {
  job.status = status;
  job.error = error;
  job.finishedAt = new Date().toISOString();
  job.child = null;
  fs.rm(workDir, { recursive: true, force: true }, () => {});
  if (status === 'done') logger.info('Edit: done', { id: job.id, output: job.output });
}
