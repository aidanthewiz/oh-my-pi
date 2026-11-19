#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  echo "Usage: $0 <package>..." >&2
  exit 64
fi

# shellcheck source=/dev/null
. /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 ]]; then
  echo "CI package setup requires Ubuntu 24.04" >&2
  exit 1
fi

case "$(dpkg --print-architecture)" in
  amd64)
    archive=https://archive.ubuntu.com/ubuntu
    security=https://security.ubuntu.com/ubuntu
    ;;
  arm64)
    archive=https://ports.ubuntu.com/ubuntu-ports
    security=$archive
    ;;
  *)
    echo "Unsupported CI package architecture" >&2
    exit 1
    ;;
esac

sources="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-ubuntu.XXXXXX.sources")"
trap 'rm -f -- "$sources"' EXIT
cat > "$sources" <<EOF
Types: deb
URIs: $archive
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: $security
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

options=(
  -o "Dir::Etc::sourcelist=$sources"
  -o "Dir::Etc::sourceparts=-"
  -o "Acquire::http::Timeout=30"
  -o "Acquire::https::Timeout=30"
  -o "Acquire::Retries=2"
  -o "APT::Update::Error-Mode=any"
)
sudo timeout --kill-after=10s 5m apt-get "${options[@]}" update
sudo timeout --kill-after=10s 5m apt-get "${options[@]}" install --yes --no-install-recommends -- "$@"
