#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  echo "Usage: $0 <package>..." >&2
  exit 64
fi

# shellcheck source=/dev/null
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:22.04) suite=jammy ;;
  ubuntu:24.04) suite=noble ;;
  *)
    echo "CI package setup requires Ubuntu 22.04 or 24.04" >&2
    exit 1
    ;;
esac

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
write_sources() {
  cat > "$sources" <<EOF
Types: deb
URIs: $archive
Suites: $suite $suite-updates $suite-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: $security
Suites: $suite-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
}
write_sources

options=(
  -o "Dir::Etc::sourcelist=$sources"
  -o "Dir::Etc::sourceparts=-"
  -o "Acquire::http::Timeout=30"
  -o "Acquire::https::Timeout=30"
  -o "Acquire::Retries=2"
  -o "APT::Update::Error-Mode=any"
)
if sudo timeout --kill-after=10s 5m apt-get "${options[@]}" update; then
  :
else
  update_status=$?
  if [[ "$security" == "$archive" ]]; then
    exit "$update_status"
  fi
  echo "Ubuntu index update failed ($update_status); retrying the signed security pocket through $archive" >&2
  security=$archive
  write_sources
  sudo timeout --kill-after=10s 5m apt-get "${options[@]}" update
fi
sudo timeout --kill-after=10s 5m apt-get "${options[@]}" install --yes --no-install-recommends -- "$@"
