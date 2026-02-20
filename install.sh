#!/usr/bin/env bash
set -euo pipefail

REPO="reoring/roboppi"
GITHUB="https://github.com/${REPO}"
API="https://api.github.com/repos/${REPO}"

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "roboppi install: $*"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

usage() {
  cat >&2 <<'EOF'
Install Roboppi from GitHub Releases.

USAGE
  curl -fsSL https://raw.githubusercontent.com/reoring/roboppi/main/install.sh | bash

OPTIONS
  --tag <vX.Y.Z>          Install a specific release tag (default: latest)
  --version <X.Y.Z>       Shorthand for --tag vX.Y.Z
  --install-dir <dir>     Install directory for the roboppi binary
  --prefix <dir>          Install to <dir>/bin
  --no-verify             Skip sha256 verification
  --dry-run               Print actions without installing
  --help                  Show this help

ENV
  ROBOPPI_INSTALL_DIR     Same as --install-dir

NOTES
  - Supported: macOS (x64/arm64), Linux (x64/arm64)
  - This script downloads the prebuilt binary from GitHub Releases.
EOF
}

fetch() {
  local url="$1"
  if need_cmd curl; then
    curl -fsSL "$url"
    return 0
  fi
  if need_cmd wget; then
    wget -qO- "$url"
    return 0
  fi
  die "need curl or wget"
}

download_to() {
  local url="$1"
  local out="$2"
  if need_cmd curl; then
    curl -fSL "$url" -o "$out"
    return 0
  fi
  if need_cmd wget; then
    wget -qO "$out" "$url"
    return 0
  fi
  die "need curl or wget"
}

sha256_file() {
  local file="$1"
  if need_cmd sha256sum; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if need_cmd shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  die "need sha256sum or shasum"
}

resolve_latest_tag() {
  # Extract "tag_name" from GitHub API JSON without jq.
  fetch "${API}/releases/latest" |
    awk -F'"' '/"tag_name"[[:space:]]*:/ {print $4; exit}'
}

map_platform() {
  local os arch
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"

  case "$os" in
    Linux) os="linux" ;;
    Darwin) os="macos" ;;
    *) die "unsupported OS: ${os:-unknown}" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) die "unsupported architecture: ${arch:-unknown}" ;;
  esac

  printf '%s-%s' "$os" "$arch"
}

main() {
  local tag=""
  local install_dir="${ROBOPPI_INSTALL_DIR:-}"
  local verify=1
  local dry_run=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tag)
        [[ $# -ge 2 ]] || die "--tag requires a value"
        tag="$2"
        shift 2
        ;;
      --version)
        [[ $# -ge 2 ]] || die "--version requires a value"
        tag="$2"
        if [[ "$tag" != v* ]]; then tag="v${tag}"; fi
        shift 2
        ;;
      --install-dir)
        [[ $# -ge 2 ]] || die "--install-dir requires a value"
        install_dir="$2"
        shift 2
        ;;
      --prefix)
        [[ $# -ge 2 ]] || die "--prefix requires a value"
        install_dir="$2/bin"
        shift 2
        ;;
      --no-verify)
        verify=0
        shift
        ;;
      --dry-run)
        dry_run=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1 (try --help)"
        ;;
    esac
  done

  if [[ -z "$tag" ]]; then
    tag="$(resolve_latest_tag || true)"
    [[ -n "$tag" ]] || die "failed to resolve latest release tag; use --tag vX.Y.Z"
  else
    if [[ "$tag" != v* ]]; then tag="v${tag}"; fi
  fi

  local platform asset base_url
  platform="$(map_platform)"
  asset="roboppi-${tag}-${platform}.tar.gz"
  base_url="${GITHUB}/releases/download/${tag}"

  if [[ -z "$install_dir" ]]; then
    if [[ -w "/usr/local/bin" ]]; then
      install_dir="/usr/local/bin"
    else
      install_dir="${HOME}/.local/bin"
    fi
  fi

  local tmp
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t roboppi)"
  trap 'rm -rf "$tmp"' EXIT

  log "roboppi install: tag=${tag} platform=${platform}"
  log "roboppi install: downloading ${asset}"

  if [[ "$dry_run" -eq 1 ]]; then
    log "dry-run: would download ${base_url}/${asset}"
    log "dry-run: would install to ${install_dir}/roboppi"
    return 0
  fi

  download_to "${base_url}/${asset}" "${tmp}/${asset}" || die "download failed: ${base_url}/${asset}"

  if [[ "$verify" -eq 1 ]]; then
    local sha_url sha_file expected got
    sha_url="${base_url}/${asset}.sha256"
    sha_file="${tmp}/${asset}.sha256"
    download_to "$sha_url" "$sha_file" || die "download failed: ${sha_url}"
    expected="$(awk 'NR==1 {print $1; exit}' "$sha_file")"
    [[ -n "$expected" ]] || die "could not read expected sha256"
    got="$(sha256_file "${tmp}/${asset}")"
    if [[ "$got" != "$expected" ]]; then
      die "sha256 mismatch for ${asset} (expected ${expected}, got ${got})"
    fi
  fi

  mkdir -p "${tmp}/stage"
  tar -xzf "${tmp}/${asset}" -C "${tmp}/stage"

  local src_bin
  src_bin="${tmp}/stage/roboppi"
  [[ -f "$src_bin" ]] || die "archive did not contain roboppi binary"

  if [[ -w "$install_dir" ]]; then
    mkdir -p "$install_dir"
    if need_cmd install; then
      install -m 755 "$src_bin" "${install_dir}/roboppi"
    else
      cp "$src_bin" "${install_dir}/roboppi"
      chmod 755 "${install_dir}/roboppi"
    fi
  else
    if need_cmd sudo; then
      sudo mkdir -p "$install_dir"
      if need_cmd install; then
        sudo install -m 755 "$src_bin" "${install_dir}/roboppi"
      else
        sudo cp "$src_bin" "${install_dir}/roboppi"
        sudo chmod 755 "${install_dir}/roboppi"
      fi
    else
      die "install dir not writable (${install_dir}); set --install-dir or install sudo"
    fi
  fi

  log "roboppi install: installed to ${install_dir}/roboppi"

  if command -v roboppi >/dev/null 2>&1; then
    roboppi --version || true
  elif [[ -x "${install_dir}/roboppi" ]]; then
    "${install_dir}/roboppi" --version || true
    log "roboppi install: ${install_dir} is not on PATH"
  fi
}

main "$@"
