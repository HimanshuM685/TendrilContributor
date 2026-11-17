#!/bin/sh
# Two roles in one image. The contributor picks the role by the first argument.
#
#   sandbox (default)  runs as uid 1000 with no capabilities and a read-only
#                      root. With SSH_PUBKEY set it starts an sshd that can log
#                      in only as `tendril`. Exec sandboxes never reach this
#                      script (the contributor overrides the entrypoint).
#
#   guard              runs as root with ONLY CAP_NET_ADMIN, inside the
#                      sandbox's network namespace (--network container:...).
#                      Installs netfilter rules the sandbox cannot remove, then
#                      either exits (rules persist with the namespace) or drops
#                      to uid 1000 with no capabilities and runs the bore client
#                      so the sandbox itself never holds BORE_SECRET.
set -eu

role="${1:-sandbox}"

log() { echo "[entrypoint:$role] $*" >&2; }

# ---------------------------------------------------------------- sandbox ---
sandbox() {
  if [ -z "${SSH_PUBKEY:-}" ]; then
    log "SSH_PUBKEY is not set; nothing to serve"
    exit 64
  fi
  # /work is a tmpfs owned by uid 1000 (mode 0700), so sshd's StrictModes is
  # satisfied. Only the first line of the key is honoured: one key per lease.
  umask 077
  mkdir -p /work/.ssh
  printf '%s\n' "${SSH_PUBKEY}" | head -n 1 > /work/.ssh/authorized_keys
  # Host key is per-sandbox and ephemeral, like the sandbox.
  ssh-keygen -q -t ed25519 -N '' -f /tmp/ssh_host_ed25519_key
  log "starting sshd as $(id -un) (uid $(id -u))"
  exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.tendril -h /tmp/ssh_host_ed25519_key
}

# ------------------------------------------------------------------ guard ---
# Pick an iptables that works on this kernel (nft first, legacy fallback).
pick_iptables() {
  for ipt in iptables-nft iptables-legacy iptables; do
    if command -v "$ipt" >/dev/null 2>&1 && "$ipt" -w -L OUTPUT -n >/dev/null 2>&1; then
      echo "$ipt"
      return 0
    fi
  done
  return 1
}

# Netfilter rules live in the network namespace, not in this process, so they
# outlive the guard and the sandbox (no CAP_NET_ADMIN) cannot change them.
install_rules() {
  IPT=$(pick_iptables) || { log "no working iptables on this kernel"; return 2; }
  log "using $IPT"

  # Egress ------------------------------------------------------------------
  $IPT -w -F OUTPUT
  $IPT -w -A OUTPUT -o lo -j ACCEPT
  $IPT -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # DNS: whatever resolv.conf names (shared with the sandbox). Docker's embedded
  # resolver on user-defined networks is 127.0.0.11, already covered by lo.
  for ns in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf); do
    case "$ns" in *:*) continue ;; esac
    $IPT -w -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
    $IPT -w -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
  done
  # The bore relay, even when self-hosted on a private address.
  if [ -n "${BORE_SERVER:-}" ] && [ -z "${NO_BORE:-}" ]; then
    host="${BORE_SERVER%%:*}"
    ips=$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u) || true
    if [ -z "$ips" ]; then log "cannot resolve BORE_SERVER=$host"; return 2; fi
    for ip in $ips; do $IPT -w -A OUTPUT -d "$ip" -j ACCEPT; done
  fi
  # Everything private, link-local, metadata, multicast, reserved: refused.
  # 172.16/12 includes Docker's own bridges and gateway (= the contributor host).
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 \
             127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4; do
    $IPT -w -A OUTPUT -d "$net" -j REJECT --reject-with icmp-admin-prohibited
  done
  # The public internet (pip, apt mirrors, APIs) stays reachable.
  $IPT -w -P OUTPUT ACCEPT

  # Ingress -----------------------------------------------------------------
  $IPT -w -F INPUT
  $IPT -w -A INPUT -i lo -j ACCEPT
  $IPT -w -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  $IPT -w -A INPUT -p tcp --dport 22 -j ACCEPT
  $IPT -w -P INPUT DROP

  # IPv6: same policy when the namespace has it. Docker disables v6 by default.
  if [ -f /proc/net/if_inet6 ] && [ -s /proc/net/if_inet6 ]; then
    IP6T=$(echo "$IPT" | sed 's/^iptables/ip6tables/')
    if ! command -v "$IP6T" >/dev/null 2>&1 || ! "$IP6T" -w -L OUTPUT -n >/dev/null 2>&1; then
      log "IPv6 present but $IP6T unusable"; return 2
    fi
    $IP6T -w -F OUTPUT
    $IP6T -w -A OUTPUT -o lo -j ACCEPT
    $IP6T -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    for ns in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf); do
      case "$ns" in *:*) ;; *) continue ;; esac
      $IP6T -w -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
      $IP6T -w -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
    done
    if [ -n "${BORE_SERVER:-}" ] && [ -z "${NO_BORE:-}" ]; then
      for ip in $(getent ahostsv6 "${BORE_SERVER%%:*}" 2>/dev/null | awk '{print $1}' | sort -u); do
        $IP6T -w -A OUTPUT -d "$ip" -j ACCEPT
      done
    fi
    for net in fc00::/7 fe80::/10 ::1/128 ff00::/8; do
      $IP6T -w -A OUTPUT -d "$net" -j REJECT
    done
    $IP6T -w -P OUTPUT ACCEPT
    $IP6T -w -F INPUT
    $IP6T -w -A INPUT -i lo -j ACCEPT
    $IP6T -w -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    $IP6T -w -A INPUT -p tcp --dport 22 -j ACCEPT
    $IP6T -w -P INPUT DROP
  fi
  log "netfilter rules installed"
}

guard() {
  if [ "${SANDBOX_NET_GUARD:-on}" = "off" ]; then
    log "WARNING: SANDBOX_NET_GUARD=off — sandbox can reach this host's LAN"
  else
    install_rules || exit $?
  fi
  if [ -n "${NO_BORE:-}" ] || [ -z "${BORE_SERVER:-}" ]; then
    # Nothing long-lived to run; the rules stay with the namespace.
    exit 0
  fi
  # bore needs no privileges: shed root and every capability before running it.
  # BORE_SECRET stays in this process's environment, in a PID namespace the
  # renter cannot see.
  log "starting bore to ${BORE_SERVER} as uid 1000"
  # setresuid to a non-root uid clears the effective and permitted sets; with
  # no-new-privileges set on the container nothing can hand them back.
  exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all \
    bore local 22 --to "${BORE_SERVER}"
}

case "$role" in
  sandbox) sandbox ;;
  guard) guard ;;
  *) log "unknown role: $role"; exit 64 ;;
esac
