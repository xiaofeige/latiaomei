'use strict';
// 离线冒烟（v12）：不渲染、不烧产能，只验“先理解图片 → 再分镜 → 素材指派对不对题”这条链路。
// 用法：node tools/pipeline/smoke/vision_storyboard.js [图片路径...]
// 不带参数时用任务13的 4 张真实上传图（父女装视频）。
const fs = require('fs');
const path = require('path');
const media = require('../lib/media');
const vision = require('../lib/vision');
const { chat } = require('../lib/llm');

const PROMPT = process.env.SMOKE_PROMPT || '视频突出父女俩长很像，互动很好玩。用微信视频电话风格';
const DEFAULTS = [
  '99dfbfcd3146d153', '252025f396337309', 'd3193b092e24eb01', '1ae7369a1572f179',
].map((f) => `/data/www/latiaomei/data/uploads/2026/09/${f}.jpg`);

const MISSION_PERSONA = `你是短视频编导，口吻口语化、有钩子，不写营销号腔、不堆形容词、不用绝对化用语（广告法）。
铁律：只能基于给定的制片提示词与素材描述进行创作，严禁编造没出现的人物、动作、食物、场景；
旁白（vo）必须与画面文案（title/sub）说的是同一件事，连起来是一个完整故事。`;

(async () => {
  const images = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
  if (!vision.available()) { console.error('LLM_VISION_MODEL 未配置，理解环节会整体降级（此冒烟要求配置）'); process.exit(2); }
  const dir = fs.mkdtempSync('/data/tmp/hf/smoke-vm-');
  const assets = [];
  for (let i = 0; i < images.length; i++) {
    const buf = fs.readFileSync(images[i]);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', `a${i}.jpg`), buf);
    assets.push({ no: assets.length + 1, name: `a${i}.jpg` });
  }
  console.log('== 1) 素材理解');
  for (const a of assets) {
    a.desc = await vision.describe(path.join(dir, 'assets', a.name), PROMPT.slice(0, 120)) || '（未知）';
    console.log(`   素材${a.no}: ${a.desc}`);
  }
  console.log('== 2) 分镜（带素材描述）');
  const script = await chat([
    { role: 'system', content: MISSION_PERSONA + '\n任务：产出 1080x1920 竖屏短视频分镜脚本，9-11 个场景、总时长约 50 秒（每镜 4-6 秒）。输出 JSON。' },
    { role: 'user', content: JSON.stringify({
      制片提示词: PROMPT,
      素材: assets.map((a) => ({ 序号: a.no, 内容: a.desc })),
      输出格式: {
        scenes: [{ kicker: '小标签≤8字', title: '主文案≤16字', sub: '辅文案≤22字', dur: '4-6', vo: '旁白≤22字', img: `素材序号 1-${assets.length}，不贴合填 0`, search: '仅 img=0 时填', video: '有素材一律 false' }],
        caption: '≤120字', hashtags: ['5个'],
      },
      约束: '有素材时画面以素材为主；画面内容只能是提示词/素材里有的东西（没提到吃就不要写吃）；旁白 vo 与画面文案必须对应同一画面。最后一个场景固定是 CTA。不出现绝对化用语。',
    }) },
  ], { json: true, maxTokens: 4000 });
  const scenes = script.scenes || [];
  let bad = 0;
  console.log('== 3) 逐镜对应检查（画面=素材描述 vs title/vo）');
  scenes.forEach((s, i) => {
    const a = assets.find((x) => x.no === Number(s.img));
    console.log(`   镜${i + 1} [img=${s.img ?? '-'}] ${a ? a.desc.slice(0, 18) : '无素材'}\n        文案: ${s.title} / ${s.sub}\n        旁白: ${s.vo}`);
    if (!a && !s.search) bad++;
  });
  console.log('caption:', script.caption);
  const food = scenes.filter((s) => /吃|片儿川|葱包桧|美食|餐厅|点菜/.test(`${s.title}${s.sub}${s.vo}`)).length;
  console.log(`\n结果: ${scenes.length} 镜；指派素材 ${scenes.filter((s) => Number(s.img) > 0).length} 镜；无素材且无检索词 ${bad} 镜；美食词乱入 ${food} 处（提示词没提吃，理想=0）`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(bad > 0 || food > 2 ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
