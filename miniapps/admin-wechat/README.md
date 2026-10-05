# 辣条妹的御膳房 · 管理后台小程序（微信）

站长手机上的后台：写点评、管店铺、调标签、改站点文案、看访问数据、管理谁能用。
与网页后台 `../../web` 共用同一套 `/api/admin/*` 接口，不新增业务后端。

## 登录方式：没有登录页

**微信身份本身就是凭证**，扫码直接进控制台，不输账号密码。

流程：小程序 `wx.login()` 拿 code → `POST /api/admin/wx/login` → 服务端用
AppID+AppSecret 调 `jscode2session` 换 openid → 建会话回 token → 之后所有请求带
`Authorization: Bearer <token>`。AppSecret 只在服务端参与，绝不下发到端上。

会话 30 天有效、滑动续期；token 过期时 `utils/request.js` 会**静默重登并重放原请求**，
用户无感。所以小程序里不存在"退出登录"，只有一个"清除本机登录态"用于排查问题。

## 权限模型（重要）

小程序一旦发布，全球微信用户都能搜到并打开 —— "没推广"不等于"技术隔离"。
所以默认不是"谁登录谁管理员"，而是：

| 角色 | 怎么来的 | 能做什么 |
|---|---|---|
| `owner` 主人 | **第一个登录的人自动成为**，全站唯一 | 全部 + 管理成员；不可被降级/移除 |
| `admin` 管理员 | owner 在「成员管理」点放行 | 全部读写 |
| `pending` 待审核 | 陌生微信登录后的默认态 | **只读**，写操作返回 403 |
| `banned` 已拉黑 | owner 拉黑 | 登录即 403，旧会话立刻失效 |

辣条妹本人先扫码就自动锁定 owner，之后进来的人一律只读，等你放行。

想改成"谁登录谁可写"，设服务端环境变量 `LATIAOMEI_WX_OPEN_ADMINS=1` 并重启即可
（不建议：等于把站点开放给所有能打开小程序的人）。

只读身份在界面上的表现：顶部有「只读模式」提示条，编辑/删除/上传按钮直接隐藏，
点进写操作页会被拦回，不会白忙一场。

## 记录与审计

- `wx_admins`：openid、unionid、昵称、头像、角色、首次/最近出现、登录次数、来源 IP、备注
- `wx_sessions`：会话 token 的 SHA-256 散列（不存明文）
- `admin_audit`：**每一次后台写入**都记 —— 操作人 openid、动作、目标、IP、时间

审计在 `csrf` 中间件里统一拦截（所有写接口都经过它），只在状态码 < 400 时落库，
所以失败重试不会污染记录。成员名单与审计页仅管理员可见；openid 在名单里给完整值
（owner 要拿它操作），在审计页做截断展示。清理策略：过期会话随时清，审计保留 180 天。

## 页面

| 路径 | 作用 | 主要接口 |
|---|---|---|
| `pages/dashboard` | 概览：今日 PV/UV、内容量、热门、运行状态（tab） | `GET /admin/overview` |
| `pages/reviews` | 私厨榜（tab）：御膳房菜谱排行榜，按住行首 ⠿ 手柄上下拖调名次 + 录入/发布/下线/删除/搜索 | `GET·POST /admin/reviews*`、`POST /admin/reviews/rank` |
| `pages/review-edit` | 写/改点评：栏目主题、档位、评分、图文、标签、转盘开关 | `GET·POST·PUT /admin/reviews*` |
| `pages/shops` | 探店榜（tab）：踩店排行榜，按住行首 ⠿ 手柄上下拖调名次 + 录入/发布/下线/删除/搜索 | `GET·POST /admin/reviews*`、`POST /admin/reviews/rank` |
| `pages/shop-edit` | 新建/编辑店铺，含门店图上传 | `POST·PUT /admin/shops*` |
| `pages/tastes` | 口味/场景标签增删改 | `/admin/tastes*` |
| `pages/wheel` | 转盘管理：首页御膳房盘/探店盘的内容池，逐条上盘下盘 | `GET /admin/reviews?kind=…`、`POST /admin/reviews/{id}/wheel` |
| `pages/shop-archive` | 店铺档案列表（从探店榜顶部进入），关联点评用于录入时选店 | `GET·DELETE /admin/shops*` |
| 四个 tab 页 | 支持转发/分享到朋友圈邀请其他管理员：新用户默认只读，在成员管理放行 | `onShareAppMessage` / `onShareTimeline` |
| `pages/settings` | 站点文案与人设，只提交改动项 | `GET·PUT /admin/settings` |
| `pages/analytics` | 近 14 天趋势 + 按天下钻 | `GET /admin/analytics` |
| `pages/mine` | 身份卡、运维、图片库、导出（tab） | `/admin/maintenance`、`/admin/export` |
| `pages/members` | 成员管理：放行/降级/拉黑/备注/移除 | `/admin/wx/members` |
| `pages/audit` | 操作记录 | `/admin/wx/audit` |
| `pages/wishes` | 许愿池：粉丝愿望流水 + 状态分布/近7天/高频词分析；已阅/翻牌/踩完/暂不流转，一键翻牌转指令 | `GET /admin/wishes`、`POST /admin/wishes/{id}/status·directive`、`DELETE /admin/wishes/{id}` |
| `pages/pipeline` | 创作工作台（v13）：五页签——**项目**（项目制生产入口：列表/新建，点入 `pages/project` 工作区）、产文案（选内容×选平台→AI 产稿）、待放行（四平台待审稿：展开/改稿/驳回/**放行才自动发布**）、素材库（传图/挂到项目/删除）、创作目标（点菜/口径/推广/禁做，可带去立项） | `GET/POST /admin/projects*`、`POST /admin/project-steps/{id}/save·retry`、`POST /admin/missions`、`GET /admin/social-items`、`POST /admin/social-items/{id}/save·approve·reject`、`/admin/directives*` |
| `pages/project` | 项目工作区（v13）：一条视频/一组文案 = 一个项目。改标题/制片提示词、反复加删素材、分步跑（①出分镜→弹层里看/手改分镜 JSON→②用这版出成片→③出平台文案），**出成片可选渲染引擎：HyperFrames 图文卡 / OpenMontage 纯动态剪辑（v13.1）**；步骤时间线留痕可重跑，成片内嵌预览，产物进待放行 | `GET /admin/projects/{id}`、`PUT /admin/projects/{id}`、`POST /admin/projects/{id}/assets·steps`（steps 带 renderer）、`POST /admin/project-steps/{id}/save` |

## 后端改动清单

- `internal/config/config.go` —— 新增 `WXAppID` / `WXAppSecret` / `WXOpenAdmins` / `WXAPIBase`
- `internal/store/schema.sql` —— schema v3：`wx_admins`、`wx_sessions`、`admin_audit`
- `internal/store/wxauth.go` —— 身份 upsert（首位即 owner）、会话、角色、审计读写
- `internal/httpapi/wxauth.go` —— `jscode2session` 客户端、登录/我/成员/审计接口、openid 掩码
- `internal/httpapi/ctx.go` —— 统一 `Actor`（web 用户名 / wx openid）与写权限判定
- `internal/httpapi/auth.go` —— `auth` 依次尝试网页会话与微信会话；`csrf` 对 Bearer 跳过
  令牌校验但**照记审计**；写接口成功后统一留痕
- `internal/store/stats.go` —— Prune 顺带清微信过期会话与超龄审计；v4 计数新增转盘池在盘数
- v4（内容对齐网站双栏目）：`reviews.wheel` 列（是否进首页转盘，默认 1）；
  后台/公开列表支持 `kind`、`wheel` 筛选；新增 `POST /admin/reviews/{id}/wheel`；
  网站首页双转盘只转 wheel=1，整盘关光时退回全部已发布兑底
- v1.6.0 增补：档位由四档（夯/绝/6/拉）改为五档（夯/顶级/人上人/NPC/拉完了），
  老数据自动迁移 jue→dingji、liu→npc；小程序 tab 改为「私厨 / 探店」两个可拖拽榜单，
  拖拽逻辑收进 `components/rank-admin`，店铺档案降为二级页
- v1.6：新增 `POST /admin/reviews/rank`（拖拽调序批量写 rank_no=1..N，事务内完成，
  校验 kind 不串榜）；小程序四个 tab 页开启分享，多管理员拉人用

网页后台的账号密码 + Cookie + CSRF 流程**完全未变**，由 `wxauth_test.go` 里的
`TestWebCookieLoginStillWorks` 守着。

## 测试

```bash
cd ../../src/server && go test ./internal/httpapi/ -count=1     # 13 个用例，含微信登录矩阵
cd ../miniapps/admin-wechat && node ci/check.js                 # 纯本地结构检查（秒级，上传前先跑这个）
cd ../miniapps/admin-wechat && node ci/compile-check.js       # 微信同款编译器校验（要走网络、可能几分钟）
```

`ci/check.js` 覆盖：JSON 可解析、页面四件套、tabBar 注册、JS 语法与 require 目标、
WXML 标签闭合、**WXML 表达式里的字符串转义/反引号**、组件路径、
**WXSS 花括号配平与非法字符**、工具标签残留污染。
被真实坑过的三条：删样式删出半截语句、文件尾混入残留文本（本地不报错、上传 `-80056`），
以及 `data-text="{{a + '\n' + b}}"` 这种在 WXML 里拼字符串——上传报
`-80054 Bad attr data-text ... error at token $`，且 `ci preview` 也照样出码、只有真上传才炸。
要拼字符串请在 js 里算好再 setData（见 `pages/pipeline/pipeline.js` 的 `_copy`）。

## 发布到体验版

```bash
cd miniapps/admin-wechat/ci
node index.js upload  --v 1.1.0 -d "本次改动说明"   # 上传开发版
node index.js preview --v 1.1.0 -d "联调"           # 出预览码（一次性快照，不随更新走）
```

**预览码（开发版）是一次性快照，不会随重新上传而更新。**
要给辣条妹长期用，必须：微信公众平台 → 版本管理 → 找到刚上传的版本 →
**选为体验版**，之后每次 `upload` 新版本，体验版二维码不变、内容自动更新。

## 服务端配置

`deploy/latiaomei.env` 需要：

```
LATIAOMEI_WX_APPID=wx38c2602fd29699b1
LATIAOMEI_WX_SECRET=<小程序 AppSecret，32 位>
```

改完 `systemctl restart latiaomei`。验证凭证是否有效：拿假 code 调一次登录，
返回 `40029 invalid code` 说明 AppID/Secret 都对；`40013` 是 AppID 错，
`40125` 是 Secret 错。

## 公众平台需一次性配好的

- 服务器域名：`request` / `uploadFile` / `downloadFile` 都加
  `https://latiaomei.infinityfly.xin`
- 体验成员：把辣条妹的微信加进去，否则她扫体验码打不开
- 上传密钥 `private.<appid>.key` 放本目录（`.gitignore` 已排除，权限 600）
