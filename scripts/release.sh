#!/bin/bash
# 把 Tauri 构建产物整理成可以直接上传到你的下载站（FERRYDECK_DL_BASE）的目录。
# 用法：先构建（见 README），再运行 scripts/release.sh [更新说明]
set -euo pipefail

cd "$(dirname "$0")/.."
# 发布配置放在 .release.env（已被 .gitignore 忽略），模板见 scripts/release.env.example；命令行里已设置的环境变量优先
if [ -f .release.env ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in ''|\#*) continue;; esac
    [ -z "${!_k:-}" ] && export "$_k=$_v"
  done < .release.env
fi
: "${FERRYDECK_DL_BASE:?请先设置 FERRYDECK_DL_BASE（下载站地址，如 https://example.com/desktop），见 scripts/release.env.example}"
APP_DIR="app/src-tauri"
VERSION="$(python3 -c "import json;print(json.load(open('$APP_DIR/tauri.conf.json'))['version'])")"
NOTES="${1:-Ferrydeck $VERSION}"
BASE_URL="${FERRYDECK_DL_BASE%/}"
OUT="release/desktop"

# 两个架构各一套安装文件，让用户自己选：Apple 芯片（M1/M2/M3…）= aarch64，Intel = x64
#   构建：npm run tauri build -- --target aarch64-apple-darwin / --target x86_64-apple-darwin
ARCHS="aarch64:aarch64-apple-darwin x64:x86_64-apple-darwin"
rm -rf "$OUT"; mkdir -p "$OUT"
for pair in $ARCHS; do
  name="${pair%%:*}"; triple="${pair#*:}"
  bundle="$APP_DIR/target/$triple/release/bundle"
  tgz="$bundle/macos/Ferrydeck.app.tar.gz"
  sig="$tgz.sig"
  dmg="$(ls "$bundle"/dmg/*.dmg 2>/dev/null | head -n1 || true)"
  for f in "$tgz" "$sig" "$dmg"; do [ -f "$f" ] || { echo "缺少构建产物：${f}（先构建 ${triple}）" >&2; exit 1; }; done
  cp "$tgz" "$OUT/Ferrydeck_${name}.app.tar.gz"
  cp "$sig" "$OUT/Ferrydeck_${name}.app.tar.gz.sig"
  cp "$dmg" "$OUT/Ferrydeck_${name}.dmg"
done
# 把下载站地址写进发给用户的安装脚本里
sed "s|@DL_BASE@|$BASE_URL|g" scripts/install.sh > "$OUT/install.sh" && chmod +x "$OUT/install.sh"

# 应用内更新读取的是 tauri.conf.json 里的 endpoints；它的域名必须和下载站一致，否则用户永远收不到更新
ENDPOINT_HOST="$(python3 -c "import json,urllib.parse as u;print(u.urlparse(json.load(open('$APP_DIR/tauri.conf.json'))['plugins']['updater']['endpoints'][0]).netloc)")"
BASE_HOST="$(python3 -c "import urllib.parse as u,sys;print(u.urlparse(sys.argv[1]).netloc)" "$BASE_URL")"
if [ "$ENDPOINT_HOST" != "$BASE_HOST" ] && ! echo "$BASE_URL" | grep -q "127.0.0.1"; then
  echo "警告：tauri.conf.json 的更新地址（${ENDPOINT_HOST}）和下载站（${BASE_HOST}）不一致，已安装的用户不会从这里收到更新。" >&2
fi

python3 - "$OUT" "$VERSION" "$NOTES" "$BASE_URL" <<'PY'
import json, sys, datetime
out, version, notes, base = sys.argv[1:5]
def entry(name):
    return {"signature": open(f"{out}/Ferrydeck_{name}.app.tar.gz.sig").read().strip(), "url": f"{base}/Ferrydeck_{name}.app.tar.gz"}
latest = {
    "version": version,
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    # 应用内更新按架构各取各的包
    "platforms": {"darwin-aarch64": entry("aarch64"), "darwin-x86_64": entry("x64")},
}
json.dump(latest, open(f"{out}/latest.json", "w"), ensure_ascii=False, indent=2)
PY

( cd "$OUT" && shasum -a 256 Ferrydeck_*.app.tar.gz Ferrydeck_*.dmg install.sh > SHA256SUMS )
echo "已生成 ${OUT}（版本 ${VERSION}）："; ls -la "$OUT"
