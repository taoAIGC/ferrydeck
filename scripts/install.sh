#!/bin/sh
# Ferrydeck 安装脚本（macOS）
#   curl -fsSL <你的下载站>/install.sh | sh
#
# 说明：
# - 用 curl 下载的文件不会被系统打上“隔离”标记，所以不会出现“无法打开，来自未识别的开发者”。
# - 会校验下载文件的 SHA-256；之后的应用内更新使用独立的签名校验。
# - 可用环境变量覆盖：FERRYDECK_DL_BASE（下载地址）、INSTALL_DIR（安装目录）、NO_OPEN=1（装完不自动打开）。
set -eu

BASE="${FERRYDECK_DL_BASE:-@DL_BASE@}"   # 发布时由 release.sh 填入真实的下载站地址
APP="Ferrydeck.app"
PKG="Ferrydeck.app.tar.gz"

case "$BASE" in *@DL_BASE@*) printf '%s\n' "这是未经发布处理的安装脚本，请设置 FERRYDECK_DL_BASE 后再运行，或使用发布出来的 install.sh" >&2; exit 1;; esac

say() { printf '%s\n' "$*"; }
fail() { printf '安装失败：%s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "这个安装脚本只支持 macOS"
for c in curl tar shasum awk; do command -v "$c" >/dev/null 2>&1 || fail "缺少命令：$c"; done

DEST="${INSTALL_DIR:-/Applications}"
if [ ! -d "$DEST" ] || [ ! -w "$DEST" ]; then
  # 没有 /Applications 写权限（例如受管理的电脑）就装到用户目录，不需要 sudo
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  say "没有 /Applications 的写权限，改装到 $DEST"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "正在下载Ferrydeck …"
curl -fL --retry 3 --retry-delay 2 --progress-bar "$BASE/$PKG" -o "$TMP/$PKG" || fail "下载失败，请检查网络"
curl -fsSL --retry 3 "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" || fail "下载校验文件失败"

EXPECTED="$(awk -v f="$PKG" '$2==f || $2=="*"f {print $1}' "$TMP/SHA256SUMS" | head -n1)"
ACTUAL="$(shasum -a 256 "$TMP/$PKG" | awk '{print $1}')"
[ -n "$EXPECTED" ] || fail "校验文件里没有 $PKG 的记录"
[ "$EXPECTED" = "$ACTUAL" ] || fail "文件校验不一致（期望 ${EXPECTED}，实际 ${ACTUAL}），已中止"

mkdir -p "$TMP/x"
tar -xzf "$TMP/$PKG" -C "$TMP/x" || fail "解压失败"
[ -d "$TMP/x/$APP" ] || fail "安装包里没有 $APP"

if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  say "检测到Ferrydeck正在运行，请先退出它再重新执行本脚本。"
  exit 1
fi

rm -rf "$DEST/$APP"
cp -R "$TMP/x/$APP" "$DEST/$APP" || fail "复制到 $DEST 失败"
# 保险起见清掉可能存在的隔离标记（curl 下载的文件本来就没有）
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
codesign --verify --deep "$DEST/$APP" >/dev/null 2>&1 || say "提示：应用签名校验未通过，如果无法打开，请在 系统设置 → 隐私与安全性 里点“仍要打开”"

say "已安装到 $DEST/$APP"
if [ "${NO_OPEN:-0}" != "1" ]; then
  open "$DEST/$APP" || true
fi
