# 辣条妹内容流水线 worker（tools/pipeline）

AI 驱动的分发流水线：**辣条妹只出现在两处——下指令、审内容**，其余由本 worker 自动完成。
后端任务队列在 Go 服务里（`/api/pipeline/*`，见 `src/server/internal/httpapi/pipeline.go`），
本目录只是消费端。管理入口是后台小程序「指挥中心」页（`miniapps/admin-wechat`）。

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
          ├─ jobs/video.js        点评 → LLM 分镜+旁白(9-11 镜/≈50s) → 首镜挂真实封面、其余镜按素材/联网图剪进画面 → hyperframes 渲染 → edge-tts 逐镜配音 + CC-BY BGM 混音 → /uploads/videos/*.mp4 + 抖音文案
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

BGM 用 `vendor/bgm/` 下的 CC-BY 曲目（Kevin MacLeod / Incompetech，已下载 4 首，
署名要求见 `vendor/bgm/ATTRIBUTION.txt`）；旁白/配乐任一步失败自动退回无声版，不卡流水线。

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
  黑压渐变（保文字可读）；个别镜可选剪入短视频片段。搜不到才降级文字卡。目标时长 `VIDEO_TARGET_SECS`（默认 50s），
  每镜 `SCENE_DUR`（默认 5s）。用户上传图仅按 LLM 指派挂载，不作强依赖。
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
