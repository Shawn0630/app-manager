# App Manager

A small LAN-only manager for Docker apps. It gives you the part of
Jenkins that matters for a home / small-team server — **watch GitHub
for new commits and deploy automatically** — plus a dashboard that
shows every app's status, port, current commit and last deployment,
with buttons to start / stop / restart / update, an editor for each
app's `.env` file, a form to add new apps straight from the
dashboard, and GitHub Actions as an alternative deployment trigger.
No Jenkins required; it runs on one Linux box (and on a Mac for
development).

## Features

- **Dashboard**: per app — container state (running / stopped /
  partial / unknown), published ports, health, current commit
  (hash + time + subject), remote state (up to date / update
  available), last deployment (time, trigger, result, duration),
  auto-deploy flag.
- **Actions**: Start, Stop, Restart, Update (pull + rebuild),
  Logs, Check now, Environment (.env editor). One operation per app
  at a time (mutex); long operations run in the background and the
  UI shows the app as busy.
- **Auto-deploy**: two independent trigger sources per app —
  new commits (polled with `git ls-remote`) and GitHub Actions
  (a new **successful** workflow run). The `trigger` field selects
  `commit`, `actions`, `both`, or `manual`; see below.
- **Add App from the dashboard**: paste a repo URL and the manager
  clones it into `APPS_ROOT`, detects the compose file, and
  registers the app — no config editing or restart needed.
- **Deploy pipeline**: `git fetch` → `git pull --ff-only` (diverged
  branches fail loudly, nothing is force-pushed) →
  `docker compose up -d --build` → `docker compose ps` to verify.
  Every run — success or failure — is appended to
  `data/deployments.jsonl` with per-step exit codes and output tails.
- **.env editing**: table editor (values masked by default) or raw
  text editor. Saves are validated line by line, written atomically,
  the previous version is backed up, and only the changed **key
  names** are recorded — never values (see Security).
- **Optional login**: HTTP Basic auth, enabled by setting
  `MANAGER_PASSWORD`.

## Quick start

### Run directly with Node (development)

Requires Node.js 20+ and git + docker CLI on the PATH.

```sh
npm install
cp config/apps.example.json config/apps.json   # then edit workdir etc.
npm start                                       # http://localhost:9000
```

### Run with Docker

```sh
cp config/apps.example.json config/apps.json    # then edit
# edit docker-compose.yml: set MANAGER_PASSWORD, add your app
# workdir mounts (same absolute paths as on the host!)
docker compose up -d --build                    # http://localhost:9000
```

## Configuration

`config/apps.json` (path overridable with `CONFIG_PATH`):

```json
{
  "apps": [
    {
      "id": "algorithm-visualizer",
      "name": "Algorithm Visualizer",
      "repoUrl": "https://github.com/Shawn0630/project_algorithm_visualizer",
      "workdir": "/home/you/apps/project_algorithm_visualizer",
      "envFile": ".env",
      "branch": "main",
      "composeFile": "docker-compose.yml",
      "projectName": "algorithm-visualizer",
      "port": 8088,
      "autoDeploy": false,
      "pollIntervalSec": 120,
      "trigger": "commit",
      "provider": "builtin"
    }
  ]
}
```

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `id` | yes | — | Unique app id (URLs, records). |
| `name` | no | = id | Display name. |
| `repoUrl` | yes | — | Git remote used for `git ls-remote` polling. |
| `workdir` | yes | — | Local checkout of the repo on the host. |
| `envFile` | no | `.env` | .env file path, relative to `workdir`. |
| `branch` | no | `main` | Branch to watch and deploy. |
| `composeFile` | no | `docker-compose.yml` | Compose file, relative to `workdir`. |
| `projectName` | no | = id | Compose project name (`-p`). |
| `port` | no | null | Main port, shown as a link in the dashboard. |
| `autoDeploy` | no | false | Master switch for automatic deployments. |
| `pollIntervalSec` | no | 120 | Poll interval per app, in seconds. |
| `trigger` | no | `commit` | Auto-deploy source: `commit`, `actions`, `both`, or `manual` (nothing automatic). |
| `workflow` | no | _(any)_ | For `actions` triggers: workflow name or file name to watch (e.g. `ci.yml`); empty = any workflow. |
| `actionsEvent` | no | `push` | For `actions` triggers: run event to watch. |
| `provider` | no | `builtin` | Deploy provider (only `builtin` in v1). |

Environment variables for the manager itself:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `9000` | Listen port. |
| `CONFIG_PATH` | `./config/apps.json` | App registry location. |
| `DATA_DIR` | `./data` | `deployments.jsonl`, .env backups, trigger state. |
| `APPS_ROOT` | `./apps` | Add App clones new repos into `APPS_ROOT/<id>`. |
| `MANAGER_USER` | `admin` | Basic auth user (only with a password). |
| `MANAGER_PASSWORD` | _(unset)_ | When set, Basic auth protects **all** routes. |
| `GITHUB_TOKEN` | _(unset)_ | Token for the GitHub Actions API. Required for private repos; raises the rate limit for public ones. |
| `GITHUB_API_URL` | `https://api.github.com` | API base override (GitHub Enterprise, or tests). |

## How it works

1. **Polling**: a per-app timer watches the sources selected by the
   app's `trigger`:
   - `commit` / `both`: `git ls-remote <repoUrl> refs/heads/<branch>`
     refreshes the remote HEAD cache; the dashboard compares it with
     the local `HEAD` to show "update available".
   - `actions` / `both`: the GitHub API is polled for recent
     workflow runs (see the next section).
   With `autoDeploy` on and an idle app, a new commit (trigger
   `poll`) or a new successful Actions run (trigger `actions`)
   starts the deploy pipeline automatically.
2. **Deploy** (manual Update button, or automatic): the pipeline
   above runs in the app's workdir, holding the app's lock.
3. **Providers**: deployments go through a tiny provider interface —
   `src/providers/builtin.js` exports `checkRemote(app)` and
   `deploy(app, trigger)`, and `src/providers/index.js` maps the
   config's `provider` name to an implementation. **To add Jenkins
   later**: write `src/providers/jenkins.js` with the same two
   functions (check = ask Jenkins / the git remote, deploy = trigger
   a Jenkins job and watch it), register it as `"jenkins"`, and set
   `"provider": "jenkins"` on the app. Nothing else changes.

## Adding apps from the dashboard

The **Add App** form at the top of the dashboard takes a repo URL,
an optional name (default: the repo name), branch, port, trigger
mode, workflow filter, and the auto-deploy flag. The server then:

1. derives the app id from the repo name (slugified, de-duplicated),
2. clones the repo into `APPS_ROOT/<id>` (`git clone --branch`),
3. looks for a compose file (`docker-compose.yml`, `compose.yml`,
   or `compose.yaml`) in the repo root,
4. appends the app to the registry — `CONFIG_PATH` is rewritten
   atomically, and the new app is polled immediately, no restart.

Registration is **warning-based**: if the clone fails or no compose
file is found, the app is still registered and the card shows the
reason as a warning. Fix the repo, then use Check now / Update; or
remove the app with the card's **Remove** button. Removal only
touches the registry — the workdir stays on disk. The API also
supports `DELETE /api/apps/:id?purge=1`, which additionally deletes
the workdir, but only when it lives inside `APPS_ROOT` (the
dashboard never purges).

Because Add App rewrites the registry, the config mount in the
Docker setup is read-write.

## GitHub Actions as a trigger

With `trigger` set to `actions` or `both`, each poll calls
`GET /repos/{owner}/{repo}/actions/runs` (owner/repo are parsed from
`repoUrl`; only github.com URLs work). Runs are filtered by branch,
event (`actionsEvent`, default `push`), and the optional `workflow`
name/file. The dashboard card shows the latest completed run
(workflow · conclusion · time, linking to GitHub).

Trigger semantics:

- **Only `conclusion: "success"` counts.** Failed/cancelled runs
  never deploy.
- **Each run fires at most once.** The consumed run id is persisted
  in `DATA_DIR/state.json` before the deploy starts, so restarts
  never re-trigger, and a failed deploy is retried manually, not in
  a loop.
- **First sight is a baseline.** The first completed run the
  manager ever sees for an app is recorded without deploying — the
  manager deploys on runs that complete *while it watches*, not on
  history. (The commit trigger in `both` mode still covers older
  commits.)
- The pipeline itself is unchanged — `pull --ff-only` to the branch
  head. The deployment record carries `workflowRunId` and
  `targetSha` (the run's head SHA); if the branch head has moved past
  the run, the record notes the difference instead of hiding it.

**Token**: set `GITHUB_TOKEN` in the manager's environment.
Private repos require it — the token needs read access to the repo
and its Actions (a fine-grained PAT with *Actions: read-only* plus
*Metadata*, or a classic PAT with `repo` scope). Public repos work
without a token but are rate-limited (60 requests/hour per IP),
which a short `pollIntervalSec` can exhaust — a token is
recommended either way.

## .env editing

Each app card has an **Environment** button. The editor opens the
file at `<workdir>/<envFile>`:

- **Table mode**: one row per variable; keys are read-only, values
  are masked password fields (toggle **Show values** to reveal).
  Add/remove rows freely. Comments and blank lines from the original
  file are preserved when saving from table mode.
- **Raw mode**: edit the whole file text, comments included.
- **Save** writes the file only. **Save & Redeploy** also runs
  `docker compose up -d` (recorded as a deployment with trigger
  `manual-env`) so containers pick up the new values.
- Every line must be `KEY=VALUE`, a `#` comment, or blank; anything
  else is rejected with the offending line numbers.
- Before overwriting, the old file is copied to
  `DATA_DIR/backups/<appId>/<timestamp>.env` (newest 10 kept). The
  write itself is atomic (temp file + rename).

## Security — read this

- **Mounting `/var/run/docker.sock` gives the manager root-equivalent
  control over the host.** Treat the dashboard accordingly: LAN only,
  never expose it to the internet, and always set
  `MANAGER_PASSWORD` in real deployments.
- **.env files usually contain secrets.** Only edit them through the
  dashboard when `MANAGER_PASSWORD` is set (otherwise anyone on the
  LAN can read and change them via the env endpoint). Env **values**
  are returned only by the dedicated env endpoint; they are never
  written to server logs, deployment records (only key names are),
  or backups of anything but the .env file itself (the backups under
  `DATA_DIR/backups/` do contain old values — protect `DATA_DIR`).
- Deploy uses `git pull --ff-only`: local uncommitted changes in an
  app's workdir can make pulls fail (recorded as failed deployments).
  Keep managed workdirs clean — they are deployment targets, not
  development checkouts.
- Private repositories rely on the host's git credentials / SSH keys
  (the manager runs git as the same user / container). Test with
  `git ls-remote <repoUrl>` as that user if polling fails.

## Deploying on Linux

1. Install Docker Engine + Compose plugin and git on the box.
2. Clone this repo, create `config/apps.json` with the real host
   paths of your app checkouts.
3. In `docker-compose.yml`, set a real `MANAGER_PASSWORD` and add a
   bind mount for each app workdir **at the same absolute path as on
   the host** (see the comment in the compose file — the daemon
   resolves compose bind mounts on the host filesystem, so the paths
   must match inside the manager container).
4. `docker compose up -d --build`; open `http://<box-ip>:9000`.
5. If your apps deploy over SSH git remotes, mount the SSH key /
   known_hosts into the manager container or use HTTPS remotes with
   a credential helper on the host paths it can reach.

## Known limitations

- Polling has latency: a commit is noticed within
  `pollIntervalSec`, not instantly. There are no webhooks (a public
  GitHub webhook cannot reach a LAN box without a tunnel anyway).
- Container state and ports are parsed from
  `docker compose ps --format json`; both the JSON-array and the
  NDJSON output shapes are handled, but exotic compose versions may
  differ.
- Start/Stop/Restart are fire-and-forget compose calls; only deploys
  (Update / auto-deploy / env redeploy) are recorded in the
  deployment history.
- `.env` lines must be plain `KEY=VALUE`; `export KEY=VALUE` lines
  are not supported in v1.
- One manager instance per host is assumed (locks and poll caches
  are in-memory).
- The Actions trigger was verified against a local **mock** GitHub
  API, not the real one — a first run against a real repo + token
  still needs to happen on the target machine. Actions runs created
  before the manager first watches an app never trigger (baseline
  rule, see above).

## Development / verification

`tests/` contains an end-to-end suite that runs **without a Docker
daemon**: a fake `docker` executable (`tests/fake-bin/docker`), a
local bare git repo as the remote, and a mock app workdir exercise
the full flow — status, check, manual update, stop/start, logs,
polling auto-deploy, the busy mutex, Basic auth, and the .env
endpoints (including backups and the "key names only" journal rule).
A second phase swaps in a **mock GitHub API** server and verifies
the Actions trigger end to end: run parsing, the baseline rule, a
successful run deploying, a failed run not deploying, no
re-triggering after a restart, commit-triggered apps being
unaffected — plus Add App (clone, registry persistence, warnings)
and DELETE / purge.

```sh
npm run test:e2e
NODE_PATH=/tmp/pptr/node_modules node tests/screenshot.mjs   # dashboard screenshots
```

What this does **not** verify (needs a real Docker machine): actual
`docker compose ps` output from a live daemon, real image builds,
and the socket-mount path behaviour in the manager's own container.
