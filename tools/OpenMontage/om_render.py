#!/usr/bin/env python3
"""latiaomei 出片驱动（OpenMontage 引擎）：分镜 JSON → 逐镜动态片段 → 拼接成片。

由 tools/pipeline/jobs/project_step.js 在 renderer=openmontage 时调用：
  .venv/bin/python om_render.py <spec.json>

spec.json:
{
  "shots": [ {"index": 1, "prompt": "...", "first_frame_url": "https://... (可空)",
              "image_path": "/abs/path 本地图（可空，first_frame_url 缺失时做 2.5D 动镜）",
              "duration": 5, "title": "主文案（仅记录，不烧字幕）"} ],
  "output_path": "/abs/out.mp4",
  "transition": "cut|crossfade",
  "bgm_path": "/abs/bgm.mp3 (可空)",
  "target_secs": 30, "resolution": "1080x1920", "fps": 30
}

每镜策略（尽量动态、绝不整单失败）：
  1. 有公网首帧 → OpenMontage HappyhorseVideo（token-plan happyhorse-1.1-i2v）生成真动效片段；
  2. 只有本地图 → ffmpeg zoompan 2.5D 缓推；
  3. 什么都没有 → 纯色调空镜。
拼接统一走 OpenMontage VideoStitch；有 BGM 再 ffmpeg 混音 + 片尾淡出。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tools.video.happyhorse_video import HappyhorseVideo  # noqa: E402
from tools.video.video_stitch import VideoStitch  # noqa: E402


def run_ffmpeg(args: list[str]) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def zoompan_clip(img: Path, secs: int, out: Path, res: tuple[int, int]) -> None:
    """单帧输入 + zoompan d=总帧数（切勿 -loop 1：那会让输出帧数 = 输入帧数 × d）。"""
    w, h = res
    frames = secs * 30
    run_ffmpeg([
        "-i", str(img),
        "-vf", (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
                f"zoompan=z='min(zoom+0.0008,1.12)':d={frames}"
                f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={w}x{h}:fps=30"),
        "-frames:v", str(frames), "-r", "30",
        "-c:v", "libx264", "-crf", "21", "-pix_fmt", "yuv420p", str(out),
    ])


def solid_clip(secs: int, out: Path, res: tuple[int, int]) -> None:
    w, h = res
    run_ffmpeg(["-f", "lavfi", "-i", f"color=c=0x2a241d:s={w}x{h}:r=30:d={secs}",
                "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", str(out)])


def blurpad_to_vertical(clip: Path, out: Path, res: tuple[int, int]) -> None:
    """方幅/横幅片段垫模糊背景拉成竖屏（与人工版一致）。"""
    w, h = res
    run_ffmpeg([
        "-i", str(clip),
        "-filter_complex", (f"[0:v]split=2[bg][fg];[bg]scale={w}:{h}:force_original_aspect_ratio=increase,"
                            f"crop={w}:{h},gblur=sigma=24[bgb];[fg]scale={w}:-2[fgs];"
                            f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v]"),
        "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "21", str(out),
    ])


def main() -> int:
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_path = Path(spec["output_path"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    res = tuple(int(x) for x in spec.get("resolution", "1080x1920").split("x"))
    workdir = out_path.parent / f"_omwork_{out_path.stem}"
    workdir.mkdir(parents=True, exist_ok=True)

    hh = HappyhorseVideo()
    clips: list[str] = []
    stats = {"happyhorse": 0, "zoompan": 0, "solid": 0, "hh_failed": 0}

    for shot in spec.get("shots", []):
        i = int(shot.get("index", len(clips) + 1))
        secs = max(3, min(10, int(shot.get("duration", 5))))
        clip = workdir / f"shot{i:02d}.mp4"
        made = False
        if shot.get("first_frame_url"):
            r = hh.execute({
                "operation": "image_to_video",
                "prompt": shot.get("prompt") or "镜头缓慢推近，人物自然微动",
                "image_url": shot["first_frame_url"],
                "duration": secs,
                "output_path": str(clip),
                "poll_interval_seconds": 12,
                "timeout_seconds": int(spec.get("hh_timeout_seconds", 1500)),
            })
            if r.success:
                stats["happyhorse"] += 1
                made = True
            else:
                stats["hh_failed"] += 1
                print(f"[om_render] shot{i} happyhorse 失败，降级: {r.error}", file=sys.stderr)
        if not made and shot.get("image_path") and Path(shot["image_path"]).exists():
            zoompan_clip(Path(shot["image_path"]), secs, clip, res)
            stats["zoompan"] += 1
            made = True
        if not made:
            solid_clip(secs, clip, res)
            stats["solid"] += 1
            made = True
        # 统一竖屏（i2v 可能返回方幅/横幅）
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", str(clip)],
                               capture_output=True, text=True).stdout.strip()
        try:
            cw, ch = (int(x) for x in probe.split("x"))
        except ValueError:
            cw, ch = res[0], res[1]
        if abs(cw / ch - res[0] / res[1]) > 0.02:
            padded = workdir / f"shot{i:02d}p.mp4"
            blurpad_to_vertical(clip, padded, res)
            clip = padded
        clips.append(str(clip))

    stitched = workdir / "stitched.mp4"
    vr = VideoStitch().execute({
        "operation": "stitch", "clips": clips, "output_path": str(stitched),
        "transition": spec.get("transition", "cut"), "auto_normalize": True,
        "target_resolution": spec.get("resolution", "1080x1920"),
        "target_fps": int(spec.get("fps", 30)),
    })
    if not vr.success:
        print(f"[om_render] stitch 失败: {vr.error}", file=sys.stderr)
        return 2

    dur = float(spec.get("target_secs") or 0)
    fade_in = "afade=t=in:st=0:d=1.5," if spec.get("bgm_path") else ""
    if dur:
        filters = f"[0:v]fade=t=out:st={max(0, dur - 1):.2f}:d=1[v]"
    else:
        filters = "[0:v]null[v]"
    cmd = ["-i", str(stitched)]
    if spec.get("bgm_path"):
        cmd += ["-stream_loop", "2", "-i", spec["bgm_path"]]
        filters += f";[1:a]atrim=0:{dur or 9999:.2f},{fade_in}volume=0.22,afade=t=out:st={max(0, (dur or 9999) - 1.5):.2f}:d=1.5[a]"
        maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "128k"]
    else:
        maps = ["-map", "[v]", "-an"]
    final = ["-t", f"{dur:.2f}"] if dur else []
    run_ffmpeg([*cmd, "-filter_complex", filters, *maps, *final,
                "-c:v", "libx264", "-crf", "21", "-preset", "medium", "-movflags", "+faststart", str(out_path)])
    subprocess.run(["rm", "-rf", str(workdir)], check=False)
    print(json.dumps({"success": True, "output": str(out_path), "stats": stats}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
