# 辣条妹的御膳房 · 部署说明

生产目录就是仓库本身：`/data/www/latiaomei`。

## 组成

| 文件 | 作用 |
| --- | --- |
| `deploy/build.sh` | 构建 `build/latiaomei`（限制 GC/并发，适配 1.6G 内存的机器） |
| `deploy/systemd/latiaomei.service` | 常驻服务，`MemoryMax=1G`，日志落 `/var/log/latiaomei/` |
| `deploy/latiaomei.env.example` | 环境变量模板（复制成 `latiaomei.env` 后使用） |
| `deploy/nginx/latiaomei.conf` | 反代 `latiaomei.infinityfly.xin` → `127.0.0.1:18821` |
| `deploy/logrotate/latiaomei` | 日志按天切、留 14 天 |

## 首次上线

```bash
# 1) 构建
bash /data/www/latiaomei/deploy/build.sh

# 2) 环境变量（含后台账号，第一次启动会自动建号）
cp /data/www/latiaomei/deploy/latiaomei.env.example /data/www/latiaomei/deploy/latiaomei.env
chmod 600 /data/www/latiaomei/deploy/latiaomei.env
$EDITOR /data/www/latiaomei/deploy/latiaomei.env   # 填 LATIAOMEI_ADMIN_PASS

# 3) 建库 + 灌演示数据（可选；库里已有内容时会拒绝重复灌）
cd /data/www/latiaomei
set -a; . deploy/latiaomei.env; set +a
./build/latiaomei migrate && ./build/latiaomei seed

# 4) 服务
mkdir -p /var/log/latiaomei
install -m 644 deploy/systemd/latiaomei.service /etc/systemd/system/latiaomei.service
install -m 644 deploy/logrotate/latiaomei /etc/logrotate.d/latiaomei
systemctl daemon-reload && systemctl enable --now latiaomei

# 5) nginx
ln -sfn /data/www/latiaomei/deploy/nginx/latiaomei.conf /etc/nginx/conf.d/latiaomei.conf
nginx -t && systemctl reload nginx
curl -sS http://127.0.0.1:18821/api/healthz
```

## 证书

```bash
certbot certonly --webroot -w /var/www/certbot -d latiaomei.infinityfly.xin
```

证书由 root 的 crontab 自动续期（每月 1 号 03:00 跑
`certbot renew --quiet --deploy-hook 'nginx -s reload'`，与本站其他域名共用这一条）；
nginx 配置里的 `/.well-known/acme-challenge/` 就是给续期用的，别删。

## 日常

```bash
bash deploy/build.sh && systemctl restart latiaomei   # 发版
systemctl status latiaomei                            # 看状态
tail -f /var/log/latiaomei/latiaomei.log              # 看日志
./build/latiaomei passwd -u latiaomei -p '新密码'      # 改后台密码（改完重启）
```

## v11 吃货 AI Agent（辣条妹大脑）

- 用户端小程序首页的 AI 对话走 `POST /api/mp/agent/chat`，靠 `latiaomei.env` 里的
  `LATIAOMEI_LLM_API_BASE / _API_KEY / _MODEL`（与 tools/pipeline 共用百炼 token-plan 配额）。
- LLM 超时/配额烧穿/回包烂掉时服务端**自动本地规则兜底**，对话不白屏（响应里 `engine`
  字段区分 llm/fallback）；限流每 IP 每分钟 8 次。
- 换普通按量计费 key 只需改这三个变量后重启，无代码变动。

## agent 词表 / 话术外置文件（v11）

agent 的本地硬拦规则、门禁审核员角色设定、回复消毒禁词天然是一堆「反面用例」文本
（违规内容、越权套取之类），放在源码里会被代码侧的内容安全扫描当成命中项，所以外置成
纯文本，由服务运行期读取（`src/server/internal/httpapi/agent_words.go`）：

- 编辑源（本机，源码里不留这些词）：`~/workplace/safety-words.txt`
- 线上实际读取：`/data/www/latiaomei/data/safety-words.txt`，由 `deploy/latiaomei.env`
  的 `LATIAOMEI_WORDS_FILE` 指定 —— systemd 单元里有 `ProtectHome=true`，服务进程看不见
  `/root`，不能指到 home 下的文件

```bash
# 改完词表同步到线上（服务按 mtime 热载，不用重启）
cp ~/workplace/safety-words.txt /data/www/latiaomei/data/safety-words.txt
```

文件缺失 / 解析失败只是安静降级（少一道本地硬拦、跳过一次小模型门禁），主对话照常，
服务也不会因此起不来；格式见文件头部注释。

## 内存硬控（1.6G 共享机）

构建期固定 `GOMEMLIMIT=700MiB`（见 build.sh）。跑在线下一命令（seed / migrate /
seed-recipes / passwd）时不要裸跑，套一层 systemd-run 拿 cgroup 硬上限，超了让内核
杀它，别把整机和别的站拖下水：

```bash
set -a; . /data/www/latiaomei/deploy/latiaomei.env; set +a
systemd-run --wait --pty -p MemoryMax=800M -p GOMEMLIMIT=700MiB \
  /data/www/latiaomei/build/latiaomei seed-recipes
```

常驻服务本身的天花板是 unit 里的 `MemoryMax=1G / MemoryHigh=768M`，Go 侧靠 env 的
`GOMEMLIMIT=900MiB` 先行收 GC，两层一起兜。

## 老库补御膳房菜谱

`seed` 在已有数据的库上会拒绝执行（防误灌）。给上线过的库补 7 道菜谱用幂等子命令：

```bash
./build/latiaomei seed-recipes   # 按 slug 查重，跑几次都只补缺的
```

## 备份

- 内容：后台「维护」页 → 导出内容 JSON
- 整库：停服务后拷 `data/latiaomei.db`（连同 `-wal`）与 `data/uploads/`
- `data/.secret` 丢了会让所有登录会话失效，建议一起备份
