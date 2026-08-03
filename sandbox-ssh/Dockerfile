# Tendril SSH sandbox image. A renter gets a plain SSH shell here — no Jupyter.
# The container dials OUT to a bore server (so no inbound port needs publishing
# on the contributor's host) and the renter connects with the printed host:port.
#
# Build (from the repo root or this dir):
#   docker build -t tendril-ssh-sandbox:latest sandbox-ssh
#
# Python 3 is included so the autonomous buyer's `docker exec python3 -` jobs
# still run against this image.

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
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bore /out/bin/bore /usr/local/bin/bore

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# The renter's Algorand address is injected as the root password at runtime.
ENV SSH_PASSWORD=tendril
ENV BORE_SERVER=bore.pub

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
