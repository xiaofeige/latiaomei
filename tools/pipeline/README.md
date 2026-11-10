# 辣条妹内容流水线 worker（tools/pipeline）

> **视频基调风格（已定稿，后续出片一律照此）**：《辣妹快报》新闻联播式——辣条妹 AI 形象替新闻主播出镜，
> 右上角常驻「本期美食」窗口从多角度介绍本期推荐。详见 [STYLE.md](STYLE.md)（分镜提示词、渲染版式、
> `VIDEO_STYLE` 开关均以其为准）。

AI 驱动的分发流水线：**辣条妹只出现在两处——下指令、审内容**，其余由本 worker 自动完成。
后端任务队列在 Go 服务里（`/api/pipeline/*`，见 `src/server/internal/httpapi/pipeline.go`），
本目录只是消费端。干活入口有两个，状态同源（都在 sqlite），随时接力：

- 手机：后台小程序「指挥中心/工作台」页（`miniapps/admin-wechat`）；
- 电脑：Web 干活台（`web/js/admin/admin.js`，部署后开 `https://latiaomei.infinityfly.xin/latiaomei/`）：
  「项目」建项/加素材/跑步骤/改分镜/看成片，「待放行」改稿与放行，「任务」盯队列重跑，
  「指令」下指令与发分发任务。在手机上立项后电脑上接着改分镜、渲染出片后在电脑浏览器里直接看片放行，不用来回切设备。

```
辣条妹下指令(directive)/发任务(mission)              点评发布(人工审核放行)
        │ auto-enqueue                                      │ auto-enqueue
        ▼                                                   ▼
 tasks 队列（sqlite）← 总开关 settings: pipeline_enabled / _video / _gzh / _wxpush / _douyin / _xiaohongshu / _zhihu / _weibo
        │ poll/claim/finish                                 （四平台开关只产待审稿，不直接发）
        ▼
 worker.js ── jobs/draft.js       指令 → AI 点评草稿（强制 status=draft，人审后才见天日）
          ├─ jobs/project_step.js v13 项目制：一条 step = 一次交互（出分镜/出成片/出平台文案），
          │                        在工作区反复加图、改提示词、手改分镜后多轮重跑；
          │                        人物镜头交给 happyhorse（拿辣条妹三视图/特写做参考）生成动态片段，
          │                        其余镜头 hyperframes 图卡；产物挂 social_items 等放行
          ├─ jobs/video.js        点评 → LLM 分镜+旁白（镜数/时长随内容）→ 首镜挂真实封面、其余镜按素材/联网图剪进画面 → hyperframes 渲染 → edge-tts 逐镜配音 + CC-BY BGM 混音 → /uploads/videos/*.mp4 + 抖音文案
          ├─ jobs/gzh.js          点评 → 公众号图文 →（有凭证进草稿箱 / 无凭证落盘 /uploads/gzh/*.json）
          ├─ jobs/wxpush.js       点评 → 小程序订阅消息群发 → 配额核销
          ├─ jobs/social_gen.js   任务 → AI 产抖音/小红书/知乎/微博平台化文案 → social_items 待审（不发布！）
          ├─ jobs/video_mission.js v10 一键视频工坊（已被项目制取代，保留兼容存量任务）
          └─ jobs/pub_*.js        放行后的发布任务 → 回读已放行稿 → 浏览器自动化直发 / 发布包降级

人审闸门（v9 铁律）：social_items 只有管理小程序「工作台 → 待放行」里的「放行」能变 approved；
放行动作才入队对应平台发布任务；worker 发布前再回读一次 item（驳回/改稿即时生效），
未放行/已驳回的稿子在任何通道下都发不出去（服务端对无 item_id 的发布入队直接 403）。
```

## v13 项目制内容生产（主通道，取代“一键 pipeline 生成”）

一条视频/一组文案 = 一个 **project**（表：projects / project_assets / project_steps）。
管理小程序「工作台 → 项目」立项后，工作区里可以：

1. 反复加/删素材（新传图、或从「素材库」一键挂进来）；
2. 改制片提示词（每轮还可附加一句指令，如“开场改锅铲特写”）；
3. 分步跑，每步一条 step 留痕可重跑：**① 出分镜**（LLM 产分镜 JSON，可在弹层里手改保存）→
   **② 出成片**（可选“用这版分镜”；人物镜头走 happyhorse，图卡镜头走 hyperframes）→
   **③ 出平台文案**（四平台备稿）；
4. 产物照旧全部进「待放行」，放行才发布（铁律不变）。

接口：管理端 `/api/admin/projects*`（立项/编辑/素材/跑步骤/改分镜/重跑），
worker 端 `GET /api/pipeline/projects/{id}`（项目+素材+步骤+主角定妆图）与
`POST /api/pipeline/project-steps/{id}/finish`（回填步骤结果）；任务 type=`project_step`，
tasks.review_id 存 -step_id（同项目多任务不吃 uq_task_open 去重，也不会误关联点评）。

### 出片引擎可选（v13.1）：hyperframes | openmontage

「出成片」步骤带 `renderer` 字段（管理小程序工作区可选，缺省 hyperframes；也可写进
项目 opts.renderer 当默认）：

| 引擎 | 画面形态 | 链路 | 成本 |
|---|---|---|---|
| `hyperframes` | 图文卡 + 逐镜旁白 + Ken Burns（字大信息密，适合点评/口播） | 现有 R.render + edge-tts（hh 镜头剪入 happyhorse 片段） | 快，hh 镜头 ≤ HH_MAX_SHOTS |
| `openmontage` | 纯动态剪辑（无字卡无旁白，逐镜真动效 + 配乐，像短片质感） | `lib/openmontage.js` → `tools/OpenMontage/om_render.py`（内部走 OpenMontage 的 HappyhorseVideo + VideoStitch） | 慢：每镜 i2v 约 4-5 分钟，动态镜头上限 `OM_MAX_SHOTS`（默认 6），其余镜头 zoompan 缓推/空镜兜底 |

openmontage 引擎的每镜首帧：优先本镜指派的项目实拍图（公网 /uploads URL），
没指派用定妆特写；happyhorse 失败逐镜降级 zoompan，OpenMontage 没装（OPENMONTAGE_DIR
不可用）自动退回 hyperframes，不卡单。产物命名 `proj-<pid>-s<step>-<ts>-om.mp4`，
step result 带 `engine:"openmontage"` 供小程序展示引擎标签。

### 手动出片与成片体检（bin/make-video.js + smoke/audit_film.js）

视频生产不吃 worker 自动队列（2026-10-05 定稿）：在 `tools/pipeline` 下手动跑，复用同一套
`jobs/project_step.js` 代码，只是入口换成 CLI：

```bash
node bin/make-video.js --project 3                       # 出新分镜→渲染成片→**自动挂抖音待审稿**（后台可见）
node bin/make-video.js --project 3 --no-submit          # 只落盘不挂稿（本地试渲染，后台看不到）
node bin/make-video.js --project 3 --storyboard <快照>  # 用本地分镜文件（可手改后再出）
node bin/make-video.js --project 3 --attach <已有成片.mp4>  # 不出片，只把盘上已有的片补登记进「待放行」
# 常用开关：--prompt --hh 0|1 --secs --style news|plain --renderer --label 6 --copy --platform --note

node smoke/audit_film.js ../../data/uploads/videos/proj-3-6-<ts>.mp4   # 验尸：时长/唇形/台词越界
```

> **后台看不到片子？** 2026-10-06 吃过这个亏：旧版 CLI 缺省 `submit=false`（只落盘不挂稿），
> 手动跑又不建 `project_steps`，于是「待放行」与「视频工坊」两处都查不到——代码没问题、产物没登记。
> 现在缺省就挂待审稿；已经出在盘上的历史片用 `--attach` 补登记。
> 想在「视频工坊」工作区看到步骤留痕，就得从控制台/小程序点「② 出成片」跑队列任务（worker 回填 step）
> ——worker token 没有建 step 的权限，这是 v9 人审铁律。

出片时自动落两份对账材料（审计不依赖已删的临时目录）：
- `uploads/videos/<成片名>-timeline.json`：每镜 [起始, 时长, 配音长, 是否 hh, 配音是否取片段自带音轨]；
- `uploads/hhcache/<成片名>/hh<镜号>.mp4`：口播镜源片段（只留最近 5 条，`HH_CACHE=0` 关）。

### happyhorse（token-plan 视频生成）接入

- 主角定妆图已入库：`data/uploads/charref/latiaomei-three-view.jpg`（三视图）与
  `latiaomei-closeup.jpg`（特写），settings key `ip_char_three_view` / `ip_char_closeup` 下发；
  源图在 `latiao-flash/`（高清 PNG，已压成 jpg）。以后出片里的人物一律以这套形象为准。
- 分镜 LLM 会给“辣条妹出镜做动作”的镜头标 `hh=true` + `hh_prompt` + `ref(three|close)`；
  出成片时 `lib/happyhorse.js` 提交 i2v 生成（首帧参考图走公网 URL：定妆特写/三视图/本镜实拍素材）、
  轮询 task、下载 mp4，
  剪进时间轴；单片最多 `HH_MAX_SHOTS`（默认 4）镜，逐镜失败逐镜降级图卡，绝不卡流水线。
- 开关：服务端 settings `pipeline_happyhorse`（1/0，热生效）+ worker `.env` 的 `HH_VIDEO_MODEL`。
- 选型（2026-09-30 实盘验通）：token-plan 可用的是 `happyhorse-1.1-t2v / -i2v / -r2v` 三个。
  按“要能用三视图人物生视频 + 尽量便宜”选 **`happyhorse-1.1-i2v`**（图生视频）：
  t2v 虽最便宜但吃不了参考图、保不住主角形象；r2v 最贵。实测 5s 片段约 4-5 分钟出片，
  首帧用定妆特写（1440²）/三视图（模型会自动取正面人物）/项目实拍图都能保持形象一致。
- 协议是 **原生 DashScope 异步**（不是 OpenAI video 风格）：
  `POST {HH_API_BASE}/api/v1/services/aigc/video-generation/video-synthesis`（头 `X-DashScope-Async: enable`，
  体 `{model, input:{prompt, media:[{type:'first_frame',url}]}, parameters:{duration}}`）→
  `GET {HH_API_BASE}/api/v1/tasks/{id}` 轮询 `output.task_status/video_url`。
  `HH_API_BASE` 是网关根地址（不带 /compatible-mode/v1）；首帧图必须公网可达，
  定妆图就在本站 `/uploads/charref/` 下，直接拼绝对 URL。
- 开关：服务端 settings `pipeline_happyhorse`（1/0，热生效）+ worker `.env` 的 `HH_VIDEO_MODEL/HH_API_BASE`；
  验通路：`node smoke/happyhorse.js`（探测）/ `node smoke/happyhorse.js "镜头描述" --img https://…`（真跑一条，烧配额）。

## 冒烟记录（2026-10-06 第二轮 · 黑屏 / 走景 / 渲染挂了）

辣条妹反馈“开头台词和唇形对不上、念完变黑屏”，抽帧查成片后定位三件事：

1. **黑屏 = happyhorse 回了废片**：`proj-3-ss6-…mp4` 第 3 镜 4.12s 全黑（亮度 0/255），旧版不体检直接剪进成片。
   现在 `inspectClip` 抽帧算亮度/帧间差/首尾漂移，全黑、全白、静止、走景（首尾差>45）一律判废重试，
   再不行退回静帧图卡；`smoke/audit_film.js` 加了全片黑屏扫描（能复现抓到 16.0-20.0s 那段）。
2. **“开头口型不对” = 首帧选错**：拿灰底全身立绘做首帧，模型每条都在 4 秒内“走景”推到特写并换背景
   （旧片段首尾差实测 49~85），第一秒嘴还是闭着笑的。改用「说话态」半身定妆图
   `charref/latiaomei-host-916.jpg`（从已生成片段里挑的一帧）后景别稳定；重出 7 镜成片 28.7s。
3. **渲染挂了不是代码问题**：`/tmp`（838M tmpfs）被一个历史遗留的 759M 仓库塞满，hyperframes 直接拒绝渲染，
   但只吐一句含糊的 `render_cancelled_parent_exited`。现在 `render()` 渲染前体检 `/tmp` 与 `RENDER_TMP`
   剩余空间，先自动清自家抽帧缓存/过期配音，仍不足就抛人话错误。另外 7 段视频同时解码也会打爆 Chrome，
   已改成拼一条连续主播轨道、成片只放一个 `<video>`。

**口型能力边界（实测，别再误判成流水线 bug）**：`happyhorse-1.1-i2v` 只是把 `audio_url` 当配音塞进回片，
嘴部运动与语音包络相关度实测 -0.15~0.12 —— 没有音素级口型驱动；本 token 网关上 `videoretalk`/`emo-v1`/
`wan2.2-s2v` 全部 `Model not exist`，公共百炼端点这把 key 也不认（401 InvalidApiKey）。流水线已做到
“听到的就是画面那条音轨（lag=0ms、同源度≈0.99）+ 半身景别 + 字幕同步”，要真同步得换能驱动口型的模型。

## 冒烟记录（2026-10-06 · 修“固定 50s + 唇形对不上”）

实盘两个病同根：成片时长被算死、口播镜配音与画面不同源。旧片体检（`node tools/pipeline/smoke/audit_film.js`）：
`proj-3-s0-202610060639.mp4` — 时长恰好 50.00s、最后一句 42.49s 说完、**尾部干瞪 7.50s**。

修复后真跑两轮（项目#3，HH_MAX_SHOTS=2）：

```
node tools/pipeline/bin/make-video.js --project 3 --prompt "本期头条：御膳房干萝卜炒牛肚"
node tools/pipeline/smoke/audit_film.js data/uploads/videos/proj-3-ss6-202610060845.mp4
```

- 分镜 LLM 按新提示只写了 **5 镜**（不再凑 9-11 镜）；开场镜配音 10.16s → 请求 happyhorse 11s→
  拿到 11.16s 片段，镜头槽位正好 11.16s；成片 **26.52s**（内容定长，跟 50s 没关系）；
  成片已登记为待审稿 item #23（`--attach`），后台「待放行」可直接播放；
- 唇形对账：第 1 镜 lag=0ms 同源度 0.998；第 3 镜 lag=0ms 同源度 1.000（旧逻辑铺 edge-tts 原 mp3
  时量到错位 **1120ms**，就是“唇形对不上台词”）；
- 尾部静默 1.34s（=VO_TAIL 留白，不再是 7.5s 硬撑）；台词跨切镜点 0 处；
- hyperframes 渲染日志不再报 `sparse keyframes`（happyhorse 片段出片前统一重编码 30fps/密关键帧）；
- 离线回归闸门：`node tools/pipeline/smoke/timeline_lipsync.js`（15 项，吃 edge-tts + 一次真渲染，
  `--quick` 只跑时间轴断言；`SMOKE_KEEP=1` 复用上轮渲染产物）。

## 安装与运行

```bash
cd tools/pipeline
npm install                     # 只依赖 hyperframes（自带 headless chromium）
cp .env.example .env            # 填 PIPELINE_TOKEN（= 服务端 deploy/latiaomei.env 里那个）
                                # LLM_* 填任意 OpenAI 兼容端点；GZH_/MP_/DY_ 有则填
node worker.js --once           # 手动跑一轮（无任务时 exit=2）
bash deploy/build.sh            # 改了 Go 侧才需要；systemd 见下
systemctl start latiaomei-pipeline
```

渲染依赖 **ffmpeg + ffprobe**（已装 `/usr/local/bin`，BtbN 静态构建；
镜像源：`https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/.../linux64-gpl.tar.xz`，
johnvansickle 官方站在本机只有 ~20KB/s）。

配音依赖 **edge-tts**（微软免费 readaloud 接口，v11 成片逐镜旁白）：

```bash
pip3 install edge-tts            # 已装 /usr/bin/edge-tts；音色 TTS_VOICE（默认 zh-CN-XiaoyiNeural）
```

BGM（**默认已关**，2026-10-05 定稿：成片不要背景音乐，人声清楚、画面优先）：需要时在 .env 加
`BGM_ENABLED=1` 才启用 `vendor/bgm/` 下的 CC-BY 曲目（Kevin MacLeod / Incompetech，4 首，
署名要求见 `vendor/bgm/ATTRIBUTION.txt`）；旁白任一步失败自动退回无声版，不卡流水线。

## 设计约定（改代码前必读）

- **单并发**：1.6G 共享机，一次只做一个任务；渲染临时目录 `RENDER_TMP=/data/tmp/hf`
  （/tmp 是 838M 的 tmpfs，装不下渲染中间产物）。
- **机器只有提案权**：`POST /api/pipeline/reviews` 服务端强制 `status=draft`，社媒文案服务端强制
  `social_items.status='pending'`；worker 拿不到发布/删除权限——token 权限面也刻意收窄过。
- **发布必经人审（v9）**：四平台发布任务只能由管理小程序「放行」入队；worker 对
  `POST /api/pipeline/tasks` 入队发布类任务必须携带已放行 item_id，否则 403。
- **LLM 配额自适应**：token-plan key 周配额烧穿时报 429+重置时间，worker 会把任务
  `skipped` 并重新入队、`run_after` 顺延到重置点后 5 分钟，不浪费重试次数。
  长期方案：`.env` 换普通按量计费的百炼 key（`LLM_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1`）。
- **视频画面（v11）**：成片不再只是字卡。每镜 LLM 给 `search` 检索词，`lib/media.js` 走 Bing 图片/视频 async 接口
  主动搜集真实画面（无 key、国内可达），下载后做魔数/体积校验、过滤水印图库，剪成全屏背景 + Ken Burns 缓推 +
  黑压渐变（保文字可读）；个别镜可选剪入短视频片段。搜不到才降级文字卡。**成片时长跟着内容走**
  （2026-10-06 修订）：每镜 = 该镜旁白实测朗读时长 + `VO_TAIL`（空镜用 `SCENE_DUR`，上下限
  `SCENE_MIN`/`SCENE_MAX`），happyhorse 镜 = 片段实测时长，总长 = 各镜之和；`VIDEO_TARGET_SECS`
  退成“软上限体检”（超出只 log warn，**绝不把余量摊到最后一镜凑时长**——旧版就是这么把每期
  都硬撑成固定 50s 的）。用户上传图仅按 LLM 指派挂载，不作强依赖。
- **图片先理解再插入（v12，重要）**：v11 只校验魔数/体积，LLM 从没见过图（只拿到“图片数量”），
  导致实盘出现：父女日常任务被套美食人设编成“吃片儿川/抢葱包桧”、镜头插进欧美图库女水印图。
  v12 三刀：① `lib/vision.js` 用 `LLM_VISION_MODEL`（当前端点多模态的 `qwen3.8-flash`）逐张描述用户上传图，
  分镜 LLM 按描述指派素材；没指派到的空镜轮转填用户图，**有用户素材时不再联网搜图**；
  ② 无素材才联网时，每张候选图先过 `vision.matches` 审“对不对题/带不带水印”，不过就换下一张；
  ③ `video_mission` 改用中性「短视频编导」人设（MISSION_PERSONA），美食人设只留给点评任务 `video.js`；
  点评任务首镜改为优先挂真实菜品封面。另 `media.download` 新增短边≥`IMG_MIN_SIDE`（默认 540px）分辨率门，糊图/缩略图直接弃。
  未配 `LLM_VISION_MODEL` 时全部环节自动降级（不阻断流水线）。离线冒烟：`node tools/pipeline/smoke/vision_storyboard.js`。
- **视频产能**：每日上限 `VIDEO_DAILY_CAP`（与服务端 settings `video_daily_cap` 同语义，worker 侧兜底），
  超了直接 skip。产物命名 `r<reviewID>-<时间戳>.mp4`，公开路径 `/uploads/videos/`。注意 50s 成片单并发渲染≈7-8 分钟，
  `render()` 超时已放宽到 18 分钟。
- **口型对齐（2026-10-06 两条实盘病，改代码前必读）**：
  ① 说话镜（talk=true）的成片配音**用 happyhorse 片段自带音轨**（`audio.js: useClipAudio`），不再铺
  edge-tts 原 mp3——模型拿 audio_url 驱动口型后，回片音轨相对原 mp3 有 ~0.85s 起口偏差与中段
  漂移，铺原 mp3 就是“唇形和台词对不上”（实测错位 1120ms）；片段没音轨才退回 edge-tts 版。
  ② happyhorse 片段下载后统一重编码 30fps + 每秒一个关键帧（`happyhorse.js: normalizeClip`），否则
  hyperframes 报 sparse keyframes 并出现抽帧卡帧（嘴型冻住但声音在走）。
  ③ 镜头槽位 = 片段实测时长（`sc.hhDur`），配音 lead=0；旧版用 LLM 猜的 `dur=5s` 卡 6-7s 配音，
  声音漫过下一镜（闭嘴立绘在讲话）。回归闸门：`node tools/pipeline/smoke/timeline_lipsync.js`。
- **失败语义**：普通错误 failed（服务端退避 10 分钟、最多 3 次）；环境/配置不齐类 skip（不重试）。
- **抖音发布**：成品+文案先落任务 result，人工一键搬运；开放平台企业资质下来后
  在 `jobs/video.js` 的 TODO 处接 API 直传。
- **订阅消息模板字段**：`jobs/wxpush.js` 里写死了 `thing1/thing2/time3`，
  小程序订阅消息模板定好后按实际字段改。

## 冒烟记录（2026-09-21）

- hyperframes 渲染 12s/360帧 竖屏视频 ≈ 71s、939KB，内存稳定；
- 领任务→执行→回填全链路 OK（skip/fail/配额顺延三条路径都验过）；
- 队列在 sqlite `tasks` 表，`GET /api/pipeline/tasks?status=all` 可查（默认只列 pending）。

## 冒烟记录（2026-09-22 · v9 人审闸门）

- 发任务 → social_gen 入队 → worker 领取 → LLM 配额耗尽 → 任务 skipped 并顺延到配额重置点后，全链路 OK；
- 服务端对「无 item_id 的发布任务入队」返回 403，对「worker 自称 approved 的待审稿」强制 pending；
- 管理小程序「AI 流水线」四页签编译通过（82 产物 / 175KB），放行/驳回/改稿接口有集成测试覆盖
  （`src/server/internal/httpapi/pipeline_social_test.go`）；
- 四平台 cookie 凭证（publishers.json）配好前：放行后走「发布包」降级，不落空、不报错。

## 冒烟记录（2026-09-22 · 离线闸门回归）

人审闸门与「凭证没配 → 降级发布包」这条链路不吃 LLM 配额，可随时离线复跑：

```bash
node tools/pipeline/smoke/gate.js     # 12 项断言，产物落 /tmp/smoke-uploads，不碰生产库
```

覆盖：无 item_id / 稿不存在 / 稿仍 pending → 一律 skip 拒发；已放行但 cookie=TODO →
只产发布包（小红书 `#词`、微博 `#词#`、知乎长文各有断言）且不回填 published；
抖音无成片 → 催产 `video` 任务 + 带 item_id 顺延 2h、本轮 skip 不烧重试次数。

**当前唯一堵点**：token-plan key 周配额 09-22 05:52 UTC 重置，任务 #6(video)/#8(social_gen)
已排在 05:57 UTC 自动执行。四平台 cookie 仍是 TODO，填进 `publishers.json` 并把
`enabled` 打开前，机器人只会产发布包（详见该文件顶部「必读」）。

## 配置地图：什么东西在哪配、现在缺不缺

| 干什么用 | 配置文件 / 键 | 现状（2026-09-22） |
|---|---|---|
| 后端↔worker 通道 | `tools/pipeline/.env: PIPELINE_BASE, PIPELINE_TOKEN`（须等于 `deploy/latiaomei.env` 的 `LATIAOMEI_PIPELINE_TOKEN`） | ✅ 已配 |
| **所有 AI 文案/视频脚本**（唯一的大模型入口） | `tools/pipeline/.env: LLM_API_BASE / LLM_API_KEY / LLM_MODEL` | ✅ 已配（百炼 token-plan），⚠️ 周配额，09-22 05:52 UTC 重置 |
| 抖音视频**渲染**（不吃模型） | 本机 `hyperframes` + `ffmpeg` + playwright chromium；`RENDER_TMP / UPLOADS_DIR / VIDEO_DAILY_CAP` | ✅ 已装已跑通（产物 `/uploads/videos/`） |
| **happyhorse 视频生成**（v13 人物镜头） | `.env: HH_VIDEO_MODEL / HH_API_BASE / HH_API_KEY / HH_MAX_SHOTS / HH_WAIT_SECS`；服务端开关 settings `pipeline_happyhorse`；主角定妆图 settings `ip_char_three_view / ip_char_closeup`（源图 `latiao-flash/`，已压进 `/uploads/charref/`） | ✅ 已验通（`happyhorse-1.1-i2v`，特写/三视图首帧各真跑一条成功，形象一致） |
| **项目制生产**（v13 主通道） | 服务端表 `projects / project_assets / project_steps`；任务 type=`project_step`；管理小程序「项目」页 + `pages/project` 工作区 | ✅ 已上线（Go 测试覆盖；旧 video_mission 保留兼容） |
| 小红书/抖音/微博/知乎 **登录态** | `tools/pipeline/publishers.json` → 各平台 `cookie` + `enabled`（`auto_publish` 单独控是否真点发布） | ❌ 四个 cookie 全 TODO、enabled=false → 放行后降级「发布包」 |
| 公众号同步发文 | `.env: GZH_APPID / GZH_SECRET` | ❌ 空（gzh 任务落盘成稿，不报错） |
| 抖音开放平台直传（备选路线） | `.env: DY_APPID / DY_SECRET` | ❌ 空（需企业资质；`jobs/video.js` 留了 TODO 接口） |
| 订阅消息推送 | `.env: MP_APPID / MP_SECRET` + 服务端 `mp_tpl_*` | ⚠️ 密钥有值，但模板字段 `thing1/thing2/time3` 未在公众平台定稿前是猜的 |
| 小程序代码上传 | `miniapps/*/private.<appid>.key`、`miniapps/*/ci/index.js` | ✅ 在用（robot=1，同版本覆盖上传） |

改完 `.env` 要 `systemctl restart latiaomei-pipeline`；改 `publishers.json` **不用重启**（按 mtime 热加载）。
`.env` 与 `publishers.json` 已 `chmod 600`（里面是密钥和登录态）。

### 登录态体检（只读，绝不发布）

```bash
node tools/pipeline/smoke/check-cookie.js              # 四平台配置体检
node tools/pipeline/smoke/check-cookie.js xiaohongshu   # 起无头浏览器真查：cookie 认不认登录 + 截屏为证
```
