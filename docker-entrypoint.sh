#!/bin/sh
# Container PID 1 wrapper (Linux hosts only).
#
# Firecracker mode nests the agent one cgroup down so every jailed VMM lands in
# THIS container's cgroup tree (cgroup v2 forbids processes in a cgroup whose
# children use controllers). `docker compose stop/down/kill` and crashes then
# take every microVM with them; nothing outlives the container.
set -eu
[ "$(uname -s)" = Linux ] || { echo "[entrypoint] Linux host required" >&2; exit 1; }
if [ "${TENDRIL_RUNTIME:-auto}" != docker ] && [ -c /dev/kvm ] && [ -w /sys/fs/cgroup/cgroup.subtree_control ]; then
  mkdir -p /sys/fs/cgroup/agent
  for pid in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$pid" > /sys/fs/cgroup/agent/cgroup.procs 2>/dev/null || true; done
  echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control
  export TENDRIL_CGROUP_PARENT="${TENDRIL_CGROUP_PARENT:-vms}"
  # Lease NAT/forward rules must land in the same iptables backend Docker uses.
  if iptables-legacy -w -S DOCKER-USER >/dev/null 2>&1; then update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null; fi
fi
exec "$@"
