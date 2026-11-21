# cbase — ONE Dockerfile, three stages:
#   base        the ONE package list, the user agent, the login folder — the foundation of both images.
#   projectbox  the image of the project containers `cbase-p-<project>` (one dockerd of its own per project): base plus lsof,
#               iproute2, git-lfs with /etc/gitconfig, compose and buildx plugin, entrypoint and wrapper. Built with
#               `--target projectbox`.
#   backend     the per-user backend (the user container) — the LAST stage: a build without `--target` (build.sh or any
#               other build of this file) keeps building exactly this image.
# Guard: tools/check/projectbox-dockerfile.test.mjs.
#
# Build context is server/backend/build-context/ (staged by build.sh) or any folder staged the same way:
#   electron/               copy of server/backend/electron (server + mcp)
#   headless.js             container entry (startServer)
#   package.json            backend dependencies
#   package-lock.json       their versions (`npm ci`)
#   entry.sh                entry of the user container
#   projectbox-entry.sh     entry of the project container
#   cbase-wrapper           process-group wrapper (perl) for every start in the project container
#   cbase-project           command in the user container: into the project container of a project (backend only)
#   cbase-git               git.path for VS Code in B: repos of converted projects via cbase-project (backend only)
#   cbase-clone             volume clone of a copy in two phases (python3; backend only)
#   cbase-manifest          the manifest per entry for the check of the relocation (backend only, /usr/local/bin)
#   cbase-lfs-access        git credential helper for Git LFS in the agent shells (backend only, /usr/local/bin — the
#                           projectbox names it only in /etc/gitconfig)
FROM node:22-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive
# git/ripgrep/compilers: basic equipment for coding agents in the container;
# python3/make/g++ are also needed by node-pty (node-gyp) at npm install.
# docker.io brings dockerd and tini (/usr/bin/tini, a dependency) — both images carry the same list.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl procps openssh-client \
      python3 make g++ ripgrep nano less ffmpeg \
      docker.io iptables util-linux \
      chromium fonts-liberation fonts-noto-color-emoji \
      fonts-inter fonts-noto-core fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*
# Fonts of the agent browser: with only Liberation, `sans-serif` pointed at Liberation MONO, and system-ui/-apple-system/Segoe UI
# fell back to it — pages looked like a typewriter. Now Inter for the system fonts and sans-serif, Noto Serif, DejaVu Sans Mono.
# Arial/Times stay with Liberation (same metrics). Measured with fc-match in node:22-bookworm-slim. Applies to B AND the project
# container (both from base).
RUN printf '%s\n' \
      '<?xml version="1.0"?>' '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' '<fontconfig>' \
      '<alias binding="strong"><family>sans-serif</family><prefer><family>Inter</family><family>Noto Sans</family><family>DejaVu Sans</family></prefer></alias>' \
      '<alias binding="strong"><family>serif</family><prefer><family>Noto Serif</family><family>DejaVu Serif</family></prefer></alias>' \
      '<alias binding="strong"><family>monospace</family><prefer><family>DejaVu Sans Mono</family><family>Liberation Mono</family></prefer></alias>' \
      '<alias binding="strong"><family>system-ui</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="strong"><family>-apple-system</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="strong"><family>BlinkMacSystemFont</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="strong"><family>Segoe UI</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="strong"><family>SF Pro Text</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="strong"><family>SF Pro Display</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="strong"><family>Helvetica Neue</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="strong"><family>Roboto</family><prefer><family>Inter</family></prefer></alias>' \
      '</fontconfig>' > /etc/fonts/local.conf \
    && fc-cache -f

# Unprivileged user; $HOME is the persistent volume (DB, workspaces, ~/.claude, ~/.codex).
# In the docker group: may talk to the INNER dockerd (sysbox operation or project container).
RUN useradd -m -u 1001 -s /bin/bash agent && usermod -aG docker agent
# Shared login: CLAUDE_SECURESTORAGE_CONFIG_DIR moves `.credentials.json` and all login locks of the Claude CLI into ONE folder
# that every CLI start points at — through the image ENV also terminals, services, `claude doctor`, the VS Code tunnel and every
# `docker exec` (measured on 2.1.280; not in `claude --help`, hence an artifact of the deploy tool's follow-along guard:
# baseline/<pin>/login-directory.json). The move of the file is done by entry.sh. In `base`, so that every `docker exec` into a
# project container points there too.
ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login

# ─────────────────────────────────────────────────────────────────────────────────────────────── projektbox
# The image of the project container. Node, the provider CLIs and go-task come by ro bind from the user container (at the same
# path, one version, one pin); yarn already lies under /opt/yarn-v1.22.22 in the base image. Therefore nothing here under
# /usr/local, no /app, no electron and no global npm install: otherwise every backend deploy would change the id of this image and
# trigger distribution and re-creation in every user container.
FROM base AS projectbox

# lsof (port → process in the project container) and iproute2 (`ip` for the DNAT rules of the entrypoint, `ss` for debugging)
# ONLY here — the user container stays without lsof (otherwise `pidsOnPort` would change there).
RUN apt-get update && apt-get install -y --no-install-recommends lsof iproute2 \
    && rm -rf /var/lib/apt/lists/* && lsof -v 2>&1 | head -2 && ip -V

# Git LFS: ONLY here like lsof: cloning happens only in the project container, B stays without git-lfs. `git lfs install
# --system` installs the filter WITH smudge — `--skip-smudge` would write `--skip` into filter.lfs.process for good, and no
# environment would take it back for the agent shells. Instead `ENV GIT_LFS_SKIP_SMUDGE=1` leaves every process that says
# nothing else at pointers (administration git, terminals, services, VS Code); cbase fetches explicitly with access (`git lfs
# pull`), the agent shells switch smudge back on through their environment. In addition in /etc/gitconfig, fixed and not from
# the environment (lifetime, children, effective only at the next start): the LFS helper and `credential.useHttpPath`. The
# second line is no longer needed by the helper — it recognizes git-lfs by ancestry, the path gate is refuted —; it stays
# because every change here would bring a new projectbox id and the re-creation of every project container (for its effect on
# a storing helper see the head of the helper, "WHERE IT LIVES"). The helper itself does NOT live here, but in the backend image
# under /usr/local/bin (mounted read-only into every project container); without its environment it is silent — every git call
# in the project container asks it. The probes at the end pin the values in the built image (filter without `--skip`, exactly
# this one helper). Guard: tools/check/projectbox-dockerfile.test.mjs; the start probe in every B asks `git lfs version` and the
# helper once more (the deploy tool's projectbox distribution).
RUN apt-get update && apt-get install -y --no-install-recommends git-lfs \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system \
    && git config --system credential.helper /usr/local/bin/cbase-lfs-access \
    && git config --system credential.useHttpPath true \
    && git lfs version \
    && test "$(git config --system --get filter.lfs.process)" = "git-lfs filter-process" \
    && test "$(git config --system --get-all credential.helper)" = /usr/local/bin/cbase-lfs-access \
    && test "$(git config --system --get credential.useHttpPath)" = true
ENV GIT_LFS_SKIP_SMUDGE=1

# Compose and buildx: bookworm ships only the Python v1 `docker-compose` 1.29.2 and no buildx — hence a pinned download from
# the GitHub releases (the same rule as the VS Code CLI below), the versions of the user container, every file checked against
# its sha256 (values measured against the release checksums). Placed in the search path of the docker CLI under /usr/libexec,
# not under /usr/local (the ro bind lies there). Only x86_64 is measured.
ARG COMPOSE_VERSION=v5.3.1
ARG COMPOSE_SHA256=f9ebc6ebdb19d769b793c245a736caaeb198c62587f13b25c660c13b4987f959
ARG BUILDX_VERSION=v0.35.0
ARG BUILDX_SHA256=d41ece72044243b4f58b343441ae37446d9c29a7d6b5e11c61847bbcf8f7dfda
RUN arch="$(uname -m)"; case "$arch" in x86_64) ;; *) echo "no pinned checksum for $arch (only x86_64 is measured)" >&2; exit 1;; esac \
    && mkdir -p /usr/libexec/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" -o /usr/libexec/docker/cli-plugins/docker-compose \
    && echo "${COMPOSE_SHA256}  /usr/libexec/docker/cli-plugins/docker-compose" | sha256sum -c - \
    && curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-amd64" -o /usr/libexec/docker/cli-plugins/docker-buildx \
    && echo "${BUILDX_SHA256}  /usr/libexec/docker/cli-plugins/docker-buildx" | sha256sum -c - \
    && chmod 755 /usr/libexec/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-buildx \
    && docker compose version && docker buildx version

# The overlay stage of the entrypoint (step 3a; dormant as long as there is no copy) mounts with `mount -t overlay … -o
# userxattr,…`, and under sysbox that works only via mount(2), not via the new mount API (fsopen is refused). util-linux 2.38.1
# (bookworm) takes mount(2) anyway; the variable guards against a jump to ≥ 2.39. Only here, not in base: the user container
# mounts no overlays.
ENV LIBMOUNT_FORCE_MOUNT2=always

# VS Code "attach": the VS Code pill opens main and copies as dev-containers windows behind the tunnel; the extension reads this
# label of the IMAGE (user agent, settings of the window). It REDUCES what is carried from the Mac into the container (no
# .gitconfig, no git/docker credential helper, no git/GitHub login in the terminal) — it is not a lock. ONLY in this stage:
# backend builds on base and must not inherit it (B is no dev container).
# Guard tools/check/projectbox-devcontainer-label.test.mjs (one line, valid JSON, no cbase. key).
LABEL devcontainer.metadata='[{"remoteUser":"agent","customizations":{"vscode":{"settings":{"dev.containers.copyGitConfig":false,"dev.containers.gitCredentialHelperConfigLocation":"none","dev.containers.dockerCredentialHelper":false,"git.terminalAuthentication":false,"github.gitAuthentication":false}}}}]'

# Entrypoint (cgroup, pool, leftovers, overlays of a copy, dockerd, DNAT) and wrapper (process group per start). tini is PID 1
# (comes with docker.io); `--init` at creation is therefore dropped. The clone program `cbase-clone` does NOT live here: it
# stands in the backend image under /usr/local/bin, which is mounted read-only into every project container and helper — a fix
# to it is a backend deploy, no new id of this image.
COPY projectbox-entry.sh /usr/sbin/cbase-projectbox-entry
COPY cbase-wrapper /usr/sbin/cbase-wrapper
RUN chmod 755 /usr/sbin/cbase-projectbox-entry /usr/sbin/cbase-wrapper \
    && bash -n /usr/sbin/cbase-projectbox-entry && perl -c /usr/sbin/cbase-wrapper
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/sbin/cbase-projectbox-entry"]
CMD []

# ─────────────────────────────────────────────────────────────────────────────────────────────── backend
# The per-user backend — the backend (server/backend) headless in the container. Must stay the LAST stage.
FROM base AS backend

# The native provider CLIs — every user logs in their OWN subscription in the container
# (Codex: device-auth; Claude: CLAUDE_CODE_OAUTH_TOKEN or auth login in the UI terminal).
# Versions PINNED: unpinned, the docker layer cache reused an old layer through every build — deploys ran with an old Claude Code
# and a newer model (needs a newer CLI) was rejected in the container with 400. A new CLI means: change the number here, then the
# layer rebuilds. Before every jump measure again (see the comments of connectors/claude.js):
#   - the flags cbase passes are unchanged; no limit pattern is dead (limits.js);
#   - `--system-prompt-snapshot off` still works (connectors/claude.js);
#   - every start carries the permission mode explicitly (`-p` without `--permission-mode` starts in mode `auto` since 2.1.285
#     and collects git context without our GIT_DIR); since 2.1.292 the CLI waits for background tasks after the end of stdin and
#     runs a follow-up turn — the connector stops them first (`stop_task`), oneshots run without background Bash and wakeup;
#   - the 5-hour window is called "5-hour limit" since 2.1.312 instead of "session limit" (limits.js recognizes both);
#   - the compaction of the reference is rebuilt — followed in runs/compaction-baseline.js (own wording; the measurement stays outside this tree);
#   - the model catalog needs a minimum CLI version (account catalog `min_claude_code_version`);
#   - Codex: since 0.155 the limit texts carry a typographic apostrophe, "insufficient_quota" reads "Quota exceeded. …" (limits.js);
#     models of the newest generation need at least 0.155.0 — a rollback before that pin hits migrated chats.
RUN npm install -g @anthropic-ai/claude-code@2.1.322 @openai/codex@0.162.1 \
    && claude --version && codex --version

# go-task: widespread stack runner (Taskfile.yml, `task up`) — project start commands need it. PINNED to the version that was built
# last — unpinned, a build without cache would silently take the newest, and the ro bind into the project containers would carry
# it. Guard: tools/check/projectbox-dockerfile.test.mjs (every `npm install -g` of the backend stage with @<version>).
RUN npm install -g @go-task/cli@3.53.1 && task --version

# The language servers of the editor: global, so that B finds them and every project container sees them read-only at the same
# path (/usr/local) — started with B's node, the start scripts and the search are in electron/server/lsp/table.js (PACKAGES,
# bound to this line in test/lsp-core.test.js). PINNED like everything here; `typescript` is the tsserver of
# typescript-language-server (`tsserver.fallbackPath`). Measured: TS/JS 680–865 MB per server — hence `useSyntaxServer: "never"`
# (lsp/table.js). B also starts the CSS (SCSS/Less) and the Markdown server from vscode-langservers-extracted; markdown-it for its
# `markdown/parse` lies in B (package.json, `npm ci` below).
RUN npm install -g typescript-language-server@6.0.2 typescript@6.0.3 basedpyright@1.40.2 yaml-language-server@1.25.0 vscode-langservers-extracted@4.10.0 \
    && test -f /usr/local/lib/node_modules/typescript-language-server/lib/cli.mjs \
    && test -f /usr/local/lib/node_modules/typescript/lib/tsserver.js \
    && test -f /usr/local/lib/node_modules/basedpyright/langserver.index.js \
    && test -f /usr/local/lib/node_modules/yaml-language-server/bin/yaml-language-server \
    && test -f /usr/local/lib/node_modules/vscode-langservers-extracted/lib/json-language-server/node/jsonServerNodeMain.js \
    && test -f /usr/local/lib/node_modules/vscode-langservers-extracted/lib/css-language-server/node/cssServerNodeMain.js \
    && test -f /usr/local/lib/node_modules/vscode-langservers-extracted/lib/markdown-language-server/node/workerMain.js

# VS Code CLI for remote tunnels (`code tunnel`): the user connects VS Code — desktop or vscode.dev — to their container, without
# ssh, without a client, without an open port; the tunnel runs through Microsoft's relay, logged in with a GitHub or Microsoft
# account. Pinned to a VS Code commit (the same rule as for the provider CLIs); the servers per connecting VS Code version are
# fetched by the CLI itself into the home volume. New CLI: change the commit, a server deploy.
ARG VSCODE_CLI_COMMIT=645f29cc3176500b4b5762ba887cf2a7f0ffdf2c
RUN arch="$(uname -m)"; case "$arch" in x86_64) a=x64;; aarch64) a=arm64;; *) echo "unknown architecture $arch" >&2; exit 1;; esac \
    && curl -fsSL "https://update.code.visualstudio.com/commit:${VSCODE_CLI_COMMIT}/cli-linux-${a}/stable" -o /tmp/vscode-cli.tgz \
    && tar -xzf /tmp/vscode-cli.tgz -C /usr/local/bin code && rm /tmp/vscode-cli.tgz && code --version

WORKDIR /app
COPY package.json package-lock.json ./
# The dead shell of @huggingface/transformers: `npm install` pulls in onnxruntime-web (the browser runtime, ≈ 91 MB wasm) with
# everything reachable only through it — the node build of transformers NEVER loads it (tools/check/lib/runtime-dependencies.mjs
# `NEVER_LOADED`; measured: embedding with CBASE_EMBED_OFFLINE=1 and the import smoke test of the server ran the same in a copy
# without these packages). The list is the SAME as the exclusions of the dead shell in tools/check/lib/runtime-dependencies.mjs
# `NEVER_LOADED` (guard tools/check/runtime-dependencies.test.mjs); whether the image loads afterwards is told by the load smoke
# test in targets/server.mjs backendImageProbe. `npm ci` takes the versions of the lockfile — the same ones the gate checked
# against on the Mac.
# ONNXRUNTIME_NODE_INSTALL_CUDA=skip: on linux/x64 the install script of onnxruntime-node downloads the CUDA build from GitHub
# on top of the CPU build it already ships. The server has no GPU, and the download of 1.21.0 answers 404 since November 2026,
# so the build fails as soon as this layer is not cached (guard tools/check/runtime-dependencies.test.mjs).
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --omit=dev && npm cache clean --force \
    && rm -rf node_modules/onnxruntime-web node_modules/flatbuffers node_modules/guid-typescript node_modules/long \
       node_modules/platform node_modules/protobufjs node_modules/@protobufjs node_modules/@types/node node_modules/undici-types \
    && test ! -e node_modules/onnxruntime-web
COPY electron ./electron
# The German bundles of the language servers for CSS, JSON and Markdown (verbatim from microsoft/vscode-loc, read via
# VSCODE_L10N_BUNDLE_LOCATION as in VS Code; lsp/table.js "LANGUAGE OF THE MESSAGES"): next to the packages, because only
# /usr/local/lib/node_modules also lies in every project container (projectbox/creation.js SYSTEM_PATHS). Without package.json —
# npm does not see the folder. Here instead of with the packages above: a change of the bundles then rebuilds only from this layer.
RUN mkdir -p /usr/local/lib/node_modules/cbase-lsp-l10n \
    && cp -R /app/electron/server/lsp/l10n/. /usr/local/lib/node_modules/cbase-lsp-l10n/ \
    && test -f /usr/local/lib/node_modules/cbase-lsp-l10n/de/vscode.css-language-features.i18n.json \
    && test -f /usr/local/lib/node_modules/cbase-lsp-l10n/de/vscode.json-language-features.i18n.json \
    && test -f /usr/local/lib/node_modules/cbase-lsp-l10n/de/vscode.markdown-language-features.i18n.json
COPY headless.js ./
RUN mkdir -p /app/webstub && printf 'cbase Backend' > /app/webstub/index.html

# The user agent and CLAUDE_SECURESTORAGE_CONFIG_DIR come from `base`.
COPY entry.sh /entry.sh
RUN chmod +x /entry.sh
# `cbase-project`: from every terminal of the user container into the project container of a project. To /usr/bin, NOT
# /usr/local/bin — that is mounted into every project container. An ES module without suffix; no package.json lies above it
# here, Node recognizes the import syntax itself — `node --check` checks exactly this way.
COPY cbase-project /usr/bin/cbase-project
RUN chmod 755 /usr/bin/cbase-project && node --check /usr/bin/cbase-project
# `cbase-git`: the wrapper VS Code gets in B as git.path (vscode-tunnel.js) — if the folder lies in a converted project, git goes
# via `cbase-project <id> -- git …` into its project container. Next to cbase-project in /usr/bin (not /usr/local/bin: that is
# mounted into every project container). POSIX sh; `dash -n` and `bash -n` check it.
COPY cbase-git /usr/bin/cbase-git
RUN chmod 755 /usr/bin/cbase-git && dash -n /usr/bin/cbase-git && bash -n /usr/bin/cbase-git
# The git folder of the runs in B: runtime/inProject.js puts it first in the PATH of every start WITHOUT instance in operation
# (GIT_WRAPPER_FOLDER) — a `git` of a run in B on a path of a converted project thus goes through cbase-git into its project
# container, otherwise it is the git of B. A script, no link: cbase-git calls `git` via PATH itself and would land here again —
# CBASE_GIT_BIN pins the real git. Not under /usr/local (that is mounted into every project container).
RUN mkdir -p /usr/lib/cbase/git-path \
    && printf '#!/bin/sh\nCBASE_GIT_BIN=/usr/bin/git exec /usr/bin/cbase-git "$@"\n' > /usr/lib/cbase/git-path/git \
    && chmod 755 /usr/lib/cbase/git-path/git && dash -n /usr/lib/cbase/git-path/git \
    && PATH=/usr/lib/cbase/git-path:$PATH git --version
# Plus /etc/profile.d/cbase-git-path.sh: a LOGIN shell resets the PATH — Debian's /etc/profile replaces it entirely for non-root,
# and the shell tool of Codex 0.15x starts `exec_command` as a login shell (measured on 0.151.0: the folder dropped out, `git`
# was /usr/bin/git in B again). /etc/profile reads profile.d AFTER setting it; the script puts the folder first again only with
# the operating mark and only if it is not already first. Backend only — the projectbox stays untouched. A line of its own right
# after the folder (the line above is pinned verbatim in tools/check/cbase-git.test.mjs); the two probes at the end run a real
# login shell with and without the mark.
RUN printf '%s\n' \
       '# cbase: the git folder of the runs in B first in the PATH, also in a login shell — in operation only.' \
       'if [ "${CBASE_CONTAINER:-}" = 1 ] && [ "${CBASE_DIND:-}" = 1 ]; then' \
       '  case "$PATH" in /usr/lib/cbase/git-path|/usr/lib/cbase/git-path:*) ;; *) PATH="/usr/lib/cbase/git-path:$PATH"; export PATH ;; esac' \
       'fi' > /etc/profile.d/cbase-git-path.sh \
    && dash -n /etc/profile.d/cbase-git-path.sh \
    && test "$(CBASE_CONTAINER=1 CBASE_DIND=1 bash -lc 'command -v git')" = /usr/lib/cbase/git-path/git \
    && test "$(bash -lc 'command -v git')" = /usr/bin/git
# `cbase-clone`: the volume clone of a copy in two phases, python3. DELIBERATELY to /usr/local/bin — that is mounted read-only
# into every project container (rule `system-bin`, projectbox/creation.js) and into the helpers; there it runs with the python3 of
# the projectbox image. In the projectbox image it would sit in its id for good: every fix would re-create every relocated
# project. `--help` loads the program once completely (syntax, imports).
COPY cbase-clone /usr/local/bin/cbase-clone
RUN chmod 755 /usr/local/bin/cbase-clone && python3 /usr/local/bin/cbase-clone --help >/dev/null
# `cbase-manifest`: the manifest per entry with which the relocation measures every volume at the stopped source and at the target
# before the start (comparer: electron/server/projectbox/relocation/manifest.js). Deliberately under /usr/local/bin: that is
# mounted read-only into every project container (projectbox/creation.js, rule system-bin) — in B, in a helper and in the project
# container the SAME program measures, and a fix is a backend deploy, no new image id of the projectbox. python3 comes from
# `base`. The run over a small tree with a symlink drives the whole way under Linux including real xattr calls (via /proc/self/fd)
# and checks the final line — the guard in the gate (server/backend/test/relocation-manifest.test.js) runs on macOS with xattr
# functions injected.
COPY cbase-manifest /usr/local/bin/cbase-manifest
RUN chmod 755 /usr/local/bin/cbase-manifest \
    && d="$(mktemp -d)" && mkdir "$d/a" && printf x > "$d/a/f" && ln -s f "$d/a/l" \
    && python3 /usr/local/bin/cbase-manifest "$d" | tail -n 1 | grep -qxF '{"end":true,"entries":4}' \
    && rm -rf "$d"
# `cbase-lfs-access`: the git credential helper that the projectbox names in /etc/gitconfig. Deliberately under /usr/local/bin
# like cbase-clone: mounted read-only into every project container (rule `system-bin`), a fix is a backend deploy, no new id of
# the projectbox. In B no configuration names it. Node from the base image (shebang /usr/local/bin/node); the probe runs it via its
# shebang with an LFS request WITHOUT its environment — it must be silent, on stdout AND stderr (every git call in the project
# container asks it).
COPY cbase-lfs-access /usr/local/bin/cbase-lfs-access
RUN chmod 755 /usr/local/bin/cbase-lfs-access && node --check /usr/local/bin/cbase-lfs-access \
    && test -z "$(printf 'protocol=https\nhost=h\npath=o/r.git/info/lfs\n\n' | /usr/local/bin/cbase-lfs-access get 2>&1)"
# The package caches of B: OWN folders that no project container mounts. ~/.npm, ~/.cache/uv, ~/.cache/pip and
# ~/.cache/ms-playwright are the SHARED caches of the project containers (rw, projectbox/creation.js CACHES) — if B (npx, uvx,
# pip, playwright) read code from them, every project container could plant it on B. These folders are listed under "never
# mounted" (creation.js B_CACHE_FOLDER), and runtime/inProject.js never passes the four names into a project container
# (B_OWN_ENV): there the defaults apply, i.e. the shared caches. Behind every npm install (root would otherwise put its cache
# there). PLAYWRIGHT_BROWSERS_PATH: B starts its browser from CBASE_CHROMIUM (toolchain/playwright.js executablePath) and loads none
# from the cache — the folder stays empty until a run in B itself calls `playwright install`; therefore the build installs nothing
# here. Guards: projectbox-creation.test.js and tools/check/projectbox-dockerfile.test.mjs.
ENV HOME=/home/agent \
    SHELL=/bin/bash \
    CBASE_HOST=0.0.0.0 \
    PORT=7718 \
    CBASE_CHROMIUM=/usr/bin/chromium \
    CBASE_VSCODE_TUNNEL=1 \
    npm_config_cache=/home/agent/.cache/cbase-b/npm \
    UV_CACHE_DIR=/home/agent/.cache/cbase-b/uv \
    PIP_CACHE_DIR=/home/agent/.cache/cbase-b/pip \
    PLAYWRIGHT_BROWSERS_PATH=/home/agent/.cache/cbase-b/ms-playwright
# Entry starts the inner dockerd if needed (as root) and then switches to `agent`.
WORKDIR /home/agent

EXPOSE 7718
ENTRYPOINT ["/entry.sh"]
