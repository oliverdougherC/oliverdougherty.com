#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ISO="${ROOT_DIR}/assets/utilities/vm/TinyCore-11.0.iso"
OUTPUT_ISO="${ROOT_DIR}/assets/utilities/vm/tinycore-retro-vm.iso"
WORK_DIR="${ROOT_DIR}/.tmp/tinycore-retro-vm-build"
GENERATED_DIR="${WORK_DIR}/generated"
EXTENSIONS_DIR="${WORK_DIR}/tinycore-extensions"
DEFAULT_EXTENSIONS_FILE="${WORK_DIR}/default-extensions.lst"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:3.21}"
TINYCORE_EXTENSION_REPO="${TINYCORE_EXTENSION_REPO:-http://tinycorelinux.net/11.x/x86/tcz}"
RETRO_VM_DEFAULT_EXTENSIONS=(
  "curl.tcz"
  "neofetch.tcz"
)

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required to build the Tiny Core Retro VM ISO" >&2
    exit 1
  fi
}

require_tool docker
require_tool rsvg-convert
require_tool curl

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
  "${GENERATED_DIR}/usr/local/share/pixmaps" \
  "${EXTENSIONS_DIR}"

printf "%s\n" "${RETRO_VM_DEFAULT_EXTENSIONS[@]}" > "${DEFAULT_EXTENSIONS_FILE}"

download_extension_closure() {
  local queue=("$@")
  local seen_file="${WORK_DIR}/downloaded-extensions.lst"
  local extension dep

  : > "${seen_file}"

  while [ "${#queue[@]}" -gt 0 ]; do
    extension="${queue[0]}"
    queue=("${queue[@]:1}")

    if [[ "${extension}" != *.tcz ]]; then
      extension="${extension}.tcz"
    fi

    if grep -qxF "${extension}" "${seen_file}"; then
      continue
    fi
    printf "%s\n" "${extension}" >> "${seen_file}"

    echo "Fetching Tiny Core extension ${extension}"
    curl -fsSLo "${EXTENSIONS_DIR}/${extension}" "${TINYCORE_EXTENSION_REPO}/${extension}"
    curl -fsSLo "${EXTENSIONS_DIR}/${extension}.md5.txt" "${TINYCORE_EXTENSION_REPO}/${extension}.md5.txt"

    if curl -fsLo "${EXTENSIONS_DIR}/${extension}.dep" "${TINYCORE_EXTENSION_REPO}/${extension}.dep"; then
      while IFS= read -r dep; do
        dep="${dep%%#*}"
        dep="${dep#"${dep%%[![:space:]]*}"}"
        dep="${dep%"${dep##*[![:space:]]}"}"
        [ -n "${dep}" ] && queue+=("${dep}")
      done < "${EXTENSIONS_DIR}/${extension}.dep"
    fi
  done
}

download_extension_closure "${RETRO_VM_DEFAULT_EXTENSIONS[@]}"

cp "${ROOT_DIR}/utilities-src/vm-src/tinycore/branding/bliss-wallpaper.png" \
  "${GENERATED_DIR}/opt/backgrounds/retro-vm-wallpaper.png"

# SVG-to-PNG conversion: check source existence before rsvg-convert so errors name the missing file
for _svg_src in \
  "${ROOT_DIR}/utilities-src/vm-src/tinycore/branding/retro-browser.svg" \
  "${ROOT_DIR}/utilities-src/vm-src/tinycore/branding/retro-guide.svg"; do
  if [ ! -f "$_svg_src" ]; then
    echo "Missing SVG source: $_svg_src" >&2
    exit 1
  fi
done

rsvg-convert \
  --format=png \
  --output="${GENERATED_DIR}/usr/local/share/pixmaps/retro-browser.png" \
  "${ROOT_DIR}/utilities-src/vm-src/tinycore/branding/retro-browser.svg"
rsvg-convert \
  --format=png \
  --output="${GENERATED_DIR}/usr/local/share/pixmaps/retro-guide.png" \
  "${ROOT_DIR}/utilities-src/vm-src/tinycore/branding/retro-guide.svg"

docker run --rm \
  --platform linux/amd64 \
  --user 0:0 \
  -v "${ROOT_DIR}:/repo" \
  "${ALPINE_IMAGE}" sh -lc '
    set -euo pipefail
    apk add --no-cache cpio gzip libarchive-tools xorriso >/dev/null

    assert_root_setuid_file() {
      path="$1"
      expected_mode="$2"
      owner="$(stat -c %u "$path")"
      mode="$(stat -c %a "$path")"

      if [ "$owner" != "0" ] || [ "$mode" != "$expected_mode" ]; then
        echo "$path must be owned by root with mode $expected_mode; found uid $owner mode $mode" >&2
        exit 1
      fi
    }

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

    cp -R /repo/utilities-src/vm-src/tinycore/rootfs-overlay/. /tmp/rootfs/
    cp -R /repo/.tmp/tinycore-retro-vm-build/generated/. /tmp/rootfs/

    # Docker Desktop can expose bind-mounted files with the macOS account uid.
    # Tiny Core requires these setuid executables to remain owned by root.
    chown -R 0 /tmp/rootfs
    chmod 755 /tmp/rootfs/usr/local/bin/retro-vm-guide
    chmod 755 /tmp/rootfs/usr/local/bin/retro-vm-browser
    chmod 755 /tmp/rootfs/usr/local/bin/retro-vm-network
    chmod 755 /tmp/rootfs/usr/local/bin/install-firefox
    chmod 755 /tmp/rootfs/opt/bootlocal.sh
    chmod 755 /tmp/rootfs/etc/skel/.setbackground
    chmod 4755 /tmp/rootfs/bin/busybox.suid
    chmod 4111 /tmp/rootfs/usr/bin/sudo
    assert_root_setuid_file /tmp/rootfs/bin/busybox.suid 4755
    assert_root_setuid_file /tmp/rootfs/usr/bin/sudo 4111

    cd /repo/assets/utilities/vm
    md5sum -c flwm_topside.tcz.md5.txt >/dev/null

    cp /repo/assets/utilities/vm/flwm_topside.tcz /tmp/iso/cde/optional/
    cp /repo/assets/utilities/vm/flwm_topside.tcz.md5.txt /tmp/iso/cde/optional/
    find /repo/.tmp/tinycore-retro-vm-build/tinycore-extensions -maxdepth 1 -type f -exec cp {} /tmp/iso/cde/optional/ \;

    cd /tmp/iso/cde/optional
    for md5_file in *.tcz.md5.txt; do
      md5sum -c "$md5_file" >/dev/null
    done

    sed -i "s/^flwm\\.tcz$/flwm_topside.tcz/" /tmp/iso/cde/onboot.lst
    sed -i "s/^flwm\\.tcz$/flwm_topside.tcz/" /tmp/iso/cde/copy2fs.lst
    sed -i "s/^flwm\\.tcz$/flwm_topside.tcz/" /tmp/iso/cde/xbase.lst
    while IFS= read -r extension; do
      [ -n "$extension" ] || continue
      grep -qxF "$extension" /tmp/iso/cde/onboot.lst || printf "%s\n" "$extension" >> /tmp/iso/cde/onboot.lst
    done < /repo/.tmp/tinycore-retro-vm-build/default-extensions.lst

    cd /tmp/rootfs
    find . | cpio -o -H newc --quiet | gzip -2 > /tmp/iso/boot/core.gz

    mkdir /tmp/verify-rootfs
    cd /tmp/verify-rootfs
    gzip -dc /tmp/iso/boot/core.gz | cpio -idmu --quiet
    assert_root_setuid_file /tmp/verify-rootfs/bin/busybox.suid 4755
    assert_root_setuid_file /tmp/verify-rootfs/usr/bin/sudo 4111

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
