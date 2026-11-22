#!/bin/sh
# Copy only public host packages into an isolated temporary test module.
set -eu
: "${MOEJS_HOST_DIR:?Set MOEJS_HOST_DIR to a read-only MB checkout}"
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_tmp=$(mktemp -d "${TMPDIR:-/tmp}/bilibili-host.XXXXXX")
trap 'rm -rf "$runtime_tmp"' EXIT HUP INT TERM
cp "$MOEJS_HOST_DIR/go.mod" "$MOEJS_HOST_DIR/go.sum" "$runtime_tmp/"
mkdir -p "$runtime_tmp/internal"
for package in plugin music edge i18n local pluginprefs discoveryprefs; do
    cp -R "$MOEJS_HOST_DIR/internal/$package" "$runtime_tmp/internal/$package"
done
cp -R "$plugin_root/test/desktop" "$runtime_tmp/validation"
cd "$runtime_tmp"
BILIBILI_PLUGIN_ROOT="$plugin_root" CGO_ENABLED=0 GOFLAGS=-mod=readonly go test -v ./validation
