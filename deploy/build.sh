#!/usr/bin/env bash
# 构建线上二进制。
#   用法：bash deploy/build.sh  → 产出 build/latiaomei（版本号写进 -ldflags）
# 这台机器内存小（1.6G，还跟别的站共用），所以固定限制编译器并发与 GC，
# 不然 modernc.org/sqlite 这种大包一编译就可能被 OOM killer 收走。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/build/latiaomei"

# 700MiB：900 在这台 1.6G 的共享机上编译 modernc.org/sqlite 时顶到过 OOM 边缘，
# 编译器峰值留 200M 余量给系统和其他站。
export GOMEMLIMIT="${GOMEMLIMIT:-700MiB}"
export GOGC="${GOGC:-50}"
export GOMAXPROCS="${GOMAXPROCS:-2}"
export CGO_ENABLED=0          # modernc.org/sqlite 是纯 Go，关掉 cgo 换可移植性

VER="$(cat "${ROOT}/VERSION" 2>/dev/null || date +%Y%m%d-%H%M%S)"

mkdir -p "${ROOT}/build"
cd "${ROOT}/src/server"

echo "构建中（GOMEMLIMIT=${GOMEMLIMIT} GOMAXPROCS=${GOMAXPROCS} 版本=${VER}）…"
go build -p 2 -trimpath -ldflags "-s -w -X main.version=${VER}" -o "${OUT}.tmp" ./cmd/latiaomei
mv "${OUT}.tmp" "${OUT}"
echo "完成：${OUT}（$(du -h "${OUT}" | cut -f1)）"
"${OUT}" version
