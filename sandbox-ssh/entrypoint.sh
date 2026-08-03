#!/bin/sh
# Configure root SSH login, start sshd, then expose port 22 through a bore
# tunnel. bore prints "listening at <server>:<port>" to stdout — the contributor
# reads that from `docker logs` to learn the endpoint.
set -e

: "${BORE_SERVER:=bore.pub}"

mkdir -p /run/sshd
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config

if [ -n "${SSH_PUBKEY}" ]; then
  # Key auth: the renter brought their own key, so no password exists at all.
  # This is the only mode available to a caller with no session — there is no
  # wallet address to use as a password.
  mkdir -p /root/.ssh
  printf '%s\n' "${SSH_PUBKEY}" > /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  passwd -l root >/dev/null 2>&1 || true
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
else
  # Password auth: the renter's own address is the password.
  : "${SSH_PASSWORD:=tendril}"
  echo "root:${SSH_PASSWORD}" | chpasswd
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
fi

ssh-keygen -A >/dev/null 2>&1

# sshd kept attached (-D) and logging to stderr (-e) so any errors (e.g. a
# privsep chroot failure) show up in `docker logs`. Backgrounded so bore can be
# the foreground process.
/usr/sbin/sshd -D -e &

# Local mode (NO_BORE): the contributor publishes port 22 to the host directly,
# so skip bore and just keep the container alive.
if [ -n "${NO_BORE}" ]; then
  exec tail -f /dev/null
fi

# bore in the foreground (PID 1) so the container's lifetime tracks the tunnel.
exec bore local 22 --to "${BORE_SERVER}"
