# 辣条妹 · 小程序

本目录放两个微信小程序，共用同一套后端（`../src/server`），但各自独立构建、独立发布、不同 appid：

- **`admin-wechat/`** — 管理后台端（仅辣条妹本人及同事用）：下指令、审内容、发号施令。
- **`user-wechat/`** — 对客端（粉丝用）：看榜单/详情、订阅新点评推送。纯只读，无任何写权限。

> 历史上这里曾规划过钉钉小程序，已放弃并删除。
> 若将来新增别的端（如抖音小程序），再平级建目录（如 `miniapps/dy-user/`），不要塞进现有端里。

## 目录结构

```
miniapps/
├── README.md                     ← 本文件
├── admin-wechat/                 ← 管理后台端（结构见其 README.md）
└── user-wechat/                  ← 对客用户端（结构见其 README.md）
    ├── README.md                 身份模型 / 页面 / 上传流程
    ├── wx.conf                   appid/appsecret/密钥路径【勿入库】
    ├── project.config.json       appid 在此
    ├── private.<appid>.key       上传密钥【勿入库】
    ├── ci/                       miniprogram-ci（check / preview / upload）
    └── miniprogram/              小程序源码（app.js / app.json / pages / components / utils）
```

两端均采同样的目录约定（ci/ 工具链 + miniprogram/ 源码）；具体接口、
鉴权、发布流程各自写在自己目录的 README.md（user-wechat 的 `ci/node_modules`
软链到 admin-wechat 同一份，省体积）。

## 关键约束：后台鉴权

后台 `/api/admin/*` 原本用 **Cookie 会话 + CSRF 双提交**（网页用）。微信小程序的
`wx.request` 不支持自定义 Cookie，所以后端加了 **Bearer Token** 通道，且小程序
**没有登录页** —— 用微信身份（`wx.login` → 服务端 `jscode2session` 换 openid）即凭证。

- 首位登录者自动成为 `owner`，之后的人默认 `pending` **只读**，由 owner 在小程序里放行；
- Bearer 通道跳过 CSRF（token 由代码显式携带，第三方站点拿不到，无攻击面），但**照记审计**；
- 网页后台的 Cookie + 密码流程完全不受影响。

细节、权限矩阵、发布流程见 `admin-wechat/README.md`。


