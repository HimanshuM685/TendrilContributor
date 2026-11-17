# Tendril sandbox image. One image, two roles, chosen by the entrypoint's first
# argument (see entrypoint.sh):
#
#   sandbox  what the renter gets. Runs as the unprivileged `tendril` user with
#            every Linux capability dropped and a read-only root filesystem.
#            Interactive rentals get an sshd that can only log in that user;
#            notebook jobs get a private IPython kernel (no Jupyter web server).
#   guard    a per-lease sidecar that shares the sandbox's network namespace,
#            installs the netfilter rules that keep the renter off the
#            contributor's LAN, then (bore mode) dials OUT to the bore relay so
#            no inbound port is published on the contributor's host. It is the
#            only container that ever sees BORE_SECRET.
#
# Build (from the repo root or this dir):
#   docker build -t tendril-ssh-sandbox:latest sandbox-ssh

# bore ships prebuilt binaries only for x86_64-linux + macOS — there is NO
# aarch64-linux release. Contributors on ARM boxes (Ampere/Graviton, Apple
# Silicon via Docker) got an x86_64 binary that couldn't exec ("container exited
# before bore came up"). So build bore from source for whatever arch we're on —
# a throwaway rust stage keeps the toolchain out of the final image.
FROM rust:1-slim AS bore
ARG BORE_VERSION=0.5.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install bore-cli --version ${BORE_VERSION} --locked --root /out

FROM python:3.12-slim
# iptables is for the guard role only; the sandbox role has no CAP_NET_ADMIN,
# so the binary being present is harmless there.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server ca-certificates iptables \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir nbclient nbformat ipykernel numpy pandas matplotlib requests scipy scikit-learn pillow psutil \
    && python3 -c "import nbclient, nbformat, ipykernel, numpy, pandas, matplotlib, requests, scipy, sklearn, PIL, psutil"
COPY --from=bore /out/bin/bore /usr/local/bin/bore

# The renter's identity. uid 1000 is also what the contributor passes as
# `--user`, so a container escape lands as an unprivileged host uid, not root.
# `tty` membership lets a non-root sshd hand a pty to the login user.
RUN useradd --uid 1000 --user-group --no-create-home --home-dir /work --shell /bin/bash tendril \
    && usermod -aG tty tendril

# sshd configuration for the sandbox role. Root-owned on a read-only image, so
# the renter cannot loosen it. sshd runs as `tendril` itself (no root in the
# container at all), which OpenSSH supports: it then only authenticates that
# same user. Host key and authorized_keys live on the bounded tmpfs mounts.
RUN printf '%s\n' \
    'Port 22' \
    'PidFile none' \
    'UsePAM no' \
    'PermitRootLogin no' \
    'AllowUsers tendril' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'PubkeyAuthentication yes' \
    'AuthorizedKeysFile /work/.ssh/authorized_keys' \
    'X11Forwarding no' \
    'AllowAgentForwarding no' \
    'PermitTunnel no' \
    'ClientAliveInterval 60' \
    'ClientAliveCountMax 3' \
    'LogLevel VERBOSE' \
    > /etc/ssh/sshd_config.tendril \
    && chmod 644 /etc/ssh/sshd_config.tendril

COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh


# Fail image/runtime readiness when a critical notebook dependency is absent.
# The contributor also runs this probe before advertising each exec sandbox.
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import nbclient, nbformat, ipykernel, numpy, pandas, matplotlib, requests, scipy, sklearn, PIL, psutil"

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
CMD ["sandbox"]
