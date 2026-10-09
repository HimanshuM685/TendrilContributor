#!/bin/sh
# Build the pinned Firecracker guest kernel on a Linux machine.
#   sudo KERNEL_OUTPUT=/opt/tendril-kernel/vmlinux sh scripts/build-kernel.sh
# KERNEL_SOURCE / FIRECRACKER_SOURCE default to shallow clones under BUILD_DIR.
set -eu
: "${KERNEL_OUTPUT:?absolute output path required}"
test "$(uname -s)" = Linux
BUILD_DIR=${BUILD_DIR:-/opt/build}
KERNEL_SOURCE=${KERNEL_SOURCE:-$BUILD_DIR/linux}
FIRECRACKER_SOURCE=${FIRECRACKER_SOURCE:-$BUILD_DIR/firecracker}
[ -d "$KERNEL_SOURCE/.git" ] || git clone --depth 1 --branch v6.1.128 https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git "$KERNEL_SOURCE"
[ -d "$FIRECRACKER_SOURCE/.git" ] || git clone --depth 1 --branch v1.12.1 https://github.com/firecracker-microvm/firecracker.git "$FIRECRACKER_SOURCE"
test "$(git -C "$KERNEL_SOURCE" describe --tags --exact-match)" = v6.1.128
test "$(git -C "$FIRECRACKER_SOURCE" describe --tags --exact-match)" = v1.12.1
arch=$(uname -m)
case "$arch" in x86_64|aarch64) ;; *) exit 1 ;; esac
config="$FIRECRACKER_SOURCE/resources/guest_configs/microvm-kernel-ci-$arch-6.1.config"
cp "$config" "$KERNEL_SOURCE/.config"
"$KERNEL_SOURCE/scripts/config" --file "$KERNEL_SOURCE/.config" --disable LOCALVERSION_AUTO --set-str LOCALVERSION ""
make -C "$KERNEL_SOURCE" LOCALVERSION=-tendril olddefconfig
mkdir -p "$(dirname "$KERNEL_OUTPUT")"
case "$arch" in
  x86_64)
    make -C "$KERNEL_SOURCE" -j"$(nproc)" LOCALVERSION=-tendril vmlinux
    objcopy --strip-debug "$KERNEL_SOURCE/vmlinux" "$KERNEL_OUTPUT"
    ;;
  aarch64)
    make -C "$KERNEL_SOURCE" -j"$(nproc)" LOCALVERSION=-tendril Image
    cp "$KERNEL_SOURCE/arch/arm64/boot/Image" "$KERNEL_OUTPUT"
    ;;
esac
chmod 0400 "$KERNEL_OUTPUT"
sha256sum "$KERNEL_OUTPUT"
