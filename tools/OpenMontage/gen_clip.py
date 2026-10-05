#!/usr/bin/env python3
"""OpenMontage 驱动：用 happyhorse_video 工具给辣条妹出 6 段 5s 动态片段（共 30s）。

用法：.venv/bin/python gen_clip.py <编号 1-6>
首帧全部用本站公网定妆图（正面全身 9:16 / 脸部特写），保证人物形象一致。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from tools.video.happyhorse_video import HappyhorseVideo  # noqa: E402

FRONT = "https://latiaomei.infinityfly.xin/uploads/charref/latiaomei-front-916.jpg"
CLOSE = "https://latiaomei.infinityfly.xin/uploads/charref/latiaomei-closeup.jpg"

SHOTS = {
    1: dict(image=FRONT, duration=5, prompt=(
        "镜头缓慢推近，3D卡通写实风少女眨眼微笑，双丸子头微微晃动，"
        "右手举起不锈钢锅铲轻轻挥了挥打招呼，灰色摄影棚背景，光线柔和，竖屏构图")),
    2: dict(image=FRONT, duration=5, prompt=(
        "镜头环绕人物缓慢横移，少女单手转了一下锅铲，锅铲在掌心转半圈停住，"
        "她歪头露出自信笑容，橙色围裙随动作轻微摆动，竖屏构图")),
    3: dict(image=CLOSE, duration=5, prompt=(
        "脸部特写镜头缓慢推近，少女眨眨眼睛，嘴角上扬露出笑容，"
        "圆框眼镜镜片反过一下光，双丸子头碎发轻轻飘动，竖屏构图")),
    4: dict(image=FRONT, duration=5, prompt=(
        "少女双手把锅铲举到脸侧比了个加油的姿势，随后握拳收回胸前，"
        "身体微微前倾像在说话，围裙上的辣字牌晃动，活泼自然，竖屏构图")),
    5: dict(image=FRONT, duration=6, prompt=(
        "镜头从下往上缓慢摇，少女把锅铲朝前一递像邀请观众干杯，"
        "然后自己先笑起来，肩膀抖动，人物始终居中，竖屏构图")),
    6: dict(image=CLOSE, duration=6, prompt=(
        "特写镜头缓慢拉远，少女对镜头眨单眼比了个大拇指，"
        "笑容定格收尾，画面稳定，适合作为片尾，竖屏构图")),
}

def main() -> int:
    n = int(sys.argv[1])
    shot = SHOTS[n]
    out = Path(__file__).parent / "output" / "om-latiaomei-30s" / f"clip{n}.mp4"
    tool = HappyhorseVideo()
    res = tool.execute({
        "operation": "image_to_video",
        "prompt": shot["prompt"],
        "image_url": shot["image"],
        "duration": shot["duration"],
        "output_path": str(out),
        "poll_interval_seconds": 12,
        "timeout_seconds": 1500,
    })
    print(json.dumps({"shot": n, "success": res.success,
                      "data": res.data, "error": res.error}, ensure_ascii=False))
    return 0 if res.success else 1

if __name__ == "__main__":
    sys.exit(main())
