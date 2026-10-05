# 辣条妹的御膳房（latiaomei）

杭州美食 IP「辣条妹」的全栈项目：微信小程序（用户端 + 管理端）、Web 前台/干活台、
Go 服务端、AI 内容流水线 worker（短视频 + 四平台文案）。

## 目录地图

| 目录 | 说明 |
| --- | --- |
| `src/server/` | Go 服务端（sqlite、`/api/admin/*`、`/api/pipeline/*`、`/api/mp/*`），详见各 internal 包 |
| `web/` | 前台 SPA（`web/index.html`）+ **管理干活台**（`web/latiaomei/`，路由 `#/projects #/release #/tasks #/cmd`） |
| `miniapps/user-wechat/` | 用户端小程序 |
| `miniapps/admin-wechat/` | 管理端小程序（指挥中心、项目工作区、待放行） |
| `tools/pipeline/` | 内容流水线 worker（Node，消费 tasks 队列：分镜/成片/文案/发布） |
| `tools/OpenMontage/` | 出片渲染引擎之一（remotion/hyperframes/happyhorse 通道） |
| `deploy/` | 构建、systemd、nginx、env 模板（生产目录就是仓库本身） |
| `data/` | 运行时产物：sqlite 库、uploads —— **不进 git** |

## 干活方式（手机 ⇄ 电脑搭配）

内容生产的状态全在服务端 sqlite，两个入口同源，随时接力，不用同步：

- **手机**（管理小程序）：外出探店随手立项、传素材、下指令、审内容放行。
- **电脑**（Web 干活台 `/latiaomei/`）：大键盘改分镜 JSON、批量改稿、浏览器里直接看成片、
  盯任务队列重跑失败任务、流水线开关设置。

典型接力：手机拍图立项 → 电脑「项目」页出分镜、手改分镜 → 出成片（引擎可选
hyperframes / openmontage）→ 浏览器里审片 → 「待放行」里改文案放行 → worker 自动发布。

铁律不变：**任何产物必须经人工「放行」才会发布**（服务端对未放行稿直接 403）。

## 本地开发

```bash
# 服务端（Go 1.22+，路由用了 method patterns）
cd src/server
LATIAOMEI_DATA=$PWD/tmpdata LATIAOMEI_ADDR=127.0.0.1:18821 \
LATIAOMEI_ADMIN_USER=dev LATIAOMEI_ADMIN_PASS=devpass123 go run ./cmd/latiaomei migrate
LATIAOMEI_DATA=$PWD/tmpdata LATIAOMEI_ADDR=127.0.0.1:18821 \
LATIAOMEI_ADMIN_USER=dev LATIAOMEI_ADMIN_PASS=devpass123 go run ./cmd/latiaomei serve
go test ./...

# 静态前端改完即生效（http.Dir 直接读盘），生产注意同步 bump ?v= 版本号
```

生产上线/日常运维见 [`deploy/README.md`](deploy/README.md)；
流水线机制与 worker 见 [`tools/pipeline/README.md`](tools/pipeline/README.md)。

## 注意

- `deploy/latiaomei.env`、`*.key`（微信 CI 私钥）、`data/` 已被 `.gitignore`，永远别提交。
- 小程序上传 CI：`miniapps/*/ci/`（需各自本机配置，密钥文件不入库）。
- 个人电脑上开发：clone 后按需 `npm i`（`tools/pipeline`、`miniapps/*/ci`、
  `tools/OpenMontage/remotion-composer`），sqlite 库和 uploads 用生产备份自行恢复。
