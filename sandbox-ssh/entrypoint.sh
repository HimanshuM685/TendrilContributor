#!/bin/sh
# Configure root SSH login, start sshd, then expose port 22 through a bore
# tunnel. bore prints "listening at <server>:<port>" to stdout — the contributor
# reads that from `docker logs` to learn the endpoint.
set -e

: "${BORE_SERVER:=bore.pub}"

mkdir -p /run/sshd
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config

# Neither set: the Docker image default. A microVM passes both so the agent
# can exec over the tap while the renter still uses a password.
if [ -z "${SSH_PUBKEY}" ] && [ -z "${SSH_PASSWORD}" ]; then
  SSH_PASSWORD=tendril
fi

if [ -n "${SSH_PUBKEY}" ]; then
  mkdir -p /root/.ssh
  printf '%s\n' "${SSH_PUBKEY}" > /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
fi

if [ -n "${SSH_PASSWORD}" ]; then
  echo "root:${SSH_PASSWORD}" | chpasswd
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
else
  passwd -l root >/dev/null 2>&1 || true
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
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
if [ -n "${TENDRIL_RELAY_JSON:-}" ]; then
  exec /usr/local/bin/tendril-tunnel
fi
exec bore local 22 --to "${BORE_SERVER}"
