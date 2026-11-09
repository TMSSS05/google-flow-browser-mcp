// Trending data sources for outfit ideas.
//  • TikTok Creative Center — trending hashtags per country. No public API: the page embeds its
//    data (server-rendered) in <script id="__MODERN_ROUTER_DATA__">, so we open it in the shared
//    Chrome and read that. Logged out, TikTok only returns the top 3; logged in to a (free)
//    TikTok for Business account in that Chrome, it returns more.
//  • Google Trends — daily trending searches per country via the official RSS feed.
import fs from 'fs';
import path from 'path';
import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const DATA_DIR = path.resolve(get('flowHome', '.'), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'trends.json');

export const APPAREL_INDUSTRY = '22000000000'; // "Apparel & Accessories" in Creative Center
const INDUSTRY_LABELS = { [APPAREL_INDUSTRY]: 'Thời trang & phụ kiện' };

export const ttHashtagPage = (country, period) =>
  `https://ads.tiktok.com/creative/creativeCenter/trends/hashtag?countryCode=${encodeURIComponent(country)}&period=${period}&region=${encodeURIComponent(country)}`;

/** Read the embedded react-query state of a Creative Center page. */
async function readEmbeddedRows(page) {
  return page.evaluate(() => {
    const el = document.getElementById('__MODERN_ROUTER_DATA__')
      || [...document.scripts].find(s => /hashtagName/.test(s.textContent || ''));
    if (!el) return { rows: [], meta: null, countries: [] };
    const t = el.textContent || '';
    let parsed;
    try { parsed = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { return { rows: [], meta: null, countries: [] }; }
    const queries = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.queries)) queries.push(...o.queries);
      for (const v of Object.values(o)) walk(v);
    })(parsed);
    const hq = queries.find(q => JSON.stringify(q.queryKey || '').includes('hashtags'));
    const pages = hq?.state?.data?.pages || [];
    const fq = queries.find(q => JSON.stringify(q.queryKey || '').includes('Filter'));
    return {
      rows: pages.flatMap(p => p.data || []),
      meta: pages[0]?.pagination || null,
      countries: fq?.state?.data?.hashtagCountry || [],
    };
  });
}

function normalizeRow(r) {
  const curve = (r.popularityCurve || []).map(p => Number(p.value) || 0);
  const last = curve.at(-1) ?? 0;
  const prev = curve.length > 1 ? curve.at(-2) : last;
  return {
    id: String(r.hashtagID || r.hashtagName),
    name: r.hashtagName,
    rank: Number(r.rankIndex) || null,
    posts: Number(r.publishCnt) || 0,
    views: Number(r.vv) || 0,
    industries: r.industryIDs || [],
    industry: (r.industryIDs || []).map(id => INDUSTRY_LABELS[id] || 'Khác').join(', ') || 'Khác',
    apparel: (r.industryIDs || []).includes(APPAREL_INDUSTRY),
    curve,
    rising: last >= prev,
    creators: (r.topCreators || []).slice(0, 3).map(c => ({ name: c.nickName || c.nickname || '', avatar: c.avatarURL || '' })),
    url: `https://www.tiktok.com/tag/${encodeURIComponent(r.hashtagName)}`,
  };
}

/** Trending TikTok hashtags for a country over the last `period` days (7 / 30 / 120). */
export async function fetchTikTokHashtags(context, { country = 'VN', period = 7 } = {}) {
  const page = await context.newPage();
  const extra = []; // rows loaded later by the page itself (e.g. "View more" when logged in)
  page.on('response', async (resp) => {
    try {
      const rt = resp.request().resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return;
      const text = await resp.text();
      if (!text.includes('hashtag_name') && !text.includes('hashtagName')) return;
      const json = JSON.parse(text);
      const list = json?.data?.list || json?.data?.data || json?.data || [];
      for (const r of Array.isArray(list) ? list : []) {
        extra.push({
          hashtagID: r.hashtag_id || r.hashtagID, hashtagName: r.hashtag_name || r.hashtagName,
          rankIndex: r.rank || r.rankIndex, publishCnt: r.publish_cnt || r.publishCnt, vv: r.video_views || r.vv,
          industryIDs: r.industry_info ? [String(r.industry_info.id)] : r.industryIDs,
          popularityCurve: (r.trend || r.popularityCurve || []).map(p => ({ value: p.value })),
        });
      }
    } catch { /* not a hashtag list */ }
  });
  try {
    await page.goto(ttHashtagPage(country, period), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    const { rows, meta, countries } = await readEmbeddedRows(page);
    // Logged in, "View more" loads further pages (caught by the response listener above).
    // Logged out it sends you to the login page instead — so only try when not capped at 3.
    if ((meta?.limit ?? 0) > 3) {
      const listUrl = page.url();
      for (let i = 0; i < 4; i++) {
        const more = page.getByText(/^(view more|xem thêm)$/i).first();
        if (!(await more.isVisible().catch(() => false))) break;
        await more.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
        await page.waitForTimeout(2500);
        if (page.url() !== listUrl) break; // navigated away (login wall)
      }
    }
    const byName = new Map();
    for (const r of [...rows, ...extra]) if (r?.hashtagName && !byName.has(r.hashtagName)) byName.set(r.hashtagName, normalizeRow(r));
    const list = [...byName.values()].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    const limited = (meta?.limit ?? list.length) <= 3 && list.length <= 3;
    logger.info('TikTok trends fetched', { country, period, count: list.length, limited });
    return { hashtags: list, limited, countries, source: ttHashtagPage(country, period) };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Google Trends daily trending searches (official RSS). */
export async function fetchGoogleTrends(geo = 'VN') {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'hat-studio/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Google Trends HTTP ${res.status}`);
  const xml = await res.text();
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return m ? m[1].trim() : '';
  };
  const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
    title: decode(pick(m[1], 'title')),
    traffic: decode(pick(m[1], 'ht:approx_traffic')),
    news: decode(pick(m[1], 'ht:news_item_title')),
  })).filter(i => i.title);
  return { items, source: url };
}

export function loadTrendsCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch { return null; }
}
export function saveTrendsCache(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}
