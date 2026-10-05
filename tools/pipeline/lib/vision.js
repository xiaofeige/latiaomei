'use strict';
// 图片理解（v12）：素材/联网图「先看内容、再决定怎么用」。
// 背景：分镜 LLM 只拿到“图片数量”这个数字，从没见过图本身，img 序号是盲填的；
// 联网图只过魔数/体积，Bing 给什么塞什么 → 成片图文不符（v12 修的根因）。
// 降级铁律：未配置 LLM_VISION_MODEL 或调用失败时返回 null，调用方自行降级，绝不卡流水线。
const fs = require('fs');
const path = require('path');
const { chat } = require('./llm');
const { CFG } = require('./env');

const model = () => (process.env.LLM_VISION_MODEL || '').trim();
const available = () => !!model() && !!CFG.llmKey;

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
function dataUri(file) {
  const b = fs.readFileSync(file);
  return `data:${MIME[path.extname(file).toLowerCase()] || 'image/jpeg'};base64,${b.toString('base64')}`;
}

// 描述一张图：主体/特征/场景/动作，≤40 字，供分镜 LLM 按内容指派素材。失败返回 null。
async function describe(file, hint = '') {
  if (!available()) return null;
  try {
    const r = await chat([
      { role: 'system', content: '你是图片内容标注员。看给定图片，用一句中文（≤40字）客观描述：画面主体（人/动物/食物/建筑/物品）、外观特征、场景、动作。有明显水印要注明“有水印”。只说看得见的，不猜测、不编造。' },
      { role: 'user', content: [
        { type: 'text', text: hint ? `视频主题：${hint}\n描述这张素材图：` : '描述这张图：' },
        { type: 'image_url', image_url: { url: dataUri(file) } },
      ] },
    ], { model: model(), temperature: 0.2, maxTokens: 300 });
    const t = String(r).trim().replace(/^["“]|["”]$/g, '');
    return t && t.length <= 200 ? t : null;
  } catch { return null; }
}

// 校验图片是否配得上某个检索词/主题：true 可用 / false 不匹配或带水印 / null 无法判定（模型不可用）。
async function matches(file, query) {
  if (!available()) return null;
  try {
    const r = await chat([
      { role: 'system', content: '你是短视频素材审核员。判断图片能否直接用作给定检索词的画面。主体不符（人种/菜品/场景/地标对不上）、有明显水印、糊图或截图带 UI 的，一律不合格。输出 JSON：{"ok":true|false,"why":"≤20字"}' },
      { role: 'user', content: [
        { type: 'text', text: `检索词：${query}\n这张图能用吗？` },
        { type: 'image_url', image_url: { url: dataUri(file) } },
      ] },
    ], { model: model(), json: true, temperature: 0, maxTokens: 120 });
    return r && typeof r.ok === 'boolean' ? r.ok : null;
  } catch { return null; }
}

module.exports = { available, describe, matches };
