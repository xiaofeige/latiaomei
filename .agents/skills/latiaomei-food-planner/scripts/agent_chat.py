#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""辣条妹吃货 AI —— 美食行程规划客户端。

调用本机 latiaomei 服务的 POST /api/mp/agent/chat，把返回的块协议
(text/ask/shops/plan/tips/actions) 渲染成可读的 Markdown。

用法示例：
  agent_chat.py "帮我规划来杭州三天的每一餐" --days 3
  agent_chat.py "我能吃辣，没有忌口，人均100内，帮我排两天" \
      --spicy 2 --budget 100 --days 2 --taboo ""
  # 多轮：--history chat.json 会把本轮对话追加进文件，下轮带上上下文
  agent_chat.py "第二天换个清淡点的" --days 2 --history /tmp/chat.json

仅用标准库，无需依赖。

前置门禁（gate.py，默认开启）：先一步用 qwen3.8-flash 结合多轮记录判「是否本程序
业务 + 有无风险」，无关/风险问题直接一句婉拒挡回，不进下游大模型；输出侧再做
脱敏（手机号/证件号/密钥/路径/配置项），只回业务内容。--no-gate 可跳过（谨慎）。

服务端限流（防白喂大模型）：全局 QPS≤3；同一用户 10 秒只能问一句且串行
（认人用静默登录的小令牌 openid，没带令牌退回 IP）；query 超 300 字直接拒答。
本脚本会本地预检字数，429 时自动等 16 秒重试一次。带真实用户身份时用 --token 传
Authorization Bearer 令牌（小程序 wxlogin/dylogin 接口签发，30 天有效）。
"""

import argparse
import json
import re
import sys
import urllib.request

try:
    import gate as _gate  # 同目录：前置门禁（相关性 + 风险筛查）
except ImportError:  # 从别的 cwd 直接跑时兜底
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import gate as _gate

DEFAULT_API = "http://127.0.0.1:18821"

SPICY_WORDS = ["一点辣都不沾", "微辣就好", "能吃辣", "无辣不欢"]


def parse_args():
    p = argparse.ArgumentParser(description="辣条妹美食行程规划")
    p.add_argument("question", help="要对辣条妹说的话（原样传给 agent）")
    p.add_argument("--api", default=DEFAULT_API, help=f"服务地址，默认 {DEFAULT_API}")
    p.add_argument("--days", type=int, default=0, help="在杭天数（规划类问题强烈建议给）")
    p.add_argument("--spicy", type=int, choices=range(4), default=None,
                   help="辣度 0=完全不辣 1=微辣 2=能吃辣 3=无辣不欢；不传=未建档")
    p.add_argument("--hometown", default="", help="用户来自哪里（口味类比用）")
    p.add_argument("--taboo", default="", help="忌口，逗号分隔，如 香菜,内脏")
    p.add_argument("--budget", type=int, default=0, help="人均预算（元），0=不限")
    p.add_argument("--goal", default="", choices=["", "slim", "keep", "stingy", "thrill"],
                   help="目标: slim减脂 keep维持 stingy省钱 thrill放纵")
    p.add_argument("--loc", default="", help="定位，格式 '纬度,经度[,地标名]'，如 30.2590,120.1300,龙翔桥")
    p.add_argument("--history", default="", help="多轮对话 JSON 文件路径（自动读写）")
    p.add_argument("--token", default="", help="小程序静默登录签发的小令牌（按 openid 认人限流；不传按 IP）")
    p.add_argument("--no-gate", action="store_true",
                   help="跳过前置门禁（仅调试；正常调用别加）")
    p.add_argument("--raw", action="store_true", help="直接打印原始 JSON 响应")
    return p.parse_args()


def call_api(api, messages, prefs, loc, token=""):
    body = {"messages": messages, "prefs": prefs}
    if loc:
        body["loc"] = loc
    req = urllib.request.Request(
        api.rstrip("/") + "/api/mp/agent/chat",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for attempt in (1, 2):  # 429 限流：同 IP 10s 一问，等 11 秒重试一次
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            payload = e.read().decode("utf-8", "replace")
            if e.code == 429 and attempt == 1:
                import time
                time.sleep(11)
                continue
            raise SystemExit(f"接口报错 HTTP {e.code}: {payload[:300]}")
        except Exception as e:
            raise SystemExit(f"调用辣条妹服务失败（服务是否在跑？{api}）: {e}")


def strip_md(s):
    return re.sub(r"\*\*(.+?)\*\*", r"\1", s or "")


# ---- 输出脱敏：只回业务内容，密码/key/路径/号码等一律不透出 ----

SAN_PATTERNS = [
    (re.compile(r"\b\d{17}[\dXx]\b"), "[证件号已脱敏]"),
    (re.compile(r"\b1[3-9]\d{9}\b"), "[电话已脱敏]"),
    (re.compile(r"(?i)\bsk-[a-z0-9]{12,}\b"), "[密钥已脱敏]"),
    (re.compile(r"(?i)\bbearer\s+[a-z0-9._\-]{8,}"), "[令牌已脱敏]"),
    (re.compile(r"/(?:data|etc|home|root|srv|usr|var|opt)/[^\s\"，。]*"), "[路径已脱敏]"),
    (re.compile(r"LATIAOMEI_[A-Z_]+"), "[配置项已隐去]"),
]


def sanitize(s):
    """出口消毒：命中的敏感样式一律替换。宁可多花一次正则，不让泄漏见用户。"""
    for pat, rep in SAN_PATTERNS:
        s = pat.sub(rep, s)
    return s


def render_shop(it, indent="  "):
    bits = []
    name = it.get("shop") or "她灶上"
    dish = it.get("dish", "")
    bits.append(f"**{name}**" + (f" · {dish}" if dish else ""))
    meta = []
    if it.get("score"):
        meta.append(f"{it['score']}分")
    if it.get("tier_label"):
        meta.append(it["tier_label"])
    if it.get("price"):
        meta.append(f"人均{it['price']}元")
    if it.get("district"):
        meta.append(it["district"])
    if it.get("dist"):
        meta.append(f"距你{it['dist']}")
    if meta:
        bits.append("（" + " / ".join(meta) + "）")
    line = indent + "- " + " ".join(bits)
    if it.get("why"):
        line += f"\n{indent}  理由：{it['why']}"
    if it.get("order_tip"):
        line += f"\n{indent}  点单：{it['order_tip']}"
    line += f"\n{indent}  [slug: {it.get('slug', '')}]"
    return line


def render_blocks(blocks):
    out = []
    for b in blocks:
        t = b.get("type")
        if t == "text":
            out.append(b.get("md", "").replace("**", ""))
        elif t == "ask":
            q = b.get("q", "")
            mode = "多选" if b.get("multi") else "单选"
            lines = [f"【追问 · {mode}】{q}"]
            for o in b.get("options", []):
                d = f" —— {o['desc']}" if o.get("desc") else ""
                lines.append(f"  - {o.get('emoji', '')} {o['label']}{d}")
            lines.append("  （把用户的选择拼成一句话，再调一次本脚本续问）")
            out.append("\n".join(lines))
        elif t == "shops":
            title = b.get("title") or "推荐好店"
            lines = [f"【{title}】"]
            lines += [render_shop(it) for it in b.get("items", [])]
            out.append("\n".join(lines))
        elif t == "plan":
            title = b.get("title") or "美食行程规划"
            lines = [f"【🗓 {title}】"]
            for d in b.get("days", []):
                lines.append(f"  ◆ {d.get('label', '第%d天' % d.get('day', 1))}")
                for m in d.get("meals", []):
                    head = f"    {m.get('slot', '')} {m.get('time', '')} · {m.get('title', '')}"
                    if m.get("why"):
                        head += f"（{m['why']}）"
                    lines.append(head)
                    if m.get("shop"):
                        lines.append(render_shop(m["shop"], indent="      "))
            out.append("\n".join(lines))
        elif t == "tips":
            lines = [f"【📌 {b.get('title') or '注意事项'}】"]
            lines += [f"  - {s}" for s in b.get("items", [])]
            out.append("\n".join(lines))
        elif t == "actions":
            labels = [a.get("label", "") for a in b.get("items", [])]
            out.append("【快捷入口】" + " | ".join(labels))
    return out


def main():
    a = parse_args()
    if len(a.question) > 300:
        sys.exit(f"问题超过 300 字（当前 {len(a.question)} 字），服务端会直接拒答；"
                 "请精简成：在杭几天/能吃多辣/人均预算/住哪片")
    prefs = {"days": a.days, "budget": a.budget, "goal": a.goal,
             "hometown": a.hometown, "taboo": a.taboo, "text": ""}
    if a.spicy is not None:
        prefs["spicy"] = a.spicy
    loc = None
    if a.loc:
        parts = a.loc.split(",")
        if len(parts) >= 2:
            loc = {"lat": float(parts[0]), "lng": float(parts[1]),
                   "name": parts[2] if len(parts) > 2 else ""}

    messages = []
    if a.history:
        try:
            with open(a.history, encoding="utf-8") as f:
                messages = json.load(f)
        except FileNotFoundError:
            pass

    # ---- 前置门禁：qwen3.8-flash 结合多轮记录判相关 + 风险，拦下就不进下游 ----
    if not a.no_gate:
        action, reply, risk = _gate.check(a.question, messages)
        if action != "pass":
            if a.history:  # 拒绝也记入历史，下一轮能接回正题、也防换说法硬闯
                with open(a.history, "w", encoding="utf-8") as f:
                    json.dump(messages[-12:] + [{"role": "user", "content": a.question},
                                                {"role": "assistant", "content": "[婉拒] " + reply}],
                              f, ensure_ascii=False, indent=1)
            print(sanitize(reply))
            print(f"[gate: {action}" + (f"/{risk}" if risk != "none" else "") + "]")
            return

    messages = messages[-12:] + [{"role": "user", "content": a.question}]
    resp = call_api(a.api, messages, prefs, loc, a.token)
    data = (resp.get("data") or {}) if isinstance(resp, dict) else {}

    if a.raw:
        print(sanitize(json.dumps(resp, ensure_ascii=False, indent=2)))
    else:
        lines = []
        if data.get("thinking"):
            lines.append(f"（辣条妹内心 OS：{data['thinking']}）")
        lines += render_blocks(data.get("blocks", []))
        if data.get("chips"):
            lines.append("【顺着可以问】" + " | ".join(data["chips"]))
        lines.append(f"[engine: {data.get('engine', '?')}]")
        print(sanitize("\n\n".join(l for l in lines if l.strip())))

    if a.history:
        assistant_summary = " ".join(
            strip_md(b.get("md", "")) if b.get("type") == "text"
            else f"[{b.get('type')} {b.get('title', '')}]"
            for b in data.get("blocks", [])
        )[:600]
        with open(a.history, "w", encoding="utf-8") as f:
            json.dump(messages + [{"role": "assistant", "content": sanitize(assistant_summary)}],
                      f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
