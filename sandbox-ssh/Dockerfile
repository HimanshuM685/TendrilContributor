# OCI userspace for Firecracker (SSH, Jupyter, Python/notebook runner), also usable
# by the legacy Docker driver. Public access dials out through per-lease TLS/bore.
#
# Build (from the repo root or this dir):
#   docker build -t tendril-ssh-sandbox:latest sandbox-ssh
#
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
    && apt-get install -y --no-install-recommends openssh-server ca-certificates iproute2 util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir jupyterlab==4.3.6 papermill==2.6.0 nbconvert==7.16.6 ipykernel==6.29.5 \
        numpy pandas matplotlib requests \
    && python -m ipykernel install --sys-prefix \
    && mkdir -p /work/jobs /etc/tendril /proc /sys /dev /run
COPY --from=bore /out/bin/bore /usr/local/bin/bore

COPY entrypoint.sh /entrypoint.sh
COPY tendril-init.sh /tendril-init.sh
COPY guest.py /usr/local/bin/tendril-guest
COPY job.py /usr/local/bin/tendril-job
COPY tls_bridge.py /usr/local/bin/tls_bridge.py
COPY tunnel.py /usr/local/bin/tendril-tunnel
RUN chmod +x /entrypoint.sh
RUN chmod +x /tendril-init.sh /usr/local/bin/tendril-guest /usr/local/bin/tendril-job /usr/local/bin/tendril-tunnel \
    && rm -f /etc/ssh/ssh_host_* /etc/machine-id

# The renter's Algorand address is injected as the root password at runtime.
ENV BORE_SERVER=bore.pub

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
