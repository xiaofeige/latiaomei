-- =============================================================
-- 辣条妹的御膳房 · 数据库结构 (SQLite)
-- 由 store.Open() 的 user_version 机制自动迁移，勿手改历史段。
-- =============================================================

-- ---------- v1: 内容主体 ----------

-- 店铺档案（一家店可被点评多次，点评挂在这里）
CREATE TABLE IF NOT EXISTS shops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL DEFAULT '',
  district    TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  cuisine     TEXT NOT NULL DEFAULT '',
  avg_price   INTEGER NOT NULL DEFAULT 0,
  hours       TEXT NOT NULL DEFAULT '',
  douyin_url  TEXT NOT NULL DEFAULT '',
  xhs_url     TEXT NOT NULL DEFAULT '',
  cover       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shops_city ON shops(city);

-- 一条点评 = 一道菜 + 一个判定
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  shop_id     INTEGER NOT NULL DEFAULT 0,
  dish        TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'npc',
  score       REAL NOT NULL DEFAULT 0,
  spicy       INTEGER NOT NULL DEFAULT 0,
  price       INTEGER NOT NULL DEFAULT 0,
  headline    TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  order_tip   TEXT NOT NULL DEFAULT '',
  revisit     INTEGER NOT NULL DEFAULT 0,
  visit_date  TEXT NOT NULL DEFAULT '',
  cover       TEXT NOT NULL DEFAULT '',
  images      TEXT NOT NULL DEFAULT '[]',
  featured    INTEGER NOT NULL DEFAULT 0,
  rank_no     INTEGER NOT NULL DEFAULT 0,
  view_count  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft',
  published_at INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'tandian'
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, rank_no);
CREATE INDEX IF NOT EXISTS idx_reviews_tier   ON reviews(tier, status);
CREATE INDEX IF NOT EXISTS idx_reviews_shop   ON reviews(shop_id);
CREATE INDEX IF NOT EXISTS idx_reviews_pub    ON reviews(published_at DESC);

-- 口味/场景标签（口味筛选的数据源）
CREATE TABLE IF NOT EXISTS tastes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  slug    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'taste',
  sort_no INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS review_tastes (
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  taste_id  INTEGER NOT NULL REFERENCES tastes(id)  ON DELETE CASCADE,
  PRIMARY KEY (review_id, taste_id)
);
CREATE INDEX IF NOT EXISTS idx_rt_taste ON review_tastes(taste_id);

-- 站点/IP 文案配置（改文案不用发版）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 后台账号与会话
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER NOT NULL DEFAULT 0,
  last_login_ip TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

-- 上传件台账（算存储占用、清孤儿文件用，不存内容本身）
CREATE TABLE IF NOT EXISTS uploads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,
  thumb       TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL DEFAULT '',
  bytes       INTEGER NOT NULL DEFAULT 0,
  thumb_bytes INTEGER NOT NULL DEFAULT 0,
  sha         TEXT NOT NULL DEFAULT '',
  used_by     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0
);

-- ---------- v1: 访问统计（全是聚合表，不存原始流水）----------

CREATE TABLE IF NOT EXISTS stat_day (
  date    TEXT PRIMARY KEY,
  pv      INTEGER NOT NULL DEFAULT 0,
  uv      INTEGER NOT NULL DEFAULT 0,
  bot     INTEGER NOT NULL DEFAULT 0,
  api     INTEGER NOT NULL DEFAULT 0,
  err     INTEGER NOT NULL DEFAULT 0,
  uv_hll  BLOB
);

CREATE TABLE IF NOT EXISTS stat_hour (
  date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  pv   INTEGER NOT NULL DEFAULT 0,
  uv   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, hour)
);

CREATE TABLE IF NOT EXISTS stat_path (
  date TEXT NOT NULL,
  path TEXT NOT NULL,
  pv   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, path)
);

CREATE TABLE IF NOT EXISTS stat_ref (
  date TEXT NOT NULL,
  ref  TEXT NOT NULL,
  pv   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, ref)
);

CREATE TABLE IF NOT EXISTS stat_device (
  date   TEXT NOT NULL,
  device TEXT NOT NULL,
  pv     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, device)
);

CREATE TABLE IF NOT EXISTS stat_top (
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  key  TEXT NOT NULL,
  pv   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, kind, key)
);

-- idx_reviews_kind 不在这里建：老库（v1）执行到这条时 kind 列还不存在，
-- 会报 no such column。它由 store.go 的 v2Upgrade 在 ALTER 之后负责创建，
-- 新库也走同一条路径（v2Upgrade 里的 CREATE INDEX IF NOT EXISTS 是幂等的）。
-- v4 的 reviews.wheel 同理，由 store.go 的 v4Upgrade 负责 ALTER，这里不写。

CREATE TABLE IF NOT EXISTS login_attempts (
  ip         TEXT PRIMARY KEY,
  fails      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- ---------- v3: 微信小程序管理员身份 ----------
-- 设计要点：小程序端不再有账号密码登录页，微信身份本身就是凭证。
-- 但"小程序一旦发布全球都能搜到"，所以陌生 openid 默认只读（pending），
-- 由第一位 owner 在成员管理里放行；LATIAOMEI_WX_OPEN_ADMINS=1 可全局放开。

-- 一个 openid = 一个后台使用者。role: owner/admin/pending/banned
CREATE TABLE IF NOT EXISTS wx_admins (
  openid        TEXT PRIMARY KEY,
  unionid       TEXT NOT NULL DEFAULT '',
  nickname      TEXT NOT NULL DEFAULT '',
  avatar        TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'pending',
  first_seen_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER NOT NULL DEFAULT 0,
  login_count   INTEGER NOT NULL DEFAULT 0,
  last_ip       TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wx_admins_seen ON wx_admins(last_seen_at);

-- 小程序会话：token 只存散列，与网页 sessions 分开，互不影响。
CREATE TABLE IF NOT EXISTS wx_sessions (
  token_hash TEXT PRIMARY KEY,
  openid     TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wx_sessions_exp ON wx_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_wx_sessions_openid ON wx_sessions(openid);

-- 后台写操作留痕：谁、何时、从哪个 IP、动了什么。审计只增不改。
CREATE TABLE IF NOT EXISTS admin_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL DEFAULT 0,
  actor   TEXT NOT NULL DEFAULT '',
  action  TEXT NOT NULL DEFAULT '',
  target  TEXT NOT NULL DEFAULT '',
  ip      TEXT NOT NULL DEFAULT '',
  ua      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at);

-- ---------- v6: 全自动流水线（生态分发） ----------

-- 任务队列：内容审核通过（draft→published）自动入队；worker（tools/pipeline）领取执行。
-- type: video=hyperframes 渲染抖音视频 | gzh=公众号发文 | wxpush=小程序订阅消息推送 | draft=AI 产草稿
-- 同一 review 同一类型只允许一个未终结任务，防重复分发；重试靠后台把 failed 拨回 pending。
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  review_id   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  payload     TEXT NOT NULL DEFAULT '{}',      -- 入队时的上下文 JSON
  result      TEXT NOT NULL DEFAULT '',        -- worker 回填的产出（文件路径/平台 id）
  error       TEXT NOT NULL DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 0,
  run_after   INTEGER NOT NULL DEFAULT 0,      -- 早于该时间戳不给执行（排期/退避）
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_open ON tasks(type, review_id) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_task_poll ON tasks(status, run_after, id);

-- 辣条妹的指令：人类影响流水线的唯一入口（审核与方向之外不留人工环节）。
-- kind: topic=点菜（必须做什么题） | style=口径 | promo=商单/直播推广（预留） | block=禁做
CREATE TABLE IF NOT EXISTS directives (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL DEFAULT '',   -- 目标日 YYYY-MM-DD，空=长期有效
  kind        TEXT NOT NULL DEFAULT 'topic',
  title       TEXT NOT NULL,
  brief       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',  -- open|done|cancelled
  result_note TEXT NOT NULL DEFAULT '',      -- worker/AI 回填执行说明
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_directive_status ON directives(status, date);

-- 各端用户身份（三端小程序 + 公众号的 openid 台账，unionid 打通留作以后）
-- channel: wxmini=用户端微信小程序 | dymini=抖音小程序 | gzh=公众号
-- quota：一次性订阅消息剩余可发条数（用户点一次"订阅" +1，发一条 -1）。
CREATE TABLE IF NOT EXISTS mp_ids (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,
  openid      TEXT NOT NULL,
  unionid     TEXT NOT NULL DEFAULT '',
  nickname    TEXT NOT NULL DEFAULT '',
  quota       INTEGER NOT NULL DEFAULT 0,
  quota_total INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(channel, openid)
);
CREATE INDEX IF NOT EXISTS idx_mpid_quota ON mp_ids(channel, quota);

-- ---------- v8: 粉丝许愿 ----------

-- 用户在小程序许的愿：想让辣条妹去踩什么坑 / 探什么店。
-- status: new=刚收到 | read=已阅 | picked=翻牌（排进探店计划） | done=已踩坑 | rejected=暂不做
-- channel/openid 来自用户端小令牌（可匿名许愿，带令牌则可回溯"我的许愿"）。
CREATE TABLE IF NOT EXISTS wishes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL DEFAULT 'anon',
  openid     TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  contact    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'new',
  note       TEXT NOT NULL DEFAULT '',      -- 辣条妹的批复
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wish_status ON wishes(status, id);
CREATE INDEX IF NOT EXISTS idx_wish_mine ON wishes(channel, openid, id);

-- ---------- v10: 许愿墙呼声（点赞） ----------

-- 愿望即上墙：除被辣条妹「暂不做」下墙的，都公开可见；contact 永不外泄。
-- 一条愿 × 一人（channel+openid）一条记录，重复请求即取消支持（toggle）。
CREATE TABLE IF NOT EXISTS wish_likes (
  wish_id    INTEGER NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'wxmini',
  openid     TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wish_id, channel, openid)
);
CREATE INDEX IF NOT EXISTS idx_wl_wish ON wish_likes(wish_id);

-- ---------- v9: 社媒发布内容审 ----------------------

-- AI 按平台风格产出的待审文案：一任务 × N 平台 = N 行。
-- 铁律：worker 只能往这里塞 pending；变成 approved 的唯一途径是辣条妹在管理小程序里点「放行」。
-- 发布任务（douyin/xiaohongshu/zhihu/weibo）只由放行动作入队，worker 发之前回读 item，
-- 未放行的内容物理上发不出去。status: pending|approved|rejected|published|failed
CREATE TABLE IF NOT EXISTS social_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  gen_task_id  INTEGER NOT NULL DEFAULT 0,   -- 产出它的 social_gen 任务
  review_id    INTEGER NOT NULL DEFAULT 0,
  platform     TEXT NOT NULL,                -- douyin|xiaohongshu|zhihu|weibo
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',   -- JSON 数组（话题词，不带 #）
  images       TEXT NOT NULL DEFAULT '[]',   -- JSON 数组（/uploads/... 素材）
  video        TEXT NOT NULL DEFAULT '',     -- 抖音视频素材（/uploads/videos/...，可空）
  status       TEXT NOT NULL DEFAULT 'pending',
  note         TEXT NOT NULL DEFAULT '',     -- worker 备注 / 驳回原因
  result       TEXT NOT NULL DEFAULT '',     -- 发布回填（发布包路径/页面 URL）
  reviewed_by  TEXT NOT NULL DEFAULT '',
  reviewed_at  INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_social_status ON social_items(status, id);
CREATE INDEX IF NOT EXISTS idx_social_review ON social_items(review_id, platform, id);
-- 同一生成任务 × 同一平台只留一条：重跑幂等靠它 upsert。
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_gen ON social_items(gen_task_id, platform) WHERE gen_task_id > 0;

-- ---------- v13: 项目制内容生产（projects） ----------
-- 一条视频/文案 = 一个项目：建项目 → 工作区里反复加素材、改提示词、分步跑
-- （出分镜 → 改分镜 → 出成片 → 出平台文案），每一步都是一条可回溯的 step。
-- 铁律不变：step 产物只进 social_items 等人工放行；机器没有自发通道。
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  brief       TEXT NOT NULL DEFAULT '',      -- 制片提示词（可多轮编辑）
  status      TEXT NOT NULL DEFAULT 'open',  -- open|review|done|archived
  opts        TEXT NOT NULL DEFAULT '{}',    -- JSON：{duration_secs,use_happyhorse,platforms,...}
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_project_status ON projects(status, id);

-- 项目素材：工作区里添加的图片/文件；kind=charref 的是主角定妆参考（三视图/特写），
-- 出片时喂给 happyhorse 做人物一致性。note 可由视觉模型回填（内容描述）。
CREATE TABLE IF NOT EXISTS project_assets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,                  -- /uploads/... 或 /uploads/charref/...
  kind       TEXT NOT NULL DEFAULT 'image',  -- image|file|charref
  note       TEXT NOT NULL DEFAULT '',
  sort_no    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_passet_project ON project_assets(project_id, sort_no);

-- 项目步骤 = 一次交互：出分镜/出成片/出文案各跑一轮，留痕可迭代。
-- kind: storyboard（分镜脚本，result 存 JSON 供人编辑）| video（按分镜渲染成片）| copy（平台文案）
CREATE TABLE IF NOT EXISTS project_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,
  prompt      TEXT NOT NULL DEFAULT '',      -- 本轮附加指令（空=用项目 brief）
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  result      TEXT NOT NULL DEFAULT '',      -- worker 回填 JSON（分镜/成片 URL/稿 id 列表）
  error       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pstep_project ON project_steps(project_id, id);

-- ---------- v11: 鉴店 skill · 高德到店数据缓存 ----------

-- 辣条妹鉴店要参考高德 POI（评分/人均/扫街榜痕迹）。高德配额免费但有限，
-- 查过一次就落这里，7 天内复用。shop_key = "城市|店名" 归一化键。
CREATE TABLE IF NOT EXISTS amap_poi (
  shop_key   TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  info       TEXT NOT NULL DEFAULT '',   -- amap.POI 的 JSON
  fetched_at INTEGER NOT NULL DEFAULT 0
);
