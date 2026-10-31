# Built with the `docker` folder as context (see .paseo/sandbox.json), so COPY can use its files.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG NODE_TOOLS
USER root
# HOME points at /home/paseo in the base image. Install as root with HOME=/root, or root-owned
# files end up in the sandbox user's home volume and agents cannot write their own state.
RUN export HOME=/root \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh ripgrep python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --no-audit --no-fund ${NODE_TOOLS} \
 && npm cache clean --force \
 && rm -rf /root/.npm /root/.cache
COPY bootstrap.sh /usr/local/bin/project-bootstrap
