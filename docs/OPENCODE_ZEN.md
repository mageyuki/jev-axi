# Running the reviewed fork with OpenCode Zen

This fork of jev-axi can use OpenCode Zen, TypeSafe, or Laya. A registry release
is not a substitute for this reviewed build. Keep the fork and its launcher under
your control; do not replace it when an update notice appears.

## Build and select a backend

From the reviewed fork checkout, use Node 22+ and run `pnpm install` and `pnpm build`.
Run `node dist/bin/jev-axi.js --version` to check the built CLI (this release is
`0.7.2`). For a persistent command, put your own launcher on PATH that executes
`node /absolute/path/to/reviewed-fork/dist/bin/jev-axi.js "$@"`. Rebuild the fork
only after reviewing its changes; the version notice is information, not an
instruction to install a registry package. Invoke the Node entry point directly
until the launcher is available.

`JEV_BACKEND=opencode-zen|typesafe|laya` explicitly selects a provider. Otherwise
a nonempty `TYPESAFE_BASE_URL` or `TYPESAFE_BACKEND=laya` selects Laya; then a
discoverable OpenCode Console credential selects Zen; without one the fallback is
TypeSafe. A typo in `JEV_BACKEND` is an error, not a fallback. Cloud inputs are
sent to the **selected** provider, not necessarily TypeSafe. A user-supplied Laya
URL is not assumed to be loopback or private: check the destination before sending
data. Without `TYPESAFE_BASE_URL`, Laya defaults to `http://127.0.0.1:8000`.

## Credentials and models

- Zen uses `OPENCODE_API_KEY` first, then an OpenCode Console credential from a
  read-only SQLite store when the Node runtime supports `node:sqlite` (Node 22.13+).
  `JEV_OPENCODE_DB` selects one database path and does **not** fall through if
  empty, missing, or unusable. Otherwise the CLI tries `opencode debug paths db`
  and then `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`. Store access
  is optional: set `OPENCODE_API_KEY` if SQLite is unavailable. A TypeSafe key is
  never a substitute for a Zen credential.
- TypeSafe uses `TYPESAFE_API_KEY`, then `.env.local`/`.env` from the working
  directory upward, then the jev-axi config key. Laya uses those same sources
  when provided, or a local placeholder if none is set; that placeholder does
  not establish that a remote, user-supplied Laya URL is safe or authenticated.
- Zen's default model is `jev-1.13-free`; TypeSafe defaults to `jev-latest`;
  Laya defaults to `laya-421m` unless its default is configured. `--model`
  overrides a call, `JEV_MODEL` overrides the backend default, and the
  TypeSafe/Laya default can be set with `TYPESAFE_DEFAULT_MODEL` or
  `jev-axi config set model <name>`. Zen's two model names shown by
  `jev-axi models` (`jev-1.13-free` and `jev-1.13`) are a **documentation-only
  listing**, not remote availability or entitlement verification.

Run `node dist/bin/jev-axi.js --check-backend` for a local preflight: it prints
the selected backend after resolving a credential. It does **not** validate the
key remotely, guarantee model access, or send a test request. Do not run a live
smoke request merely to check setup. Errors should be reported by code and
backend without copying credentials, authorization headers, or secret-bearing
input into reports or logs.

## Cache and agent activation

Responses are cached by backend, requested model, state, and questions for a
default TTL of 24 hours (`jev-axi config set cacheTtlHours 0` disables caching).
On a cold cache, the first evaluation needs the selected backend; a local
preflight alone does not warm the cache. A concrete model version learned from
a response is used to invalidate an alias's older answers after a model change.
Zen requires a credential even when a cached answer exists.

Installing the CLI does not activate agent behavior. Ask the user which skill,
session hook, or integration to enable, and install only that reviewed fork
artifact under their chosen agent scope. Restart the agent session after enabling
hooks or a skill. Never send secrets in state, piped input, logs, diffs, or
untrusted text; recognizable redaction is not a guarantee of safety.
