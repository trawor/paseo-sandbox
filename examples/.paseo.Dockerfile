# Example project image for the Paseo Sandbox plugin. Copy it to the root of your repository as
# `.paseo.Dockerfile`. The plugin builds its built-in runtime first and passes that image's tag as
# BASE_IMAGE, so this file only adds what your project needs. Never put secrets in here; saved
# credentials reach the sandbox through its environment at run time.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# The built-in image runs its entrypoint as root and drops to the `paseo` user (uid 1000) itself.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends gh ripgrep python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
