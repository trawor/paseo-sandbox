# Changelog

## 0.4.0-fork.1 (fork of 0.3.0)

### Features

* Per-project runtime image: `.paseo/sandbox.json` (dockerfile, context, buildArgs, env, image, extends), then `.paseo.Dockerfile`, then a host default (`plugin-data/sandbox/config.json` or `PASEO_SANDBOX_*` variables), then the built-in image. Project Dockerfiles extend the built-in image through `BASE_IMAGE`.
* Content-addressed project image tags; an edited Dockerfile recreates the sandbox on the next start and keeps `/home/paseo`.
* Runtime-contract check for non-built-in images, with the missing pieces in the error.
* `sandbox.start` accepts `rebuild`, and the Sandboxes screen has a Rebuild image action.
* `projectDockerfile: off` / `PASEO_SANDBOX_PROJECT_DOCKERFILE=off` switch.

## [0.3.0](https://github.com/omercnet/paseo-plugins/compare/sandbox-v0.2.1...sandbox-v0.3.0) (2026-10-28)


### Features

* add listing icon to plugin manifests ([#418](https://github.com/omercnet/paseo-plugins/issues/418)) ([2e7aadd](https://github.com/omercnet/paseo-plugins/commit/2e7aaddac381bb2a5c596f95b1f9b7b8aee89cb2))

## [0.2.1](https://github.com/omercnet/paseo-plugins/compare/sandbox-v0.2.0...sandbox-v0.2.1) (2026-10-27)


### Bug Fixes

* **deps:** support Paseo 0.14.0-beta.1 ([0f019e0](https://github.com/omercnet/paseo-plugins/commit/0f019e054992660f589c14894c4382d51325dc31))

## [0.2.0](https://github.com/omercnet/paseo-plugins/compare/sandbox-v0.1.0...sandbox-v0.2.0) (2026-10-24)


### Features

* **sandbox:** share the host's Claude, Codex, OpenCode and GitHub logins ([#400](https://github.com/omercnet/paseo-plugins/issues/400)) ([732d7b8](https://github.com/omercnet/paseo-plugins/commit/732d7b8febd531291afd3ffdb3ceca01bd6afacd))
* **sandbox:** ship OMP in the runtime image and share the host's OMP login ([#402](https://github.com/omercnet/paseo-plugins/issues/402)) ([25affdb](https://github.com/omercnet/paseo-plugins/commit/25affdb5ca33206c8cf0477d2588c3c8ef60fe71))

## 0.1.0 (2026-10-24)


### Features

* **sandbox:** run project workspaces and agents in Docker sandboxes ([#395](https://github.com/omercnet/paseo-plugins/issues/395)) ([af77e50](https://github.com/omercnet/paseo-plugins/commit/af77e50ee3fbe1ac2ae20d8b70b1584e025ee461))
