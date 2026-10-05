"""Alibaba token-plan HappyHorse video generation (DashScope-native async API).

HappyHorse 1.1 is the video model behind the latiaomei content pipeline.
Three variants exist on the token plan: t2v (cheapest, no reference image),
i2v (image-to-video, first-frame conditioned — the one we ship, it preserves the
Latiaomei character identity from the official turnaround/closeup stills), and
r2v (reference-to-video, most expensive).

Protocol (verified live 2026-09-30):
  submit: POST {HAPPYHORSE_API_BASE}/api/v1/services/aigc/video-generation/video-synthesis
          headers: X-DashScope-Async: enable
          body: {"model": ..., "input": {"prompt": ..., "media": [{"type": "first_frame", "url": ...}]},
                 "parameters": {"duration": N}}
          -> {"output": {"task_id": ..., "task_status": "PENDING"}}
  poll:   GET  {HAPPYHORSE_API_BASE}/api/v1/tasks/{task_id}
          -> output.task_status PENDING|RUNNING|SUCCEEDED|FAILED, output.video_url

Note: the first_frame media url MUST be publicly reachable (the gateway fetches it).
Local files should be served from the latiaomei site (/uploads/...) and passed as URLs.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    RetryPolicy,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
)


class HappyhorseVideo(BaseTool):
    name = "happyhorse_video"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "video_generation"
    provider = "tokenplan"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []
    install_instructions = (
        "Set HAPPYHORSE_API_BASE (gateway root, e.g. https://token-plan.cn-beijing.maas.aliyuncs.com),\n"
        "  HAPPYHORSE_API_KEY (token-plan key), and optionally HAPPYHORSE_MODEL\n"
        "  (default happyhorse-1.1-i2v — the cheapest variant that accepts a reference first frame)."
    )
    agent_skills = ["ai-video-gen"]

    capabilities = ["text_to_video", "image_to_video"]
    supports = {
        "text_to_video": True,
        "image_to_video": True,
        "reference_image": True,
        "character_consistency": True,
        "native_audio": False,
    }
    best_for = [
        "character-consistent motion clips from an official turnaround / closeup still (first frame)",
        "cheap subscription-billed video generation via the Alibaba token plan",
        "5-10 second vertical inserts for short-form edits",
    ]
    not_good_for = ["local files as first frame (url must be public)", "long-form single-shot video"]
    fallback_tools = ["veo_video", "kling_video", "minimax_video"]
    quality_score = 0.82

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string", "description": "Motion / camera description (Chinese works best)"},
            "operation": {
                "type": "string",
                "enum": ["text_to_video", "image_to_video"],
                "default": "image_to_video",
            },
            "model": {
                "type": "string",
                "description": "Default HAPPYHORSE_MODEL env or happyhorse-1.1-i2v",
            },
            "image_url": {
                "type": "string",
                "description": "Publicly reachable first-frame URL (image_to_video)",
            },
            "duration": {"type": "integer", "minimum": 3, "maximum": 10, "default": 5},
            "output_path": {"type": "string"},
            "poll_interval_seconds": {"type": "integer", "minimum": 3, "default": 10},
            "timeout_seconds": {"type": "integer", "minimum": 60, "default": 1200},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=256, vram_mb=0, disk_mb=500, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["prompt", "operation", "model", "image_url", "duration"]
    side_effects = ["writes video file to output_path", "calls token-plan video API"]
    user_visible_verification = ["Watch the clip: character identity should match the first-frame still"]

    def get_status(self) -> ToolStatus:
        if os.environ.get("HAPPYHORSE_API_KEY") and os.environ.get("HAPPYHORSE_API_BASE"):
            return ToolStatus.AVAILABLE
        return ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        # Billed against the token-plan subscription; conservative placeholder for
        # the budget ledger (per-second of generated video).
        return 0.02 * int(inputs.get("duration", 5))

    def estimate_runtime(self, inputs: dict[str, Any]) -> float:
        # Measured: a 5s clip takes ~4-5 minutes end to end.
        return 120.0 + int(inputs.get("duration", 5)) * 45.0

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        base = (os.environ.get("HAPPYHORSE_API_BASE") or "").rstrip("/")
        key = os.environ.get("HAPPYHORSE_API_KEY") or ""
        model = inputs.get("model") or os.environ.get("HAPPYHORSE_MODEL") or "happyhorse-1.1-i2v"
        if not (base and key):
            return ToolResult(success=False, error="HAPPYHORSE_API_BASE / HAPPYHORSE_API_KEY not set. " + self.install_instructions)

        import requests
        from tools.video._shared import probe_output

        prompt = str(inputs.get("prompt") or "").strip()
        if not prompt:
            return ToolResult(success=False, error="prompt is required")
        operation = inputs.get("operation", "image_to_video")
        duration = max(3, min(10, int(inputs.get("duration", 5))))

        body: dict[str, Any] = {
            "model": model,
            "input": {"prompt": prompt},
            "parameters": {"duration": duration},
        }
        if operation == "image_to_video":
            image_url = inputs.get("image_url")
            if not image_url:
                return ToolResult(
                    success=False,
                    error="image_to_video needs image_url (publicly reachable URL; "
                          "host local stills under the site's /uploads/ and pass the absolute URL)",
                )
            body["input"]["media"] = [{"type": "first_frame", "url": image_url}]

        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-DashScope-Async": "enable"}
        start = time.time()
        try:
            resp = requests.post(
                f"{base}/api/v1/services/aigc/video-generation/video-synthesis",
                headers=headers, json=body, timeout=60,
            )
            data = resp.json()
            task_id = (data.get("output") or {}).get("task_id")
            if resp.status_code != 200 or not task_id:
                return ToolResult(success=False, error=f"submit failed HTTP {resp.status_code}: {str(data)[:300]}")

            deadline = time.time() + int(inputs.get("timeout_seconds", 1200))
            poll = max(3, int(inputs.get("poll_interval_seconds", 10)))
            out: dict[str, Any] = {}
            while time.time() < deadline:
                time.sleep(poll)
                pr = requests.get(f"{base}/api/v1/tasks/{task_id}", headers={"Authorization": f"Bearer {key}"}, timeout=30)
                out = (pr.json() or {}).get("output") or {}
                st = out.get("task_status")
                if st == "SUCCEEDED":
                    break
                if st in ("FAILED", "CANCELED", "UNKNOWN"):
                    return ToolResult(success=False, error=f"generation {st}: {out.get('code')} {out.get('message')}"[:400])
            else:
                return ToolResult(success=False, error=f"timed out waiting for task {task_id}")

            video_url = out.get("video_url")
            if not video_url:
                return ToolResult(success=False, error=f"SUCCEEDED but no video_url: {str(out)[:200]}")
            dl = requests.get(video_url, timeout=300)
            dl.raise_for_status()
            output_path = Path(inputs.get("output_path") or f"happyhorse_{task_id[:8]}.mp4")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(dl.content)
        except Exception as e:  # noqa: BLE001 — surface as ToolResult, never crash the agent
            return ToolResult(success=False, error=f"happyhorse video generation failed: {e}")

        probed = probe_output(output_path)
        return ToolResult(
            success=True,
            data={
                "provider": "tokenplan",
                "model": model,
                "operation": operation,
                "task_id": task_id,
                "output_path": str(output_path),
                "duration_seconds": duration,
                "elapsed_seconds": round(time.time() - start, 1),
                "cost_usd": self.estimate_cost(inputs),
                **probed,
            },
        )
