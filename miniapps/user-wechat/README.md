# 辣条妹 · 用户端微信小程序（对客端）

粉丝侧小程序：**看榜单 / 逛详情 / 订阅新点评推送**。与后台端
（`../admin-wechat`）共用同一套 Go 后端，但是**不同 appid、不同鉴权模型**——
这里没有任何写权限，用户身份只用来给订阅消息记配额。

## 身份与鉴权（无登录页）

- 打开即 `wx.login` → 后端 `POST /api/mp/wx/login` 换 openid，回一个 HMAC 小令牌（30 天，存本地）。
- 看内容（`/api/bootstrap`、`/api/reviews`、`/api/shops`…）**全匿名**，不依赖登录态；
  令牌在「点订阅」时记一次配额，「许愿」时记身份（我的愿望可回溯）。
- 配额规则：微信一次授权只能发一条，点一次"允许"= +1（服务端封顶 10）。详见后端 `mpuser.go`。

## 页面

| 页 | 路径 | 数据 |
|---|---|---|
| **辣条妹（C 位，默认首页，v11）** | `pages/ai` | 辣条妹本人在线对话（底层是 Agent，但对用户不出现 AI 字样）：`POST /api/mp/agent/chat` 回生成式 UI 块（text/ask/shops/plan/tips/actions）；多行输入 + 长按话筒语音转写（WechatSI）；定位 + 口味档案 |
| 恰啥 | `pages/index` | 转盘主打：`GET /api/reviews?wheel=1`（探店/御膳房双盘，对齐 web 站）+ `GET /api/bootstrap` 喂满其余板块；转盘组件 `components/wheel`（canvas 2d 画盘 + CSS 旋转） |
| 榜单 | `pages/list` | `GET /api/reviews` + `GET /api/taxonomy`，搜索/档位/口味/排序/翻页 |
| 点评详情 | `pages/detail` | `GET /api/reviews/{slug}`，可分享、相关推荐、订阅 |
| 店铺档案 | `pages/shop` | `GET /api/shops/{slug}`，含判定统计 |
| 我的 | `pages/my` | tab 名「本人」：订阅管理 + 站长人设 + 许愿入口 + 抖音外链 |
| 呼声墙 | `pages/wish`（tab「许愿墙」） | 递愿望即上墙：`POST /api/mp/wish`；全员公开列表 + 🌶 喊声（`GET /api/mp/wish/wall`、`POST /api/mp/wish/like`，需静默登录）；呼声最高的辣条妹优先去踩；「暂不做」= 下墙；openid/联系方式永不外泄，展示用固定马甲 |

底部 tabBar 为自定义组件 `custom-tab-bar/`：恰啥 / 榜单 /【C 位：辣条妹】/ 许愿墙 / 本人，左二右二对称。「辣条妹」这个名字只属于 C 位对话入口（AI 把辣条妹具象化，用户不需要感知技术层）。tab 页需在各自 `onShow` 里 `this.getTabBar().setActive(key)` 点亮自己；自定义 bar 是悬浮层，tab 页 `.wrap` 底部已多留 `calc(240rpx + safe-area)` 让位。

## 本地检查 / 上传

```bash
cd miniapps/user-wechat
node ci/check.js                       # 纯本地结构检查（不联网、不需密钥）
node ci/index.js preview --v 0.0.1 -d "说明"   # 预览二维码 qr-<appid>.png
node ci/index.js upload  --v 0.0.1 -d "说明"   # 上传到微信"开发版本"
```

`ci/node_modules` 软链到 `../admin-wechat/ci/node_modules`（同一套 miniprogram-ci，省 300M）。
上传密钥 `private.<appid>.key` 从微信公众平台下载后放本目录上级，**勿入库**（.gitignore 已排除）。
配置（appid / secret / 密钥路径）在 `wx.conf`，同样勿入库。

## 上传后 → 设为体验版（手动，微信只能网页做）

CI 没有"设为体验版"接口。上传成功后：
1. 微信公众平台（该小程序账号）→ 版本管理 → 开发版本 → 找到刚上传的 v0.0.1 → **选为体验版**；
2. 成员管理 → 体验成员：添加要试看的微信号；
3. 体验成员用微信"扫一扫" `qr-<appid>.png` 或体验版入口打开。

首次真机前，需在公众平台 → 开发设置 → 服务器域名把
`https://latiaomei.infinityfly.xin` 加进 request 合法域名（开发版可临时"不校验合法域名"绕过）。
