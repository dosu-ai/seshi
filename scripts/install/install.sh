#!/bin/sh
# Installs the seshi binary on macOS or Linux (F8.4): downloads the release archive for this
# machine, checks it against the release's SHA256SUMS, puts `seshi` in ~/.local/bin and, when
# that folder is not on the PATH, adds it in your shell's startup file.
#
#   curl -fsSL https://github.com/dosu-ai/seshi/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --version 1.2.3 --dir /usr/local/bin --no-modify-path
#
# Options:
#   --version <X.Y.Z>   a release (the latest by default)
#   --dir <folder>      where to put seshi ($XDG_BIN_HOME, else ~/.local/bin)
#   --no-modify-path    never edit a shell startup file
#   --base-url <url>    where releases are (a mirror; https://github.com/<repo>/releases)
#
# Settings are flags rather than SESHI_* variables on purpose: seshi refuses SESHI_* names it
# does not know, so an exported installer variable would break every seshi command.
# On Windows, use install.ps1.

set -eu

REPOSITORY="dosu-ai/seshi"
CHECKSUMS="SHA256SUMS"

version=""
dir=""
base_url="https://github.com/$REPOSITORY/releases"
modify_path=1

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'seshi install: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: install.sh [--version <X.Y.Z>] [--dir <folder>] [--no-modify-path] [--base-url <url>]

  --version <X.Y.Z>   a release (the latest by default)
  --dir <folder>      where to put seshi ($XDG_BIN_HOME, else ~/.local/bin)
  --no-modify-path    never edit a shell startup file
  --base-url <url>    where releases are (default https://github.com/dosu-ai/seshi/releases)
EOF
}

need_value() {
  [ "$2" -ge 2 ] || fail "$1 needs a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) need_value "$1" $#; version=$2; shift 2 ;;
    --version=*) version=${1#*=}; shift ;;
    --dir) need_value "$1" $#; dir=$2; shift 2 ;;
    --dir=*) dir=${1#*=}; shift ;;
    --base-url) need_value "$1" $#; base_url=$2; shift 2 ;;
    --base-url=*) base_url=${1#*=}; shift ;;
    --no-modify-path) modify_path=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

version=${version#v}
case "$version" in
  *[!0-9A-Za-z.+-]*) fail "not a version: $version" ;;
esac
base_url=${base_url%/}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) fail "on Windows, use install.ps1 (PowerShell)" ;;
  *) fail "seshi has no binary for $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "seshi has no binary for $(uname -s) $(uname -m)" ;;
esac
if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  # A shell under Rosetta 2 reports x86_64 on Apple silicon; the native build is better.
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
fi
# glibc or musl. `ldd --version` names its C library on both; a glibc system may also have
# musl's loader installed (Debian's musl package), so that only counts when nothing says glibc.
libc_of() {
  case "$(ldd --version 2>&1 || true)" in
    *musl*|*MUSL*) echo musl; return ;;
    *GLIBC*|*"GNU libc"*|*"GNU C Library"*) echo glibc; return ;;
  esac
  if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo glibc; return; fi
  if ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl; return; fi
  echo glibc
}
if [ "$os" = linux ]; then
  if [ "$(libc_of)" = musl ]; then
    fail "seshi's Linux binaries need glibc, and this system uses musl (Alpine, for example); use a glibc-based system or the Docker image"
  fi
  if [ "$arch" = arm64 ] && [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = 32 ]; then
    fail "this is a 32-bit system on a 64-bit ARM CPU; seshi needs a 64-bit userland"
  fi
fi
asset="seshi-$os-$arch.tar.gz"

if [ -z "$version" ]; then
  download_url="$base_url/latest/download"
else
  download_url="$base_url/download/v$version"
fi

download() {
  if command -v curl >/dev/null 2>&1; then
    case "$1" in
      https://*) curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$2" ;;
      *) curl -fsSL "$1" -o "$2" ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    case "$1" in
      https://*) wget --https-only -q -O "$2" "$1" ;;
      *) wget -q -O "$2" "$1" ;;
    esac
  else
    fail "neither curl nor wget is installed"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 <"$1" | sed 's/^.*= *//'
  else
    fail "no SHA-256 tool (sha256sum, shasum or openssl) to check the download with"
  fi
}

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t seshi-install)
trap 'rm -rf "$tmp"' EXIT
trap 'rm -rf "$tmp"; exit 130' INT TERM

say "Downloading $asset${version:+ (v$version)}"
download "$download_url/$asset" "$tmp/$asset" || fail "could not download $download_url/$asset"
download "$download_url/$CHECKSUMS" "$tmp/$CHECKSUMS" ||
  fail "could not download $download_url/$CHECKSUMS"

expected=$(awk -v f="$asset" '$2 == f || $2 == ("*" f) { print $1; exit }' "$tmp/$CHECKSUMS")
[ -n "$expected" ] || fail "$CHECKSUMS has no line for $asset"
actual=$(sha256_of "$tmp/$asset")
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
actual=$(printf '%s' "$actual" | tr 'A-F' 'a-f')
if [ "$actual" != "$expected" ]; then
  fail "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"
fi

mkdir "$tmp/unpacked"
tar -xzf "$tmp/$asset" -C "$tmp/unpacked" || fail "could not unpack $asset"
[ -f "$tmp/unpacked/seshi" ] || fail "$asset holds no seshi binary"

if [ -z "$dir" ]; then
  dir=${XDG_BIN_HOME:-$HOME/.local/bin}
fi
mkdir -p "$dir" || fail "could not create $dir"
case "$dir" in
  /*) ;;
  *) dir=$(cd "$dir" && pwd) || fail "could not resolve $dir" ;;
esac
# Copy next to the target, then rename: atomic, and safe while an older seshi is running.
cp "$tmp/unpacked/seshi" "$dir/.seshi.$$" || fail "could not write to $dir"
chmod 755 "$dir/.seshi.$$"
mv -f "$dir/.seshi.$$" "$dir/seshi" || { rm -f "$dir/.seshi.$$"; fail "could not write $dir/seshi"; }

installed=$("$dir/seshi" --version 2>/dev/null) || fail "$dir/seshi was installed but does not run"
say "Installed $installed to $dir/seshi"

case ":$PATH:" in
  *":$dir:"*) exit 0 ;;
esac

if [ "$modify_path" = 0 ]; then
  say "$dir is not on your PATH; add it to run seshi by name."
  exit 0
fi
case "$dir" in
  *[\"\$\`\\]*)
    say "$dir is not on your PATH; add it yourself (its name has characters this script will not write into a startup file)."
    exit 0
    ;;
esac

shell_name=$(basename "${SHELL:-sh}")
case "$shell_name" in
  zsh)
    rc="${ZDOTDIR:-$HOME}/.zshrc"
    line="export PATH=\"$dir:\$PATH\""
    ;;
  bash)
    if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
    line="export PATH=\"$dir:\$PATH\""
    ;;
  fish)
    rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
    line="fish_add_path \"$dir\""
    ;;
  *)
    rc="$HOME/.profile"
    line="export PATH=\"$dir:\$PATH\""
    ;;
esac

if [ -f "$rc" ] && grep -qxF "$line" "$rc"; then
  say "$rc already adds $dir to PATH; open a new shell to use seshi."
  exit 0
fi
mkdir -p "$(dirname "$rc")"
printf '\n# seshi\n%s\n' "$line" >>"$rc" || {
  say "$dir is not on your PATH, and $rc could not be changed; add it yourself."
  exit 0
}
say "Added $dir to PATH in $rc. Open a new shell, or run: $line"
