// Turn trend signals (TikTok hashtags, Google searches) into outfit presets via Gemini.
// Each idea becomes an "outfit" option of the shot builder: { label (VI), text (EN, "wearing …") }.

/** Prompt asking Gemini for outfit ideas as a JSON array. */
export function outfitIdeasPrompt({ hashtags = [], searches = [], hat = '', country = 'Việt Nam', count = 8 }) {
  const tags = hashtags.map(h => `#${h}`).join(', ');
  return [
    `Bạn là stylist thời trang cho nhãn hàng mũ bán trên TikTok Shop ở ${country}.`,
    tags ? `Các hashtag đang trend trên TikTok: ${tags}.` : '',
    searches.length ? `Các từ khoá đang được tìm nhiều trên Google: ${searches.join(', ')}.` : '',
    `Hãy tìm hiểu (có thể tra web) các bộ trang phục nữ đang thịnh hành trên TikTok ${country} lúc này liên quan tới những xu hướng trên,`,
    `rồi đề xuất ${count} outfit cụ thể phối đẹp với ${hat ? `chiếc mũ: ${hat}` : 'một chiếc mũ thời trang'}.`,
    'Mỗi outfit phải mô tả được bằng hình ảnh (món đồ, màu, chất liệu, kiểu dáng), không nhắc thương hiệu.',
    'CHỈ trả về một khối ```json chứa mảng, không viết gì thêm. Mỗi phần tử có dạng:',
    '{"label": "tên ngắn tiếng Việt (≤ 5 từ)", "text": "English phrase starting with \\"wearing\\" describing the outfit for an image prompt", "why": "1 câu tiếng Việt: vì sao đang hot", "tags": ["hashtag liên quan"]}',
  ].filter(Boolean).join('\n');
}

/** Pull the JSON array out of Gemini's answer (it may wrap it in prose or a code block). */
export function parseOutfitIdeas(answer) {
  const text = String(answer || '');
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [block, text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)].filter(Boolean);
  for (const c of candidates) {
    try {
      const arr = JSON.parse(c);
      if (!Array.isArray(arr)) continue;
      const ideas = arr
        .map(o => ({
          label: String(o.label || '').trim().slice(0, 60),
          text: String(o.text || '').trim().replace(/^(?!wearing\b)/i, 'wearing ').slice(0, 500),
          why: String(o.why || '').trim().slice(0, 300),
          tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 5) : [],
        }))
        .filter(o => o.label && o.text.length > 'wearing '.length);
      if (ideas.length) return ideas;
    } catch { /* try the next candidate */ }
  }
  throw new Error('Không đọc được danh sách outfit từ câu trả lời của Gemini. Thử lại nhé.');
}

/** Prompt for a flat-lay reference image of one outfit (no person, no brand). */
export function flatlayPrompt(outfitText) {
  const what = outfitText.replace(/^wearing\s+/i, '');
  return [
    `Create a photorealistic flat-lay product photo of this complete women's outfit: ${what}.`,
    'All garments neatly laid out flat on a plain light-grey background, seen from directly above, evenly lit with soft shadows.',
    'No person, no mannequin, no hat, no text, no logos, no watermark. Square 1:1 image. Only return the image.',
  ].join(' ');
}
