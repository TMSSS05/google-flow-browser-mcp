// Read a product document (PDF / text / product photo) with Claude and return
// structured fields to pre-fill the Affiliate Studio form.
// Needs Anthropic credentials (ANTHROPIC_API_KEY). Each call is billed by Anthropic.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { logger } from '../utils/logger.js';

const MODEL = 'claude-opus-5-5';

// Category ids must match the GUI's "Loại sản phẩm" options
const ProductInfo = z.object({
  product_name: z.string().describe('Short product name as sold, e.g. "Serum vitamin C 30ml"'),
  description: z.string().describe('One line describing what the product LOOKS like (packaging, color, shape, material) plus its key selling point — used to render it in an image'),
  category: z.enum(['fashion', 'beauty', 'home', 'tech', 'food']),
  usps: z.array(z.string()).describe('Up to 4 short selling points, in the document language'),
  headline: z.string().describe('Short ad headline (max ~8 words), in Vietnamese'),
  cta: z.string().describe('Short call to action, in Vietnamese, e.g. "Mua ngay"'),
  price: z.string().describe('Price as written in the document, or empty string if none'),
});

const TEXT_TYPES = new Set(['.txt', '.md', '.csv', '.json']);
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export const SUPPORTED_DOC_EXTS = ['.pdf', ...TEXT_TYPES, ...Object.keys(IMAGE_TYPES)];

let client = null;
export function hasCredentials() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function toContentBlock(ext, data) {
  if (ext === '.pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } };
  }
  if (IMAGE_TYPES[ext]) {
    return { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data: data.toString('base64') } };
  }
  if (TEXT_TYPES.has(ext)) {
    return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: data.toString('utf-8') } };
  }
  throw new Error(`Định dạng ${ext} chưa hỗ trợ. Dùng: ${SUPPORTED_DOC_EXTS.join(', ')}`);
}

/** @returns {Promise<z.infer<typeof ProductInfo>>} */
export async function extractProductInfo(ext, data) {
  if (!hasCredentials()) {
    throw new Error('Chưa có ANTHROPIC_API_KEY. Đặt biến môi trường rồi khởi động lại "npm run gui".');
  }
  client ??= new Anthropic();

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    // Simple extraction: low effort keeps it fast and cheap
    output_config: { effort: 'low', format: betaZodOutputFormat(ProductInfo) },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{
      role: 'user',
      content: [
        toContentBlock(ext, data),
        {
          type: 'text',
          text: 'This is a product document (spec sheet, listing, or product photo) for an affiliate ad. ' +
            'Extract the product information. Only use facts present in it; leave a field empty rather than inventing it.',
        },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude từ chối xử lý tài liệu này.');
  }
  if (!response.parsed_output) {
    throw new Error(`Không đọc được kết quả (stop_reason: ${response.stop_reason}).`);
  }
  logger.info('Product info extracted', {
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  });
  return response.parsed_output;
}
