# Squeak Voice: the gateway (node) and baresip, built from the same release Squeak was tested against.
FROM node:22-bookworm-slim AS baresip
ARG BARESIP_VERSION=4.12.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates libssl-dev zlib1g-dev pkg-config \
 && git clone --depth 1 --branch "v${BARESIP_VERSION}" https://github.com/baresip/re.git \
 && cmake -S re -B re/build -DCMAKE_BUILD_TYPE=Release && cmake --build re/build -j2 && cmake --install re/build \
 && git clone --depth 1 --branch "v${BARESIP_VERSION}" https://github.com/baresip/baresip.git \
 && cmake -S baresip -B baresip/build -DCMAKE_BUILD_TYPE=Release -DSTATIC=OFF \
      -DMODULES="account;aufile;ctrl_tcp;g711;menu" \
 && cmake --build baresip/build -j2 && cmake --install baresip/build

FROM node:22-bookworm-slim
ARG TARGETARCH
ARG PIPER_VERSION=2023.11.14-2
RUN apt-get update && apt-get install -y --no-install-recommends \
      libssl3 zlib1g espeak-ng ffmpeg ca-certificates curl \
 && case "$TARGETARCH" in amd64) PIPER_ARCH=x86_64 ;; arm64) PIPER_ARCH=aarch64 ;; *) echo "no piper for $TARGETARCH" >&2; exit 1 ;; esac \
 && curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PIPER_ARCH}.tar.gz" | tar -xz -C /opt \
 && mkdir -p /opt/piper-voices \
 && curl -fsSL -o /opt/piper-voices/en_US-lessac-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" \
 && curl -fsSL -o /opt/piper-voices/en_US-lessac-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json" \
 && rm -rf /var/lib/apt/lists/*
COPY --from=baresip /usr/local /usr/local
RUN ldconfig
WORKDIR /app
COPY gateway.mjs run.sh config.yaml ./
ENV SQUEAK_PIPER_BIN=/opt/piper/piper \
    SQUEAK_PIPER_MODEL=/opt/piper-voices/en_US-lessac-medium.onnx \
    SQUEAK_VOICE_BARESIP=/usr/local/bin/baresip \
    SQUEAK_VOICE_BARESIP_MODULES=/usr/local/lib/baresip/modules
CMD ["/app/run.sh"]
