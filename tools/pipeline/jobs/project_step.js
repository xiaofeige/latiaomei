'use strict';
// project_step（v13 项目制内容生产）：一条 step = 一次交互，跑完回填结果，
// 辣条妹在工作区看效果、改提示词/素材/分镜，再跑下一轮。三种步骤：
//   storyboard  制片提示词 + 素材描述 + 主角定妆图 → LLM 出分镜 JSON（人可手改）
//   video       按（可能被人改过的）分镜渲染成片：人物动态镜头交 happyhorse 生成，
//               其余镜头 hyperframes 图卡；产物挂 douyin 待审稿
//   copy        按项目主题产四平台文案 → social_items 待审
// 铁律不变：本 job 零发布动作，放行权在辣条妹；happyhorse 不可用自动退回纯图卡。
const fs = require('fs');
const path = require('path');
const api = require('../lib/api');
const { chat } = require('../lib/llm');
const R = require('../lib/render');
const media = require('../lib/media');
const A = require('../lib/audio');
const vision = require('../lib/vision');
const social = require('../lib/social');
const pub = require('../lib/publishers');
const hh = require('../lib/happyhorse');
const OM = require('../lib/openmontage');
const { CFG } = require('../lib/env');

// 软上限（只告警不截不补）：成片超出这个数提醒一句“台词写多了”，要短版请减镜或缩 vo。
const CAP_HINT = Number(process.env.VIDEO_TARGET_SECS || 0);

// 成片时长不做硬目标（2026-10-06 修订）：镜头长度由“该镜旁白念多久”与
// “happyhorse 片段实际多长”决定，成片 = 各镜之和。payload.secs / script.target_secs
// 只当体检参考（超出只告警），不参与补齐/硬截。
// 主角设定（v13）：视频里出现的人物主角统一是"辣条妹"3D 形象，
// 定妆参考图（三视图/特写）由服务端 settings 下发，happyhorse 镜头拿它保人物一致性。
const CHAR_BRIEF = `主角设定（全片人物镜头统一用这一形象，不得改设定）：
辣条妹——3D 卡通写实风少女，红棕色双丸子头（黄色发圈），圆框黑眼镜，
白色连帽卫衣 + 橙色围裙（胸前黄色"辣"字牌），深蓝牛仔裤，白鞋，常手持不锈钢锅铲。
参考图：三视图（正/侧/背）与脸部特写；happyhorse i2v 镜头以定妆特写（或本镜指派的项目实拍图）
做首帧，形象从首帧就锁死，hh_prompt 只写动作与镜头运动。
本期固定身份：新闻主播——白卫衣+橙围裙不变，在美食新闻栏目《辣妹快报》里坐主播台/站演播室播报。
人设口头禅与金句（必须记进每条片子里）：
- 招牌口头禅：「嘎嘎香」（形容东西香、好吃，辣条妹挂在嘴边）；
- 招牌金句：「这盘菜，够我干六碗米饭！」（可换菜品/量词，每期至少出现一次，写进记忆点）；
- 爱用杭州话：「落胃」（舒服、对胃口）；
- 说话风格：激情饱满、嘢啰有味、像拉街坊下馆子，不是冷面念稿。`;

// 视频基调风格（STYLE.md，全流水线定稿）：新闻联播式美食播报，后续出片一律按此风格。
const NEWS_STYLE = `全片风格基调（铁律，每期不变）：《辣妹快报》——新闻联播架子 + 辣条妹烟火气的美食新闻栏目。
① 开场必须辣条妹真人出镜播报（第 1 镜 hh=true 且 talk=true）：主播台开口播报本条头条，
开场词固定句式：「各位吃货观众晚上好，我是辣条妹，欢迎收看辣妹快报！今日给大家推荐一道菜——XX，嘎嘎香，够我干六碗米饭！」（XX 换本期真实菜名，开场镜整句控制在 45 字内，更长就拆成两镜）；
这种主播镜头时长会自动对齐旁白长度，vo 就是她嘴里念的话，写得口语、短句、有激情；
② 中段每隔 1-2 镜就要有一个辣条妹真人出镜镜头（全片有人镜头占比过半，禁连 3 镜没人），动作要多样不要重复：
插播点评镜（hh=true, talk=true，面对镜头说一句如「真的，这盘我在御膳房连吃三回，嘎嘎香！」，嘴型由音频驱动）；
出镜动作镜（hh=true, talk=false）：端菜上桌、揭盖尝香、夹筷试吃、竖锅铲介绍、解围裙走向灶台、绕桌走动等，一镜一个动作不重样；
做菜/试吃类不说话镜头标 talk=false（闭嘴做动作）；
③ 画面右上角常驻「本期美食」窗口：每个镜头用 pip 字段指派窗口里要展示的美食实拍素材序号（1-N，可与 img 相同，无贴合填 0）；
④ 叙事像讲一个完整故事（不是字卡轮播）：开场报菜 → 这道菜的来历/做法看点（干萝卜怎么吸味、牛肚怎么处理才弹）→ 口感层次（先辣后香、锅气、落胃）→ 分量价格/环境人气 → 点单攻略 → 收尾 CTA 重申金句「够我干六碗米饭」，按素材真实有什么取舍；
⑤ 旁白 vo：新闻主播腔架子 + 辣条妹的激情与烟火气，短句利落、先事实后点评，多用感叹句；
全片至少一次「嘎嘎香」、至少一次「这盘菜，够我干六碗米饭」式的金句，鼓动杭州话「落胃」；画面字幕 title/sub 与 vo 说同一件事。`;

// v15 全程主播口播基调（style=host，2026-10-06 辣条妹定稿）：整片就是辣条妹本人拿锅铲激情介绍，
// 菜品只出现在右上角「本期美食」窗口；不排图卡镜、不排闭嘴动作镜（实盘反馈：镜头一多模型就乱换景、
// 台词与唇形对不上，干脆镜镜都是人在说）。
const HOST_PERSONA = `全片风格基调（style=host，铁律）：辣条妹全程在镜口播——每一镜都是她半身出镜、
右手拿不锈钢锅铲，边说边指向右上角「本期美食」窗口里的菜；
① 每镜必须 hh=true 且 talk=true（音频驱动口型），禁止纯图卡镜、禁止闭嘴动作镜；
② 每镜 vo ≤18 字（约 4 秒）——台词短口型才稳，长句子拆成两镜，不许一口气念两句半；
③ 5-7 镜讲完一条：开场报菜名+金句 → 菜品看点（锅气/口感/来历）→ 分量价格或环境人气 → 点单攻略 → 收尾重申金句；
④ 每镜 pip 一律填本期菜品素材序号（没素材填 0），右上角窗口全程有菜；
⑤ 激情饱满：多用感叹句，口头禅「嘎嘎香」、杭州话「落胃」，收尾必带「够我干六碗米饭」。`;

const SB_PERSONA = `你是美食新闻栏目《辣妹快报》的编导兼主播文案（短视频竖屏）。架子像新闻主播：开场规范、播报利落；魂是辣条妹本人：激情、馋人、有记忆点、会讲故事——口头禅「嘎嘎香」、招牌金句「这盘菜，够我干六碗米饭！」、杭州话「落胃」都要写进台词；不写营销号腔、不堆形容词、不用绝对化用语（广告法）。
铁律：只能基于给定的制片提示词与素材描述进行创作，严禁编造没出现的人物、动作、食物、场景；
旁白（vo）必须与画面文案（title/sub）说的是同一件事，连起来是一个完整故事。`;

// 素材路径（/uploads/...）转本机可读 URL：Go 服务与 worker 同机，走回环最快。
const abs = (u) => (u && u.startsWith('/') ? CFG.apiBase + u : u);

async function run(task) {
  const p = task.payload || {};
  const projectId = Number(p.project_id) || 0;
  const stepId = Number(p.step_id) || 0;
  if (!projectId || !stepId) return { status: 'skipped', note: 'payload 缺 project_id/step_id' };
  const { project, assets, steps, char_refs, site } = await api.getProject(projectId);
  const step = (steps || []).find((s) => s.id === stepId);
  if (!step) return { status: 'skipped', note: `步骤 #${stepId} 不存在` };

  const dir = path.join(CFG.tmpDir, `job-ps${stepId}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    let out;
    if (step.kind === 'storyboard') out = await doStoryboard(task, { project, assets, char_refs });
    else if (step.kind === 'video') out = await doVideo(task, { project, assets, steps, char_refs, site, step, p, dir });
    else if (step.kind === 'copy') out = await doCopy(task, { project, steps, site, p });
    else out = { status: 'skipped', note: '未知步骤类型 ' + step.kind, result: {} };
    await api.finishProjectStep(stepId, out.status, JSON.stringify(out.result ?? {}), '', out.note || '').catch((e) => console.error('[project_step] 回填步骤失败:', e.message));
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 素材理解：项目素材 + 主角定妆图，逐张"看过"再交给分镜 LLM ----------
async function understandAssets(dir, assets, prompt) {
  const list = [];
  for (let i = 0; i < (assets || []).length; i++) {
    const a = (assets || [])[i];
    if (a.kind === 'file') continue; // 非图片素材不进画面轮转
    const got = await media.download(dir, abs(a.path), `a${list.length + 1}`, { kind: 'image' });
    if (!got) continue;
    const item = { no: list.length + 1, name: got.name, path: a.path };
    if (vision.available()) {
      item.desc = await vision.describe(path.join(dir, 'assets', got.name), prompt.slice(0, 120))
        || a.note || '（描述失败，内容未知）';
    } else {
      item.desc = a.note || '（未做内容理解，只知道是真实照片）';
    }
    list.push(item);
  }
  return list;
}

// ---------- 出分镜 ----------
async function doStoryboard(task, { project, assets, char_refs }) {
  const style = String(task.payload?.style || project.style || CFG.videoStyle || 'news');
  const hostMode = style === 'host';
  const prompt = [project.brief, task.payload?.prompt].filter(Boolean).join('\n');
  if (!prompt.trim()) return { status: 'skipped', note: '项目没有提示词' };
  const dir = path.join(CFG.tmpDir, `job-sb${task.id}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const mats = await understandAssets(dir, assets, prompt);
  fs.rmSync(dir, { recursive: true, force: true });
  mats.forEach((m) => console.log(`[storyboard] 素材${m.no} ${m.desc}`));

  const hhOn = hh.available();
  const script = await chat([
    { role: 'system', content: SB_PERSONA + (hostMode
      ? '\n任务：产出 1080x1920 竖屏【全程主播口播】分镜脚本：5-7 镜，每镜都是辣条妹在镜说话，每镜 vo ≤18 字（成片时长 = 各镜配音之和，不凑时长）。输出 JSON。'
      : '\n任务：产出 1080x1920 竖屏短视频分镜脚本。\n时长铁律（2026-10-06 修订）：成片长度跟着内容走，镜头多长取决于该镜旁白念多久（配音约 4-5 字/秒），禁止为凑时长注水。场景数量按制片提示词的内容体量定（一般 5-9 镜，内容少就 4-5 镜），不固定镜数、不固定总时长；dur 只当参考，真长会以 vo 实际朗读时长为准。vo 写短、写实，一镜一件事，不拆水话。输出 JSON。') },
    { role: 'user', content: JSON.stringify({
        制片提示词: prompt,
        主角: CHAR_BRIEF,
        风格基调: hostMode ? HOST_PERSONA : NEWS_STYLE,
        定妆参考图: (char_refs || []).map((c) => c.key),
        素材: mats.length ? mats.map((m) => ({ 序号: m.no, 内容: m.desc })) : '无图片素材（空镜可给 search 检索词联网找画面）',
        视频生成通道: hhOn ? (hostMode
          ? '已接入 happyhorse-1.1-i2v（图生视频 + 音频驱动口型）。本模式镜镜都是主播口播镜：每镜 hh=true、talk=true、ref=close；'
            + '机位/背景/持锅铲动作由出片端固定模板控制（你不用写 hh_prompt，最多写一句手势差异如“锅铲轻点两下”），'
            + 'vo 就是她嘴里念的词（≤18 字），片段时长自动跟配音对齐'
          : '已接入 happyhorse-1.1-i2v（图生视频，支持音频驱动口型：主播口播镜会拿该镜旁白配音喂给模型，嘴型跟台词同步，片段时长自动跟配音长度）。人物出镜镜头标 hh=true（最多 6 个）：第 1 镜主播开场、收尾 CTA 镜必须 hh=true+talk=true；中段每隔 1-2 镜安排一个出镜镜（插播点评 talk=true，或做菜/试吃动作镜 talk=false），保证有真人镜头占比过半，不要连续 3 镜没人；hh_prompt 一句中文（主体动作+镜头运动+氛围，15-60 字，专注写怎么动）；ref 填 close=定妆特写首帧 / asset=用本镜 img 那张素材做首帧') : '未配置，全部镜头 hh=false',
        输出格式: {
          scenes: [{
            kicker: '小标签≤8字',
            title: '主文案≤16字，短句有钩子',
            sub: '辅文案≤22字',
            dur: '本镜参考秒数 3-6（成片会按 vo 实际朗读长度自动定长）',
            vo: '旁白一句话 ≤20字，口语化、适合朗读，连起来是完整故事（这句就是镜头时长：念多久停多久）',
            img: `素材序号（按「内容」描述挑最贴合的，1-${Math.max(mats.length, 1)}）；没有贴合的填 0`,
            pip: `右上角「本期美食」窗口素材序号（1-${Math.max(mats.length, 1)}，选本镜想让观众看到的美食实拍图，可与 img 相同）；无素材填 0`,
            search: '仅当 img=0 且 hh=false 时填：联网找画面的检索词（中文，具象）',
            hh: '布尔：该镜是否要 happyhorse 生成动态画面（第 1 镜主播开场必须 true）',
            hh_prompt: 'hh=true 时填：动作+镜头运动描述（不必复述外观，首帧由 ref 图定）',
            talk: 'hh=true 时填布尔：辣条妹面对镜头开口说话=true（主播播报镜），做菜/试吃/不说话=false',
            ref: 'hh=true 时填 close|asset',
          }],
          caption: '发布文案，含钩子前15字，≤120字，贴合制片提示词主题',
          hashtags: ['5个话题标签，含 #辣条妹的御膳房'],
        },
        约束: hostMode
          ? '全程主播口播模式：镜镜 hh=true+talk=true、vo ≤18 字、pip 全指本期菜品素材；画面内容只能是提示词/素材里有的东西；旁白 vo 与画面字幕对应同一件事；最后一镜是 CTA 重申金句；不出现绝对化用语。'
          : '有素材时美食镜头画面以素材为主；画面内容只能是提示词/素材里有的东西；旁白 vo 与画面文案对应同一画面；最后一个场景固定是 CTA（主播出镜 talk=true）；不出现绝对化用语；全片按风格基调的新闻栏目结构写（开场主播出镜报菜+金句、中段每 2-3 镜有人、右上角美食窗口、像讲故事不是字卡轮播）。',
      }) },
  ], { json: true, maxTokens: 4500 });

  if (!Array.isArray(script.scenes) || !script.scenes.length) throw new Error('LLM 没产出任何分镜');
  // 素材序号 → 文件名映射在出片阶段重做（分镜可被人手改，这里只存"序号+路径"两份锚点）。
  const result = {
    scenes: script.scenes,
    caption: script.caption || '',
    hashtags: script.hashtags || [],
    asset_map: mats.map((m) => ({ no: m.no, path: m.path, desc: m.desc })),
    hh_ready: hhOn,
    prompt_used: prompt,
  };
  return { status: 'done', note: `分镜 ${result.scenes.length} 镜已出，等工作区确认/手改`, result };
}

// ---------- 出成片 ----------
async function doVideo(task, { project, assets, steps, char_refs, site, step, p, dir }) {
  // 1) 取分镜：指定 step / 最近一条 done 的 storyboard；被人手改过的 result 原样尊重。
  const sbId = Number(p.storyboard_step_id) || 0;
  let sb = null;
  const cands = (steps || []).filter((s) => s.kind === 'storyboard' && s.status === 'done' && s.result);
  if (sbId) sb = cands.find((s) => s.id === sbId);
  if (!sb) sb = cands[0]; // ListProjectSteps 新在前
  if (!sb) return { status: 'skipped', note: '没有可用分镜，先跑「出分镜」' };
  let script;
  try { script = JSON.parse(sb.result); } catch { throw new Error('分镜 result 不是合法 JSON'); }
  const scenes = (script.scenes || []).slice(0, 11);
  if (!scenes.length) throw new Error('分镜里没有场景');

  // 2) 素材落盘；定妆图走公网 URL（happyhorse i2v 的 first_frame 参考图必须公网可达，
  //    定妆图本就在本站 /uploads/charref/ 下，直接拼绝对 URL，不用下载）。
  const mats = await understandAssets(dir, assets, project.brief || '');
  const siteBase = (site && site.base_url) || CFG.apiBase;
  const refUrls = {};
  for (const c of char_refs || []) {
    refUrls[c.key === 'ip_char_three_view' ? 'three' : 'close'] = siteBase + c.path;
  }
  // 9:16 主播立绘作口播镜首选首帧：特写(1600²)/三视图(横图)会让 i2v 输出方形/横画幅，
  // 竖屏成片里被裁；立绘本就是 1080x1920，出镜镜生成出来的片段天然满屏竖版。
  refUrls.anchor = siteBase + '/uploads/charref/latiaomei-front-916.jpg';
  // 「说话态」半身定妆图（2026-10-06 新增）：从已生成片段里挑的一帧——她正举着锅铲张嘴说话、
  // 身后是暖色美食桌。host 模式拿它做首帧，模型不必再从灰底全身立绘“走景”走到特写。
  refUrls.host = siteBase + '/uploads/charref/latiaomei-host-916.jpg';
  const matUrl = new Map(mats.map((m) => [m.name, siteBase + m.path]));

  // 3a) 渲染引擎分流：renderer=openmontage → 逐镜动态片段 + OpenMontage 拼接（纯动态版，
  //     无字卡无旁白）；引擎没装则自动退回 hyperframes，不卡单。
  const renderer = String(p.renderer || 'hyperframes');
  if (renderer === 'openmontage') {
    if (!OM.available()) {
      console.warn('[video] 指定 openmontage 引擎但 OPENMONTAGE_DIR 不可用，退回 hyperframes');
    } else {
      return await doVideoOpenMontage({ project, step, scenes, mats, siteBase, refUrls, script, dir });
    }
  }

  // 3) happyhorse 人物镜头（i2v 图生视频）：首帧优先用本镜指派的项目实拍图（asset），
  //    没指派/指派不上的用定妆特写（close）——主角形象从首帧就锁死；
  //    逐镜失败逐镜降级图卡，不整单失败。
  // 旁白先于 hh 合成：主播口播镜（talk=true）的片段时长要按该镜 vo 的 TTS 实际
  // 长度对齐，镜头多长话就念多长，嘴动节奏和语音大致叠合（缓解口型对不上）。
  const voOk = A.synthScenes(dir, scenes);
  // 风格（STYLE.md）：news=《辣妹快报》穿插图卡；host=全程主播口播（v15 定稿：辣条妹全程在镜、
  // 右手持锅铲边说边指右上角菜品）；plain=旧图文卡。
  const style = String(p.style || CFG.videoStyle || 'news');
  const hostMode = style === 'host';
  // 新闻风格：先把右上角美食窗口（pip，没填退回 img）解析成素材文件名 food，
  // 必须在 hh 覆盖 sc.img 之前做，保证主播镜头里美食窗口不丢。
  scenes.forEach((sc) => {
    const m = mats.find((x) => x.no === (Number(sc.pip) || Number(sc.img) || 0));
    sc.food = m ? m.name : '';
    // 全程主播口播：窗口不能空着——分镜忘了填 pip 就一律挂本期菜品素材。
    if (hostMode && !sc.food && mats.length) sc.food = mats[0].name;
  });
  const hhOn = hh.available() && (p.hh !== undefined
    ? String(p.hh) === '1'
    : String(await hhSwitch()) === '1');
  let hhBudget = hhOn ? (hostMode ? scenes.length : (CFG.hh.maxShots || 6)) : 0;
  // 机位/背景由固定模板控制，不让 LLM 自由发挥运镜：实盘 11s 长片段里模型自己换景三次，
  // 观众看到的就是“人在乱跳、嘴对不上词”。短片段（≤7s）+ 固定机位才稳。
  const HOST_BASE = '辣条妹半身出镜（取景到腰部以上、与首帧完全一致），右手举不锈钢锅铲，边激情播报边用锅铲朝画面右上方比划，'
    + '背景是她身后那桌热气腾腾的菜品（暖色餐厅、虚化），机位固定、景别不变、不推拉不摇移不切景、不换背景不换装，'
    + '从第一帧起就张嘴说话，嘴巴跟音频一字一句同步，表情夸张有激情';
  const HOST_GESTURE = ['挑眉点头', '锅铲轻点两下', '摊手示意', '竖起食指强调', '锅铲比个心', '锅铲画个圈', '握拳加油'];
  // 口播镜配音要先发布到本站 /uploads 公网可达路径（happyhorse 拉音频必须公网 URL）。
  const voPubDir = path.join(CFG.uploadsDir, 'vo-tmp', `p${project.id}-${Date.now()}`);

  // 1) 排出镜计划：每镜定首帧、配音公网 URL、请求秒数与提示词
  const plan = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const want = hostMode || i === 0 ? true : (sc.hh === true || String(sc.hh).toLowerCase() === 'true');
    const talk = hostMode || i === 0 ? true : (sc.talk === true || String(sc.talk).toLowerCase() === 'true');
    sc.hh = false; sc.talk = talk;
    if (!want || hhBudget <= 0) continue;
    hhBudget--;
    const m0 = mats.find((m) => m.no === (Number(sc.img) || 0));
    const assigned = m0 ? siteBase + m0.path : '';
    // host 模式首帧一律用 9:16 主播立绘：镜镜同一人同一构图，看着才像“一镜到底在播报”。
    const firstFrame = hostMode
      ? (refUrls.host || refUrls.anchor || refUrls.close || refUrls.three || '')
      : ((String(sc.ref) === 'asset' && assigned) ? assigned : (refUrls.anchor || refUrls.close || refUrls.three || ''));
    if (!firstFrame) continue;
    let audioUrl = '';
    if (talk && sc.voFile) {
      try {
        fs.mkdirSync(voPubDir, { recursive: true });
        const pub = path.join(voPubDir, sc.voFile);
        fs.copyFileSync(path.join(dir, 'audio', sc.voFile), pub);
        audioUrl = siteBase + '/uploads/vo-tmp/' + path.basename(voPubDir) + '/' + sc.voFile;
      } catch (e) { console.warn(`[video] 镜头${i + 1} 配音发布失败，退回纯提示驱动:`, e.message); }
    }
    // 秒数 = 配音 +1s 余量（实测模型起口晚 ~0.85s）；host 卡到 7s 内，长片段口型会崩。
    const secs = talk && sc.voDur
      ? Math.max(4, Math.min(hostMode ? 7 : 15, Math.ceil(sc.voDur) + 1))
      : Math.max(3, Math.min(hostMode ? 6 : 10, Number(sc.dur) || 5));
    const promptTail = talk
      ? '，面对镜头开口播报新闻，嘴型跟音频里的语音完全同步，表情生动有激情，镜头缓推'
      : '，全程闭嘴不说话，只做手部动作或神态变化，镜头缓慢推进';
    const prompt = hostMode
      ? `${HOST_BASE}，${HOST_GESTURE[i % HOST_GESTURE.length]}，正在播的是「${String(sc.title || sc.vo || '本期美食').slice(0, 18)}」`
      : String(sc.hh_prompt || (talk ? '辣条妹坐在新闻演播室主播台前开口播报' : `${sc.title || ''}，人物自然动作`)) + promptTail;
    plan.push({ i, sc, prompt: prompt.slice(0, 300), imageUrl: firstFrame, audioUrl, seconds: secs, talk });
  }

  // 2) 并发生成（单镜 4-5 分钟，6 镜串行要半小时；批量提交后并发轮询只要一轮）
  //    → 每镜过体检（全黑/静止/视频流偏短都判废，废片绝不剪进成片）→ 不合格重试一轮 → 仍不行退回图卡。
  let hhGot = 0;
  const take = (x, clip, qc, suffix) => {
    x.sc.img = clip; x.sc.clipFile = clip; x.sc.video = true; x.sc.hh = true; hhGot++;
    // 槽位用【视频流】时长：容器被音频拉长会多出几帧黑屏（实盘黑屏成因之一）。
    x.sc.hhDur = (qc && qc.videoDur) || 0;
    if (x.talk && x.audioUrl) {
      const ca = A.useClipAudio(dir, clip, x.i);
      if (ca) { x.sc.voClip = ca.name; x.sc.voFile = ca.name; x.sc.voDur = ca.dur; }
      else console.warn(`[video] 镜头${x.i + 1} 片段无可用音轨，退回 edge-tts 配音（唇形会有小偏差）`);
    }
    if (x.sc.hhDur && x.sc.voDur && x.sc.hhDur + 0.2 < x.sc.voDur) {
      console.warn(`[video] 镜头${x.i + 1} 片段 ${x.sc.hhDur.toFixed(2)}s < 配音 ${x.sc.voDur.toFixed(2)}s，句尾可能被截`);
    }
    console.log(`[video] 镜头${x.i + 1} happyhorse 片段已生成 ${clip}${suffix ? '（重试轮）' : ''}（${x.talk ? '主播口播·音频驱动' : '人物动作'} 请求${x.seconds}s/实际${x.sc.hhDur.toFixed(2)}s，亮度${qc ? qc.mean : '-'} 运动量${qc ? qc.motion : '-'}，配音${x.sc.voClip ? '片段自带音轨(唇形同源)' : 'edge-tts'}）`);
  };
  const drop = (x, why) => {
    x.sc.img = ''; x.sc.hh = false; x.sc.video = false;
    console.warn(`[video] 镜头${x.i + 1} 退回图卡（${why}）`);
  };
  if (plan.length) {
    // HH_REUSE_DIR=<assets目录>：复用上轮已生成的口播镜片段（happyhorse 一镜 4-5 分钟、烧配额，
    // 只是重排版/重调时间轴时没必要再烧一次）。复用片段同样要过体检，不过就照常生成。
    const reuseDir = process.env.HH_REUSE_DIR ? path.resolve(process.env.HH_REUSE_DIR) : '';
    if (reuseDir) console.log(`[video] 片段复用目录 ${reuseDir}（先取现成片段，缺的才生成）`);
    const tryReuse = (x, suffix) => {
      if (!reuseDir) return null;
      for (const nm of [`hh${x.i}${suffix}`, `hh${x.i}`, `hh${x.i}b`]) {
        const src = path.join(reuseDir, `${nm}.mp4`);
        if (!fs.existsSync(src)) continue;
        const outName = `hh${x.i}${suffix}`;
        try { fs.copyFileSync(src, path.join(dir, 'assets', `${outName}.mp4`)); } catch { continue; }
        const qc = hh.inspectClip(dir, outName);
        if (qc.ok) return { clip: `${outName}.mp4`, qc };
        console.warn(`[video] 镜头${x.i + 1} 复用片段 ${nm}.mp4 体检不过（${qc.reason}），改为重新生成`);
      }
      return null;
    };
    const run = async (items, suffix) => {
      const reused = [];
      items = items.filter((x) => {
        const r = tryReuse(x, suffix);
        if (r) { take(x, r.clip, r.qc, suffix); reused.push(x); return false; }
        return true;
      });
      if (!items.length) return [];
      const res = await hh.generateBatch(dir, items.map((x) => ({
        name: `hh${x.i}${suffix}`, prompt: x.prompt, imageUrl: x.imageUrl, audioUrl: x.audioUrl, seconds: x.seconds,
      })));
      const bad = [];
      res.forEach((r, k) => {
        const x = items[k];
        if (!r.clip) {
          if (suffix) drop(x, `生成失败：${r.error || ''}`);
          else { bad.push(x); console.warn(`[video] 镜头${x.i + 1} 生成失败：${r.error || ''}，重试`); }
          return;
        }
        const qc = hh.inspectClip(dir, r.clip, 7, hostMode && refUrls.host ? path.join(CFG.uploadsDir, 'charref', 'latiaomei-host-916.jpg') : '');
        if (!qc.ok) {
          if (suffix) drop(x, `体检不过：${qc.reason}`);
          else { bad.push(x); console.warn(`[video] 镜头${x.i + 1} 片段体检不过：${qc.reason}，重试`); }
          return;
        }
        take(x, r.clip, qc, suffix);
      });
      return bad;
    };
    const retry = await run(plan, '');
    if (retry.length) await run(retry, 'b');
  }

  // 4) 其余镜头：LLM 指派素材 → 轮转补位 → 没素材才联网（先审后插），与视频工坊同规则。
  const byNo = new Map(mats.map((m) => [m.no, m.name]));
  scenes.forEach((sc) => {
    if (sc.hh && sc.video) return; // 已有动态片段
    const n = Number(sc.img) || 0;
    if (n && byNo.has(n)) { sc.img = byNo.get(n); sc.video = false; }
    else if (!sc.img || typeof sc.img !== 'string' || !media.hasAssetName(sc.img)) sc.img = '';
  });
  if (mats.length) {
    let k = 0;
    scenes.forEach((sc) => {
      if (sc.hh) return;
      if (!sc.img) { sc.img = mats[k % mats.length].name; sc.video = false; k++; }
      // 窗口没指派美食图的非主播镜头，用本镜图卡兜底（render 层会拿 sc.img 进窗口）。
    });
  }
  const src = mats.length || hhGot ? { need: 0, got: 0 }
    : await media.sourceScenes(dir, scenes, { allowVideo: true, verify: vision.matches });

  // 5) 渲染 + 混音（旁白已在 hh 前合成完）。
  // 成片时长 = 各镜时长之和（内容定长，不再凑到固定 50s，2026-10-06 修订）。
  // payload.secs / script.target_secs 只当“体检参考”：超出只告警，不硬截不硬补。
  const { segs, total } = R.planTimeline(scenes, 0);
  const cap = Number(p.secs) || Number(script.target_secs) || CAP_HINT;
  if (cap && total > cap + 2) {
    console.warn(`[video] 成片 ${total}s 比期望的 ${cap}s 长（内容多写了几句台词），未做硬截；要短版请减镜数或缩 vo 文本`);
  }
  // 3b) 全程主播口播：把逐镜片段拼成【一条】连续主播轨道（assets/host.mp4），
  //     成片里只放一个 <video>。实盘：1.6G 内存机同时解码 7 段视频直接把 Chrome 打死
  //     （render_cancelled_parent_exited），拼轨后只剩一路解码，稳。
  let hostTrack = '';
  if (hostMode) {
    // 立绘先拷进 assets（writeProject 里也会拷一次，这里是为了静帧兜底可用）
    const anchorSrc = path.join(CFG.uploadsDir, 'charref', (hostMode ? 'latiaomei-host-916' : 'latiaomei-front-916') + '.jpg');
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    if (fs.existsSync(anchorSrc)) {
      try { fs.copyFileSync(anchorSrc, path.join(dir, 'assets', 'anchor.jpg')); fs.copyFileSync(anchorSrc, path.join(dir, 'assets', 'host.jpg')); } catch { /* 缺立绘就走逐镜视频元素 */ }
    }
    const parts = [];
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      if (sc.hh && sc.clipFile) { parts.push(sc.clipFile); continue; }
      const still = ['host.jpg', 'anchor.jpg', sc.food, sc.img].find((f) => f && fs.existsSync(path.join(dir, 'assets', f)));
      const seg = still ? R.stillSegment(dir, still, segs[i].dur, `still${i}.mp4`) : '';
      if (!seg) { parts.length = 0; break; }
      parts.push(seg);
    }
    if (parts.length === scenes.length) {
      hostTrack = R.concatVideos(dir, parts, 'host.mp4');
      const hd = hostTrack ? A.ffprobeDur(path.join(dir, 'assets', hostTrack)) : 0;
      if (!hostTrack || Math.abs(hd - total) > 0.35) {
        console.warn(`[video] 主播轨道时长 ${hd.toFixed(2)}s 与时间轴 ${total}s 偏差过大，退回逐镜视频元素`);
        hostTrack = '';
      } else console.log(`[video] 主播连续轨道已拼接 ${hostTrack}（${hd.toFixed(2)}s / ${parts.length} 段）`);
    } else {
      console.warn('[video] 有镜头既没拿到片段也做不了静帧，退回逐镜视频元素');
    }
  }
  const ipName = site.ip_name || '辣条妹的御膳房';
  console.log(`[video] 项目#${project.id} 步骤#${step.id}：happyhorse ${hhGot} 镜 + 素材/联网 ${mats.length ? '素材为主' : `${src.got}/${src.need}`}，旁白 ${voOk}，成片 ${total}s（${scenes.length} 镜，内容定长）`);
  R.writeProject(dir, {
    scenes, segs, total, ipName, tagline: site.site_tagline,
    style,
    anchorPath: path.join(CFG.uploadsDir, 'charref', 'latiaomei-front-916.jpg'),
    ticker: (script.hashtags || []).join(' · '),
    hostTrack,
  });
  const stamp = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
  const outName = `proj-${project.id}-s${step.id}-${stamp}.mp4`;
  const tmpOut = path.join(dir, 'out.mp4');
  R.render(dir, tmpOut);
  let finalOut = tmpOut;
  const mix = A.mixTrack(dir, scenes, segs, total, { seed: step.id });
  if (mix) {
    const withAudio = path.join(dir, 'out-vo.mp4');
    if (A.mux(tmpOut, mix, withAudio)) finalOut = withAudio;
  }
  const outPath = path.join(CFG.uploadsDir, 'videos', outName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.renameSync(finalOut, outPath);
  const videoUrl = '/uploads/videos/' + outName;

  // 6) 挂抖音待审稿：成片 + 分镜 caption；放行权在人。p.submit=false 时不挂稿（纯本地出片）。
  let itemId = 0;
  if (p.submit === false) {
    console.log('[video] submit=false：不挂待审稿，成片仅落盘 ' + outPath);
  } else try {
    const images = mats.map((m) => m.path);
    const created = await api.createSocialItem({
      gen_task_id: task.id, review_id: 0, platform: 'douyin',
      title: (project.title || '项目成片').slice(0, 40),
      body: String(script.caption || project.brief || '').slice(0, 500),
      tags: (script.hashtags || []).map(String), images, video: videoUrl,
      note: `项目#${project.id} 出品（happyhorse ${hhGot} 镜）`,
    });
    itemId = created.id;
  } catch (e) {
    console.warn('[video] 抖音待审稿落库失败:', e.message);
  }
  // timeline 写进结果：每镜 [起始, 时长, 配音长, 是否 hh, 配音是否取片段自带音轨]，
  // 事后对账“唇形/台词是不是同一段”全靠它；同时落一份 sidecar 到成片旁边，
  // 免得渲染临时目录一删就死无对证（2026-10-06 自测需要）。
  const timeline = segs.map((g, i) => ({
    i: i + 1, start: g.start, dur: g.dur,
    vo: +(Number(scenes[i].voDur) || 0).toFixed(2),
    hh: !!scenes[i].hh, talk: !!scenes[i].talk, clip: !!scenes[i].voClip,
    clip_file: scenes[i].clipFile || '', title: scenes[i].title || '',
  }));
  try {
    fs.writeFileSync(outPath.replace(/\.mp4$/, '-timeline.json'), JSON.stringify({
      video: videoUrl, project_id: project.id, step_id: step.id, total_secs: total,
      cap_hint_secs: CAP_HINT || null, hh_shots: hhGot, timeline,
    }, null, 2));
    // 口播镜的源片段拷到 uploads/hhcache/<成片名>/，供事后 audit（唇形对账）与复盘；
    // 由 HH_CACHE=0 关掉（默认开，单条几十 MB，需要定期清）。
    if (process.env.HH_CACHE !== '0') {
      const cdir = path.join(CFG.uploadsDir, 'hhcache', outName.replace(/\.mp4$/, ''));
      for (const g of timeline.filter((x) => x.hh)) {
        const src = path.join(dir, 'assets', scenes[g.i - 1].clipFile || `hh${g.i - 1}.mp4`);
        if (fs.existsSync(src)) {
          try { fs.mkdirSync(cdir, { recursive: true }); fs.copyFileSync(src, path.join(cdir, `hh${g.i - 1}.mp4`)); } catch { /* 拷失败不拦出片 */ }
        }
      }
      if (fs.existsSync(cdir)) console.log('[video] 口播镜源片段已归档 ' + cdir);
      // 归档只留最近 5 条成片（每条几 MB 到几十 MB，1.6G 共享机磁盘金贵）。
      try {
        const root = path.join(CFG.uploadsDir, 'hhcache');
        const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
          .map((d) => ({ p: path.join(root, d.name), t: fs.statSync(path.join(root, d.name)).mtimeMs }))
          .sort((x, y) => y.t - x.t);
        dirs.slice(5).forEach((d) => fs.rmSync(d.p, { recursive: true, force: true }));
      } catch { /* 清理失败不影响出片 */ }
    }
  } catch { /* sidecar 写失败不影响成片 */ }
  const result = { video: videoUrl, item_id: itemId, hh_shots: hhGot, scenes: scenes.length, total_secs: total, timeline };
  return { status: 'done', note: `成片已出（happyhorse ${hhGot} 镜，旁白 ${voOk} 条${mix ? '，含配乐' : ''}）${itemId ? '，抖音稿待审 #' + itemId : ''}`, result };
}

// ---------- OpenMontage 引擎出片（v13.1） ----------
// 每镜：标了 hh 且有预算 → happyhorse i2v（首帧优先用本镜指派的项目实拍图，
// 没指派用定妆特写）；其余有图 → 本地 zoompan 2.5D 缓推；都没 → 纯色空镜。
// 拼接/混音由 OpenMontage 的 VideoStitch + ffmpeg（om_render.py）完成。
async function doVideoOpenMontage({ project, step, scenes, mats, siteBase, refUrls, script, dir }) {
  const stamp = new Date().toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
  const outName = `proj-${project.id}-s${step.id}-${stamp}-om.mp4`;
  const outPath = path.join(CFG.uploadsDir, 'videos', outName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let budget = OM.OM_MAX_SHOTS;
  const shots = scenes.map((sc, i) => {
    const n = Number(sc.img) || 0;
    const m = mats.find((x) => x.no === n);
    const wantHH = sc.hh === true || String(sc.hh).toLowerCase() === 'true';
    const useHH = wantHH && budget > 0;
    if (useHH) budget--;
    return {
      index: i + 1,
      prompt: useHH ? String(sc.hh_prompt || `${sc.title || ''}，镜头缓慢推近，人物自然微动`).slice(0, 300) : '',
      first_frame_url: useHH ? ((m ? siteBase + m.path : '') || refUrls.close || refUrls.three || '') : '',
      image_path: m ? path.join(dir, 'assets', m.name) : '',
      duration: Math.max(3, Math.min(10, Number(sc.dur) || 5)),
      title: sc.title || '',
    };
  });
  const total = shots.reduce((s, x) => s + x.duration, 0);
  const bgm = path.join(__dirname, '..', 'vendor', 'bgm', 'Carefree.mp3');
  console.log(`[video] 项目#${project.id} 步骤#${step.id} 走 OpenMontage 引擎：${shots.length} 镜（hh 预算 ${shots.filter((x) => x.first_frame_url).length}），目标 ${total}s`);
  const r = OM.render({
    shots, output_path: outPath, transition: 'cut',
    bgm_path: fs.existsSync(bgm) ? bgm : '',
    target_secs: total, resolution: '1080x1920', fps: 30,
  }, { log: console.log });
  const videoUrl = '/uploads/videos/' + outName;

  let itemId = 0;
  try {
    const created = await api.createSocialItem({
      gen_task_id: step.task_id || 0, review_id: 0, platform: 'douyin',
      title: (project.title || '项目成片').slice(0, 40),
      body: String(script.caption || project.brief || '').slice(0, 500),
      tags: (script.hashtags || []).map(String), images: mats.map((m) => m.path), video: videoUrl,
      note: `项目#${project.id} 出品·OpenMontage（happyhorse ${r.stats.happyhorse} 镜）`,
    });
    itemId = created.id;
  } catch (e) {
    console.warn('[video] 抖音待审稿落库失败:', e.message);
  }
  const st = r.stats || {};
  return {
    status: 'done',
    note: `OpenMontage 动态剪辑版已出（happyhorse ${st.happyhorse || 0} 镜 / 缓推 ${st.zoompan || 0} 镜 / 空镜 ${st.solid || 0}，配乐${st.happyhorse ? '' : '照旧'}）${itemId ? '，抖音稿待审 #' + itemId : ''}`,
    result: { video: videoUrl, item_id: itemId, engine: 'openmontage', stats: st, scenes: scenes.length, total_secs: total },
  };
}

// settings 里的 happyhorse 总开关（服务端拨，worker 不重启生效）。
let _hhSwitch = null;
async function hhSwitch() {
  if (_hhSwitch !== null && Date.now() - _hhSwitchTs < 300_000) return _hhSwitch;
  try {
    const { settings } = await api.settings();
    _hhSwitch = settings.pipeline_happyhorse || '0';
    _hhSwitchTs = Date.now();
  } catch { return '1'; }
  return _hhSwitch;
}
let _hhSwitchTs = 0;

// ---------- 出平台文案 ----------
async function doCopy(task, { project, steps, site, p }) {
  const plats = (Array.isArray(p.platforms) && p.platforms.length ? p.platforms : ['xiaohongshu', 'zhihu', 'weibo', 'douyin']);
  // 有分镜稿就带上它的 caption/hashtags 当底稿。
  let caption = '', hashtags = [];
  const sb = (steps || []).find((s) => s.kind === 'storyboard' && s.status === 'done' && s.result);
  if (sb) { try { const j = JSON.parse(sb.result); caption = j.caption || ''; hashtags = j.hashtags || []; } catch { /* 手改坏了不拦 */ } }
  const pseudo = {
    id: 0, slug: '', dish: project.title, headline: project.title,
    body: [project.brief, caption].filter(Boolean).join('\n'), order_tip: hashtags.map((t) => '#' + t).join(' '),
    score: 0, price: 0, cover: '', images: [], shop: null,
  };
  const items = []; const failed = [];
  for (const name of plats) {
    try {
      const plat = pub.platform(name);
      if (!plat) { failed.push(`${name}: publishers.json 缺配置`); continue; }
      const copy = await social.genCopy(pseudo, { review_base: CFG.apiBase + '/review/', base_url: CFG.apiBase, ip_city: '杭州' }, plat,
        `项目#${project.id}：人设铁律——辣条妹口头禅“嘎嘎香”、招牌金句“这盘菜，够我干六碗米饭！”（每期必带，可换量词），杭州话“落胃”点缀；要有激情、嘢啰诱人、有记忆点、像讲个故事，不要营销号腔。${(task.payload?.prompt || '').slice(0, 80)}`);
      const created = await api.createSocialItem({
        gen_task_id: task.id, review_id: 0, platform: name,
        title: copy.title, body: copy.body, tags: copy.tags, images: [], video: '',
        note: `项目#${project.id} 出品`,
      });
      items.push(created.id);
    } catch (e) {
      failed.push(`${name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  if (!items.length) throw new Error('平台稿全部失败：' + (failed.join('；') || '无可用平台'));
  return { status: 'done', note: `${items.length} 条平台稿待审（#${items.join(' #')}）`, result: { items, failed } };
}

module.exports = { type: 'project_step', run, doStoryboard, doVideo, doCopy };
