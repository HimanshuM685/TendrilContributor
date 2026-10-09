# Tendril contributor agent (Linux hosts only).
#   docker build -t tendril-contributor .
#
# Runtime picks itself (TENDRIL_RUNTIME=auto|docker|firecracker):
#   firecracker  each lease boots a jailed Firecracker microVM from the sandbox
#                image; needs /dev/kvm, a guest kernel and the privileged
#                settings in docker-compose.yml.
#   docker       legacy sibling containers on the mounted host daemon.
# Either way SSH leaves through a per-lease relay tunnel the guest dials OUT to,
# so the agent opens no inbound ports. Use `docker compose up -d`.
FROM node:20-slim

WORKDIR /app

# docker CLI only (talks to the mounted host daemon to build/export the sandbox
# image). Debian's `docker.io` client is too old for modern daemons ("minimum
# supported API is 1.44"), so install the official static client.
# The rest is what the Firecracker driver shells out to (select.ts preflight).
ARG DOCKER_CLI_VERSION=27.3.1
ARG FIRECRACKER_VERSION=v1.12.1
ARG FIRECRACKER_SHA256_X86_64=0a75e67ef6e4c540a2cf248b06822b0be9820cbba9fe19f9e0321200fe76ff6b
ARG FIRECRACKER_SHA256_AARCH64=785bc9d30756bff0c03fb275baac957363f9ba98f78a2272405dcb6929ebb953
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openssh-client \
       iproute2 iptables e2fsprogs binutils file util-linux python3 \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(uname -m)" \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
         | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
    && fc="firecracker-${FIRECRACKER_VERSION}-${arch}.tgz" \
    && curl -fsSLo "/tmp/${fc}" "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/${fc}" \
    && case "$arch" in x86_64) sum="$FIRECRACKER_SHA256_X86_64" ;; aarch64) sum="$FIRECRACKER_SHA256_AARCH64" ;; *) exit 1 ;; esac \
    && echo "${sum}  /tmp/${fc}" | sha256sum -c - \
    && tar -xzf "/tmp/${fc}" -C /tmp \
    && install -m 0755 "/tmp/release-${FIRECRACKER_VERSION}-${arch}/firecracker-${FIRECRACKER_VERSION}-${arch}" /usr/local/bin/firecracker \
    && install -m 0755 "/tmp/release-${FIRECRACKER_VERSION}-${arch}/jailer-${FIRECRACKER_VERSION}-${arch}" /usr/local/bin/jailer \
    && rm -rf /tmp/firecracker-* /tmp/release-*
ENV FIRECRACKER_BIN=/usr/local/bin/firecracker JAILER_BIN=/usr/local/bin/jailer

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src src
# The sandbox image (microVM rootfs source) is built from this context on the
# HOST daemon at startup (Firecracker) or first rent (legacy Docker).
COPY sandbox-ssh sandbox-ssh
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
