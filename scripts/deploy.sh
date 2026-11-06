#!/bin/bash
# 把 release/desktop/ 上传到你的服务器。需要在 .release.env 里配置 DEPLOY_HOST / DEPLOY_DIR / FERRYDECK_DL_BASE。
# 默认只做“演练”（显示会做什么）；加 --yes 才真正上传。
# Caddy 配置只做检查，不自动修改：如果缺少 /desktop/ 的静态路由，会提示你加入 scripts/caddy-desktop.snippet。
set -euo pipefail
cd "$(dirname "$0")/.."
# 发布配置放在 .release.env（已被 .gitignore 忽略），模板见 scripts/release.env.example；命令行里已设置的环境变量优先
if [ -f .release.env ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in ''|\#*) continue;; esac
    [ -z "${!_k:-}" ] && export "$_k=$_v"
  done < .release.env
fi
: "${DEPLOY_HOST:?请在 .release.env 里设置 DEPLOY_HOST（ssh 主机名）}"
: "${DEPLOY_DIR:?请在 .release.env 里设置 DEPLOY_DIR（服务器上的目录）}"
: "${FERRYDECK_DL_BASE:?请在 .release.env 里设置 FERRYDECK_DL_BASE（对外下载地址）}"

HOST="$DEPLOY_HOST"
REMOTE_DIR="$DEPLOY_DIR"
SRC="release/desktop"
[ -f "$SRC/latest.json" ] || { echo "没有 ${SRC}，请先运行 scripts/release.sh（并确认没有用本机地址）" >&2; exit 1; }

if grep -q '127.0.0.1\|localhost' "$SRC/latest.json"; then
  echo "拒绝：latest.json 里的下载地址指向本机，请用默认地址重新运行 scripts/release.sh" >&2
  exit 1
fi

echo "将上传到 ${HOST}:${REMOTE_DIR}："
ls -la "$SRC"
if [ "${1:-}" != "--yes" ]; then
  echo; echo "（演练模式，没有上传。确认无误后加 --yes 执行）"
  exit 0
fi

ssh "$HOST" "sudo mkdir -p '$REMOTE_DIR' && sudo chown \$(id -un) '$REMOTE_DIR'"
# 先传安装包，最后传 latest.json：这样客户端读到新清单时，包一定已经就位
rsync -av --exclude latest.json "$SRC"/ "$HOST:$REMOTE_DIR/"
rsync -av "$SRC/latest.json" "$HOST:$REMOTE_DIR/latest.json"

echo "== 检查线上"
BASE="${FERRYDECK_DL_BASE%/}"
curl -fsSI "$BASE/latest.json" | head -3
if curl -fsS "$BASE/latest.json" | python3 -c "import sys,json;json.load(sys.stdin)" 2>/dev/null; then
  echo "latest.json 可正常访问"
else
  echo "警告：$BASE/latest.json 返回的不是 JSON。多半是 Caddy 还没有 /desktop/ 的静态路由，请把 scripts/caddy-desktop.snippet 加到你的站点配置里（放在兜底 handle 之前）并 reload。" >&2
  exit 2
fi
