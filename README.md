# cf-versioned-deploy

**Two-phase (staged) deploys for Cloudflare Workers.** A small Node CLI that wraps
`wrangler versions upload` (stage a new Worker version without serving traffic) and
`wrangler versions deploy <id>@100%` (promote it to live), so you can upload several Workers first
and promote them all together only after every upload succeeds. It also fixes a common gotcha:
**versioned deploys don't register Cron Triggers**, so `promote` re-syncs `triggers.crons` from
`wrangler.jsonc` with `wrangler triggers deploy`. Useful for monorepos, multi-worker CI/CD pipelines
(GitHub Actions and others), and atomic, blue-green style rollouts on Cloudflare Workers.

## Why

`wrangler deploy` builds, uploads, and goes live in one command, so deploying is the same moment as
exposing. Splitting it in two gives you:

- **upload**: the new version exists only behind a preview URL. Traffic still goes to the old version.
- **promote**: traffic switches to the new version only now.

With several Workers (for example an API, a realtime service, and a tail worker), you can upload each
one, check that all uploads succeeded, and then promote them together. No half-deployed window where
one Worker runs the new code and another still runs the old code.

The second reason: **`wrangler versions upload` / `versions deploy` never touch Cron Triggers.**
Triggers are a script-level setting, not a version-level one. Without an extra step, crons written in
`wrangler.jsonc` are never attached to the deployed Worker and scheduled jobs silently stop running.
`cf-versions-promote` runs `wrangler triggers deploy` right after a successful promote to fix this.

## Use cases

- **Monorepo / multi-worker release**: upload every Worker in CI, promote all of them only if every
  upload passed.
- **Check before going live**: upload, test the preview URL, then promote.
- **Scheduled Workers**: use versioned deploys and still get the `triggers.crons` from
  `wrangler.jsonc` applied.
- **Secrets and vars from `.env`**: ship secrets with the version via `--secrets-file` and inject
  vars from `.env` without extra scripting.

## Install

```sh
npm install cf-versioned-deploy
# or
pnpm add cf-versioned-deploy
```

`wrangler` must be available through `npx` in the Worker directory.

## Usage

```jsonc
// package.json in the Worker directory (next to wrangler.jsonc)
{
  "scripts": {
    // 1) Upload a new version (not live) and save its Version ID to .deploy-version-id
    "upload": "cf-versions-upload --secret AUTH_SECRET --var-from-env POSTHOG_KEY=VITE_PUBLIC_POSTHOG_KEY",
    // 2) Read the saved Version ID, promote it to 100%, and sync cron triggers
    "promote": "cf-versions-promote"
  }
}
```

The two commands share state through a single file, `.deploy-version-id`. `upload` parses
`Version ID:` from the wrangler output and writes it there. `promote` reads it.

A multi-worker CI flow looks like this:

```sh
export CF_VERSION_TAG="$GITHUB_SHA"   # same tag on every Worker
(cd workers/api && pnpm upload)
(cd workers/realtime && pnpm upload)
# every upload succeeded, now go live together
(cd workers/api && pnpm promote)
(cd workers/realtime && pnpm promote)
```

## CLI

### `cf-versions-upload`

Runs `wrangler versions upload` and saves the Version ID to a file.

| Option | Description |
| --- | --- |
| `--tag <t>` | Version tag (defaults to `$CF_VERSION_TAG`). In CI, set this env once so every Worker gets the same tag |
| `--message <m>` | Version message (defaults to `$CF_VERSION_MESSAGE`) |
| `--var-from-env NAME=KEY` | Inject the `.env` value of `KEY` as `--var NAME:<value>` (repeatable; skipped with a warning if empty) |
| `--secret KEY` | Include the `.env` value of `KEY` in the version via `--secrets-file` (repeatable; skipped if empty) |
| `--env <path>` | Path to `.env` (default `.env`) |
| `--id-file <path>` | Where to save the Version ID (default `.deploy-version-id`) |

### `cf-versions-promote`

Promotes the saved Version ID with `wrangler versions deploy <id>@100%`, then, if `triggers.crons` is
set, syncs it with `wrangler triggers deploy`.

| Option | Description |
| --- | --- |
| `--id-file <path>` | Path to the Version ID file (default `.deploy-version-id`) |
| `--message <m>` | Deployment message (optional) |

## API

The same logic is exported for use from your own scripts.

```ts
import { uploadVersion, promoteVersion } from "cf-versioned-deploy";

uploadVersion({
  tag: "v1.2.3",
  varFromEnv: ["POSTHOG_KEY=VITE_PUBLIC_POSTHOG_KEY"],
  secrets: ["AUTH_SECRET"],
  envPath: ".env",
  idFile: ".deploy-version-id",
});

promoteVersion({ idFile: ".deploy-version-id" });
```

| Export | Description |
| --- | --- |
| `uploadVersion(opts: UploadOptions)` | Same as `cf-versions-upload` |
| `promoteVersion(opts: PromoteOptions)` | Same as `cf-versions-promote` (including cron trigger sync) |
| `readEnv(path)` | Parse a `.env` file. Returns `{}` if the file is missing |
| `resolveVarArgs(env, specs)` | Turn `NAME=KEY` specs into wrangler `--var` arguments |
| `writeSecretsFile(env, keys)` | Write a temporary secrets JSON for `--secrets-file`. Returns `null` if no values |

Both `uploadVersion` and `promoteVersion` call `process.exit` on failure, so they are meant for CLI
scripts rather than long-running processes.

## Notes

- **Missing `--var-from-env` / `--secret` values don't fail the deploy.** A warning goes to stderr and
  the value is skipped, so a local `.env` with only some secrets still works.
- Secrets are written to a temporary JSON file (`0600`, in `os.tmpdir()`), passed with
  `--secrets-file`, and removed in a `finally` block.
- Trigger sync only reads **top-level** `triggers.crons`. Environment-scoped `env.<name>.triggers` is
  ignored, because the versioned path targets the top-level (production) environment.
- Trigger sync reads `wrangler.jsonc` / `wrangler.json` only. Workers configured with `wrangler.toml`
  skip the sync.
- If `assets.directory` is set, `promote` creates an empty directory there so `wrangler triggers
  deploy` passes its check. No assets are uploaded at this step.

## License

MIT
