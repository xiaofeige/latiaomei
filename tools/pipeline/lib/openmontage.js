'use strict';
// OpenMontage 渲染引擎桥（v13.1）：项目出片可选 renderer=openmontage 时走这里。
// 做法：把分镜转成 spec JSON → 子进程调 tools/OpenMontage/om_render.py（它自己的 venv，
// 内部用 OpenMontage 的 HappyhorseVideo + VideoStitch 工具）→ 拿回成片路径。
// 与 hyperframes 引擎的分工：hyperframes=图文卡+旁白+Ken Burns；openmontage=纯动态剪辑
// （逐镜 happyhorse 真动效 + 拼接 + 配乐，无字卡无旁白）。缺 OpenMontage 安装时 available()=false，
// 调用方自动退回 hyperframes，绝不卡流水线。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const OM_DIR = (process.env.OPENMONTAGE_DIR || '/data/www/latiaomei/tools/OpenMontage').trim();
const PY = path.join(OM_DIR, '.venv/bin/python');
const DRIVER = path.join(OM_DIR, 'om_render.py');

// 单条成片交给 happyhorse 生成的镜头上限（其余镜头走本地 zoompan 缓推）。
const OM_MAX_SHOTS = Number(process.env.OM_MAX_SHOTS || 6);
// 整单渲染超时：6 镜 × ~5min 生成 + 拼接混音，默认放宽到 75 分钟。
const OM_TIMEOUT_MS = Number(process.env.OM_TIMEOUT_SECS || 4500) * 1000;

function available() {
  return fs.existsSync(PY) && fs.existsSync(DRIVER);
}

// spec: { shots:[{index,prompt,first_frame_url,image_path,duration}], output_path,
//         transition, bgm_path, target_secs, resolution, fps }
// 同步阻塞渲染（worker 本就单并发），返回 {output, stats}；失败抛错。
function render(spec, { log = console.log } = {}) {
  if (!available()) throw new Error('OpenMontage 未安装（OPENMONTAGE_DIR 下缺 om_render.py/.venv）');
  const specPath = spec.output_path + '.spec.json';
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const out = cp.execFileSync(PY, [DRIVER, specPath], {
    encoding: 'utf8', timeout: OM_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'], // 驱动的过程日志直接进 worker journal
  });
  fs.rmSync(specPath, { force: true });
  const line = String(out || '').trim().split('\n').filter(Boolean).pop();
  let j = null;
  try { j = JSON.parse(line); } catch { /* 下面统一报 */ }
  if (!j || !j.success) throw new Error('OpenMontage 渲染未返回成功结果：' + String(line || out).slice(0, 300));
  log(`[openmontage] 渲染完成 ${j.output} 镜头统计=${JSON.stringify(j.stats)}`);
  return j;
}

module.exports = { available, render, OM_MAX_SHOTS, OM_DIR };
