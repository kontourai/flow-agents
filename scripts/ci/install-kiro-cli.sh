#!/usr/bin/env bash
# Install an exact, integrity-verified kiro-cli release for the PR review
# composite. This script deliberately never fetches "latest": the version and
# the SHA-256 of every supported artifact are pinned here in reviewed source,
# because the CLI runs with a review credential in its environment. If the
# checksum, layout, or reported version does not match, the install fails
# closed and the composite records NOT_VERIFIED instead of reviewing.
#
# Distribution channel: the official Kiro CLI download origin used by
# https://cli.kiro.dev/install (BASE_URL https://prod.download.cli.kiro.dev),
# which serves versioned artifacts at <channel>/<version>/<file> with SHA-256
# checksums published in the channel manifest. The checksums below were read
# from https://prod.download.cli.kiro.dev/stable/latest/manifest.json at pin
# time and independently re-verified against the downloaded artifact.
set -euo pipefail

KIRO_CLI_VERSION="2.20.2"
BASE_URL="https://prod.download.cli.kiro.dev/stable"

os="$(uname -s)"
arch="$(uname -m)"
if [[ "$os" != "Linux" ]]; then
  echo "install-kiro-cli: unsupported OS $os; only pinned Linux builds are supported" >&2
  exit 1
fi
case "$arch" in
  x86_64)
    filename="kirocli-x86_64-linux.tar.zst"
    expected_sha256="5328e08974cfdd9429b55dd673a46307300a2dc96fc0d4e31d0d1593129ac15b"
    ;;
  aarch64)
    filename="kirocli-aarch64-linux.tar.zst"
    expected_sha256="de8028968d95b794cf07ebaf5d7b8e359b6f169dff2152b96cd7b55033360935"
    ;;
  *)
    echo "install-kiro-cli: unsupported architecture $arch; only pinned x86_64/aarch64 builds are supported" >&2
    exit 1
    ;;
esac

workdir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/kiro-cli-install-XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

archive="$workdir/$filename"
curl --proto '=https' --tlsv1.2 -fsSL "$BASE_URL/$KIRO_CLI_VERSION/$filename" -o "$archive"

actual_sha256="$(sha256sum "$archive" | cut -d' ' -f1)"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "install-kiro-cli: checksum mismatch for $filename (expected $expected_sha256, got $actual_sha256); refusing to install" >&2
  exit 1
fi

tar --zstd -xf "$archive" -C "$workdir"
installer="$workdir/kirocli/install.sh"
if [[ ! -f "$installer" ]]; then
  echo "install-kiro-cli: archive layout unexpected; kirocli/install.sh is missing" >&2
  exit 1
fi
# KIRO_CLI_SKIP_SETUP skips the installer's post-install "kiro-cli setup" call
# (shell/dotfile integration), which CI neither needs nor should mutate. The
# composite invokes the binary by absolute path.
KIRO_CLI_SKIP_SETUP=1 bash "$installer"

binary="$HOME/.local/bin/kiro-cli"
if [[ ! -x "$binary" ]]; then
  echo "install-kiro-cli: $binary is missing after install" >&2
  exit 1
fi
reported_version="$("$binary" --version)"
if [[ "$reported_version" != "kiro-cli $KIRO_CLI_VERSION" ]]; then
  echo "install-kiro-cli: installed binary reports '$reported_version', expected 'kiro-cli $KIRO_CLI_VERSION'" >&2
  exit 1
fi

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$HOME/.local/bin" >> "$GITHUB_PATH"
fi
echo "Installed pinned kiro-cli $KIRO_CLI_VERSION for $arch with verified checksum."
