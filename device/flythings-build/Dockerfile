# The FlyThings cross toolchain is an x86-64 Linux ELF, so the build runs in an
# amd64 container (emulated on Apple Silicon). Sources/toolchain/packages are
# bind-mounted at run time, not baked in.
FROM --platform=linux/amd64 debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends make findutils libboost-dev \
    && rm -rf /var/lib/apt/lists/*

# base-utility pulls in header-only Boost. Isolate just the boost/ subtree so
# the cross build sees Boost headers without host libc headers leaking in.
RUN mkdir -p /opt/boost && cp -r /usr/include/boost /opt/boost/

WORKDIR /work
