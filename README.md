# Riemann Agent

Riemann Agent is a persistent, IPython-first agentic coding system based on the Pi agent harness.

The model is exposed to one tool, `ipython`. Every other capability—workspace I/O, shell execution, web access, MCP, durable artifacts, and child-agent coordination—is registered as an asynchronous Python function inside a persistent kernel.

Core behavior:

- Atomic post-cell Python-state snapshots and recovery after a kernel crash.
- Snapshot/CAS workspace edits with atomic writes and conflict detection.
- SQLite-backed run, agent, message, artifact, and capability state.
- Lazy MCP activation and dynamically installed Python namespaces.
- Durable asynchronous child agents with direct messages, steering, limits, model roles, capability narrowing, and shared/worktree topology and host/workspace permissions.
- Compact model context: large results stay in Python variables or content-addressed artifacts; summaries carry deterministic durable state.
- Pi's provider support, authentication, TUI, sessions, settings, RPC mode, and extension framework.

Start from source:

```bash
npm install
npm run build
node packages/coding-agent/dist/cli.js
```

See [`packages/coding-agent/README.md`](packages/coding-agent/README.md) for configuration, Python API examples, architecture, and inherited Pi documentation.

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[riemann-agent](packages/coding-agent)** | Persistent IPython-first coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## System sandbox

Riemann runs every IPython kernel and host shell process in a mandatory native sandbox:

- Linux: Bubblewrap with filesystem mounts and isolated network/process namespaces. Install `bwrap` before starting Riemann.
- macOS: the built-in Seatbelt sandbox through `/usr/bin/sandbox-exec`.
- Other platforms: startup of an execution kernel fails explicitly; there is no unsandboxed fallback.

Direct Python network access is denied. Filesystem access follows a per-agent `FileAccessPolicy` configured through `agents.*.filesystem` (`read`, `readExclude`, `write`, `writeExclude`, each a path list or `inherit`); the main Agent defaults to unrestricted read and write of `/`, shared Subagents inherit their caller's policy, and worktree Subagents inherit reads while writing only their own worktree. Exclusions exist only where configured. When Riemann state is nested inside a workspace, workspace-scoped Agents see a masked state subtree with only the managed runtime remounted read-only; durable snapshots are staged through the isolated kernel directory. The main Agent can explicitly use `shell.network`; default children cannot. Containers may still be used as an additional deployment boundary.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "riemann-${VERSION}-source.tar.gz"
cd "riemann-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
