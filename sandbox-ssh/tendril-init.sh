#!/bin/sh
# PID 1 in the guest. All mounts are guest virtual filesystems.
set -eu
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t tmpfs tmpfs /run
mkdir -p /dev/pts /run/sshd
mount -t devpts devpts /dev/pts
exec /usr/local/bin/tendril-guest
