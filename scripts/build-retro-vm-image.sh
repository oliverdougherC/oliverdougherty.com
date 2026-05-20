#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ISO="${ROOT_DIR}/assets/utilities/vm/TinyCore-11.0.iso"
OUTPUT_ISO="${ROOT_DIR}/assets/utilities/vm/tinycore-retro-vm.iso"
WORK_DIR="${ROOT_DIR}/.tmp/tinycore-retro-vm-build"
GENERATED_DIR="${WORK_DIR}/generated"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:3.21}"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required to build the Tiny Core Retro VM ISO" >&2
    exit 1
  fi
}

require_tool docker
require_tool rsvg-convert

if [ ! -f "${SOURCE_ISO}" ]; then
  echo "Missing Tiny Core base ISO: ${SOURCE_ISO}" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is installed but the daemon is not available" >&2
  exit 1
fi

rm -rf "${WORK_DIR}"
mkdir -p \
  "${GENERATED_DIR}/opt/backgrounds" \
  "${GENERATED_DIR}/usr/local/share/pixmaps"

cp "${ROOT_DIR}/vm-src/tinycore/branding/bliss-wallpaper.png" \
  "${GENERATED_DIR}/opt/backgrounds/retro-vm-wallpaper.png"

# SVG-to-PNG conversion: check source existence before rsvg-convert so errors name the missing file
for _svg_src in \
  "${ROOT_DIR}/vm-src/tinycore/branding/retro-browser.svg" \
  "${ROOT_DIR}/vm-src/tinycore/branding/retro-guide.svg"; do
  if [ ! -f "$_svg_src" ]; then
    echo "Missing SVG source: $_svg_src" >&2
    exit 1
  fi
done

rsvg-convert \
  --format=png \
  --output="${GENERATED_DIR}/usr/local/share/pixmaps/retro-browser.png" \
  "${ROOT_DIR}/vm-src/tinycore/branding/retro-browser.svg"
rsvg-convert \
  --format=png \
  --output="${GENERATED_DIR}/usr/local/share/pixmaps/retro-guide.png" \
  "${ROOT_DIR}/vm-src/tinycore/branding/retro-guide.svg"

docker run --rm \
  --platform linux/amd64 \
  -v "${ROOT_DIR}:/repo" \
  "${ALPINE_IMAGE}" sh -lc '
    set -euo pipefail
    apk add --no-cache cpio gzip libarchive-tools xorriso >/dev/null

    mkdir -p /tmp/iso /tmp/rootfs
    bsdtar -xf /repo/assets/utilities/vm/TinyCore-11.0.iso -C /tmp/iso

    cd /tmp/rootfs
    set +e
    gzip -dc /tmp/iso/boot/core.gz | cpio -idmu --quiet
    cpio_status=$?
    set -e
    if [ "$cpio_status" -ge 2 ]; then
      exit "$cpio_status"
    fi
    if [ "$cpio_status" -eq 1 ]; then
      echo "WARNING: cpio exited with status 1 — some files were not extracted" >&2
      exit 1
    fi

    cp -R /repo/vm-src/tinycore/rootfs-overlay/. /tmp/rootfs/
    cp -R /repo/.tmp/tinycore-retro-vm-build/generated/. /tmp/rootfs/

    chmod 755 /tmp/rootfs/usr/local/bin/retro-vm-guide
    chmod 755 /tmp/rootfs/usr/local/bin/retro-vm-browser
    chmod 755 /tmp/rootfs/etc/skel/.setbackground

    cd /repo/assets/utilities/vm
    md5sum -c flwm_topside.tcz.md5.txt >/dev/null

    cp /repo/assets/utilities/vm/flwm_topside.tcz /tmp/iso/cde/optional/
    cp /repo/assets/utilities/vm/flwm_topside.tcz.md5.txt /tmp/iso/cde/optional/

    sed -i "s/^flwm\\.tcz$/flwm_topside.tcz/" /tmp/iso/cde/onboot.lst
    sed -i "s/^flwm\\.tcz$/flwm_topside.tcz/" /tmp/iso/cde/copy2fs.lst
    sed -i "s/^flwm\\.tcz$/flwm_topside.tcz/" /tmp/iso/cde/xbase.lst

    cd /tmp/rootfs
    find . | cpio -o -H newc --quiet | gzip -2 > /tmp/iso/boot/core.gz

    cd /tmp/iso
    xorriso -as mkisofs \
      -l -J -R -V TC-RETRO \
      -no-emul-boot \
      -boot-load-size 4 \
      -boot-info-table \
      -b boot/isolinux/isolinux.bin \
      -c boot/isolinux/boot.cat \
      -o /repo/assets/utilities/vm/tinycore-retro-vm.iso .
  '

if [ ! -f "${OUTPUT_ISO}" ]; then
  echo "Tiny Core remaster build failed to produce ${OUTPUT_ISO}" >&2
  exit 1
fi

# Validate output ISO is not empty or truncated (Tiny Core ISOs are ~10 MB minimum)
_iso_size=$(stat -c%s "${OUTPUT_ISO}" 2>/dev/null || stat -f%z "${OUTPUT_ISO}" 2>/dev/null || echo 0)
if [ "$_iso_size" -lt 1048576 ]; then
  echo "Tiny Core remaster ISO is suspiciously small (${_iso_size} bytes) — build may have failed" >&2
  exit 1
fi

echo "Wrote ${OUTPUT_ISO}"
