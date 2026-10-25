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
- **Add Project from the dashboard** (its own page, next to Apps
  and Activity): paste a repo URL and the manager clones it into
  `APPS_ROOT`, detects the compose file, and registers the app —
  or register a **local folder** in place: if it is a git repo
  with a GitHub remote it gets the full feature set (commit
  polling, Actions watching, pull-based deploys); without a
  remote it is managed locally (start / stop / rebuild). No
  config editing or restart needed either way.
- **Deploy pipeline**: `git fetch` → `git pull --ff-only` (diverged
  branches fail loudly, nothing is force-pushed) →
  `docker compose up -d --build` → `docker compose ps` to verify.
  Every run — success or failure — is appended to
  `data/deployments.jsonl` with per-step exit codes and output tails.
  Start / Stop / Restart are journaled there too, as lightweight
  `kind: "action"` records (action, result, duration, output tail).
  The dashboard's Activity feed renders every record as a row of
  **tags** — kind (Deploy / Action / Env), action (Update, Redeploy,
  Start, …), trigger (Manual / Auto · Commit / GitHub Actions),
  result (Success / Failed) — and a failed deployment names the step
  it died on right in the row.
- **Two-layer .env editing**: the app repo's `.env` is the **static**
  layer (table editor with masked values, or raw text; saves are
  validated line by line, written atomically, the previous version
  is backed up, and only the changed **key names** are recorded —
  never values). A second, manager-kept **dynamic** layer holds
  per-deployment overrides: on each deployment the effective env is
  static + dynamic (dynamic wins), injected into the containers via
  a generated compose override file — the repo's `.env` is never
  touched by deployments. The editor's **Currently in use** section
  shows the effective env of the last deployment, per key, with its
  source. See ".env: static, dynamic, and currently in use" below.
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
# optional: cp .env.example .env and set MANAGER_PORT to change
# the dashboard port (default 9000), and HOST_PROJECTS_DIR to the
# folder holding your projects (mounted same-path; the folder
# picker opens there)
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
| `source` | no | `clone` | How the app was added: `clone` (cloned into `APPS_ROOT`) or `local` (a local folder registered in place; never deleted by the manager). |
| `repoUrl` | no | — | Git remote used for `git ls-remote` polling and Actions watching. Null only for local folders without a git remote — those are managed locally (no watching, Update = rebuild only). |
| `workdir` | yes | — | Local checkout of the repo on the host. |
| `envFile` | no | `.env` | .env file path, relative to `workdir`. |
| `branch` | no | `main` | Branch to watch and deploy. |
| `composeFile` | no | `docker-compose.yml` | Compose file, relative to `workdir`. |
| `projectName` | no | = id | Compose project name (`-p`). |
| `port` | no | null | Registered main port. While the app runs, the dashboard's Port link follows the **actual** published port (from `compose ps`); when stopped it falls back to this value, marked "(expected)". If the two disagree, the card links to the actual port and flags this one as stale (`⚠ registered: …`). The status API reports this as `effectivePort` / `portSource` (`actual` \| `configured`) / `portMismatch` alongside the raw `port`. |
| `autoDeploy` | no | false | Master switch for automatic deployments. |
| `pollIntervalSec` | no | 120 | Poll interval per app, in seconds. |
| `trigger` | no | `commit` | Auto-deploy source: `commit`, `actions`, `both`, or `manual` (nothing automatic). |
| `workflow` | no | _(any)_ | For `actions` triggers: workflow name or file name to watch (e.g. `ci.yml`); empty = any workflow. |
| `actionsEvent` | no | `push` | For `actions` triggers: run event to watch. |
| `provider` | no | `builtin` | Deploy provider (only `builtin` in v1). |

Environment variables for the manager itself:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `9000` | Listen port. Under Docker it is set from `MANAGER_PORT` by the manager's compose file; with plain `npm start` it falls back to `MANAGER_PORT` in the root `.env` when `PORT` itself is unset. |
| `MANAGER_PORT` | `9000` | The manager's own dashboard port in the root `.env` (copy `.env.example` to `.env`): drives the host port, container port and `PORT` in the manager's docker-compose.yml, and the `npm start` fallback above. After changing it, re-run `docker compose up -d`. |
| `CONFIG_PATH` | `./config/apps.json` | App registry location. |
| `DATA_DIR` | `./data` | `deployments.jsonl`, .env backups, trigger state, dynamic env layers (`dynamic/`), generated compose overrides (`overrides/`), in-use env snapshots (`in-use/`). |
| `APPS_ROOT` | `./apps` | Add App clones new repos into `APPS_ROOT/<id>`. |
| `BROWSE_ROOT` | _(unset)_ | Start directory of the Add Project folder picker (also its "Projects root" shortcut). Under Docker it is set from `HOST_PROJECTS_DIR` by the manager's compose file; unset, the picker starts at the filesystem root. If it is set but the folder does not exist, the picker falls back to the filesystem root. |
| `HOST_PROJECTS_DIR` | _(unset)_ | Root-`.env` variable for the manager's own docker-compose.yml (not read by the server directly): the host folder holding your projects. Compose mounts it into the manager container at the same absolute path and points `BROWSE_ROOT` at it, so the folder picker opens there. See "When your project folder does not show up in the picker" below. |
| `MANAGER_USER` | `admin` | Basic auth user (only with a password). |
| `MANAGER_PASSWORD` | _(unset)_ | When set, Basic auth protects **all** routes. |
| `GITHUB_TOKEN` | _(unset)_ | Token for the GitHub Actions API. Required for private repos; raises the rate limit for public ones. |
| `GITHUB_API_URL` | `https://api.github.com` | API base override (GitHub Enterprise, or tests). |
| `LLM_BASE_URL` | _(unset)_ | Base URL of an OpenAI-compatible chat completions endpoint for the port scan's AI check (e.g. `https://api.openai.com/v1`). Under Docker it comes from the root `.env` via the manager's compose file; with plain `npm start` it falls back to the root `.env` when the variable itself is unset. The AI check is enabled when this and `LLM_MODEL` are both set. |
| `LLM_API_KEY` | _(unset)_ | API key for that endpoint. Optional (local endpoints may not need one). Used server-side only — never returned by any API, logged, or written to disk. |
| `LLM_MODEL` | _(unset)_ | Model id for the AI check (e.g. `gpt-4o-mini`). |

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

## Adding projects from the dashboard

The dashboard has three pages — **Apps**, **Activity**, and
**Add Project**. The Add Project page offers two ways in; both take
an optional name, branch, port, trigger mode, workflow filter, and
the auto-deploy flag, and both append to the registry
(`CONFIG_PATH` is rewritten atomically, and the new app is polled
immediately, no restart).

**From GitHub** — paste a repo URL. The server then:

1. derives the app id from the repo name (slugified, de-duplicated),
2. clones the repo into `APPS_ROOT/<id>` (`git clone --branch`),
3. looks for a compose file (`docker-compose.yml`, `compose.yml`,
   or `compose.yaml`) in the repo root,
4. registers the app with `source: "clone"`.

**From a local folder** — give the path of a folder that already
exists on the machine. It is registered **in place**
(`source: "local"`, workdir = the folder itself): nothing is
copied, moved, or cloned. The form's **Browse…** button opens a
folder picker (`GET /api/browse`, behind the same Basic auth)
that walks the directories the manager itself can see — a web
page cannot open the OS file dialog, and a folder that was never
mounted into the manager container simply does not appear in
the picker. Each folder is probed as you browse (git repository?
GitHub remote? compose file?), so its status is visible before
you add it. The path must be a full absolute path —
`~` is not expanded — and when the manager itself runs in Docker
the folder must be mounted into the manager container at that same
absolute path (see the volumes comments in the manager's
`docker-compose.yml`), or registration fails with a "local folder
not found" error that says exactly that. The server detects the
compose file the same way, and:

- If the folder is the root of a git repository, its
  `remote.origin.url` is read and stored as the app's `repoUrl`,
  and the checked-out branch becomes the tracked branch (the form
  can override it). GitHub remotes are recognized in both
  `git@github.com:owner/repo.git` and
  `https://github.com/owner/repo(.git)` shapes. Such an app is
  indistinguishable from a cloned one afterwards: commit polling,
  **GitHub Actions watching**, and pull-based deploys all work,
  because they key off `repoUrl`, not off how the app was added.
  (A folder merely nested inside some other repo does not count —
  the folder itself must be the repository root.)
- Auto-deploy against a local folder pulls and rebuilds **in that
  folder**, under the same safety rule as everywhere else:
  `git pull --ff-only` — uncommitted changes are never overwritten,
  and a conflicting pull fails the deployment instead.
- **Port detection** (`POST /api/apps/scan-port`): picking a
  folder (or pressing **Detect port**) scans it for the port to
  prefill — the compose file's published `ports:` mappings (short
  and long syntax; `${VAR}` / `${VAR:-default}` resolved against
  the project's own `.env`), Dockerfile `EXPOSE` lines, and
  `.env` keys whose name contains `PORT`. Compose findings are
  ground truth and come first. When an LLM is configured (below),
  an AI check reviews a compact material pack — the compose file,
  Dockerfile, `package.json`, **only** the PORT-keyed `.env`
  entries, a README excerpt, and an entry-file excerpt — and can
  add ports the rules missed (e.g. hard-coded in code), each with
  its evidence. The result only ever *prefills* the Port field;
  it is never locked.
- If the folder is not a git repo, or the repo has no `origin`
  remote, the app registers with `repoUrl: null` and a warning on
  its card: nothing can be watched or pulled, **Update** degrades
  to a rebuild only (`docker compose up -d --build`, with the git
  steps skipped and the deployment record noting
  "no remote — rebuild only"), while Start / Stop / Restart /
  Logs / Environment work as usual.

Registration is **warning-based**: if the clone fails or no compose
file is found, the app is still registered and the card shows the
reason as a warning. Fix the problem, then use Check now / Update;
or remove the app with the card's **Remove** button. Removal only
touches the registry — the workdir stays on disk. The API also
supports `DELETE /api/apps/:id?purge=1`, which additionally deletes
the workdir, but only for cloned apps whose workdir lives inside
`APPS_ROOT`; for local-folder apps purge is always refused, so a
user's own directory can never be deleted through the manager (the
dashboard never purges).

Because adding projects rewrites the registry, the config mount in
the Docker setup is read-write.

### When your project folder does not show up in the picker

The folder picker only lists directories the manager process can
see. When the manager runs in Docker, a host folder that was never
mounted into the manager container does not appear at all — opening
the picker and not finding `/Users` (or your home folder) almost
always means the mount is missing, not that the picker is broken.

The fix is one variable in the manager's root `.env` (copy
`.env.example` if you have not already):

```sh
HOST_PROJECTS_DIR=/Users/you/Files/Project
```

With it set, the manager's `docker-compose.yml` mounts that folder
into the container **at the same absolute path**, and the picker
opens right at it (a "Projects root" shortcut chip appears next to
"Filesystem root"; where the picker starts is the `BROWSE_ROOT`
environment variable, which the compose file points at
`HOST_PROJECTS_DIR`). Then recreate the container:

```sh
docker compose up -d
```

A plain `docker compose restart` is **not** enough — restarts do
not apply new mounts; the container has to be recreated, which
`up -d` does when the configuration changed. To mount several
unrelated folders, add same-path volume lines for each of them in
`docker-compose.yml` (see the commented examples in its volumes
section); `HOST_PROJECTS_DIR` covers the common one-parent-folder
case.

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

## .env: static, dynamic, and currently in use

Each app card has an **Environment** button. The panel has three
sections, top to bottom:

### Currently in use

The effective environment of the most recent deployment, one row
per key: value (masked unless **Show values** is on) and a source
tag — `static` or `dynamic`; a static key shadowed by a dynamic
override is flagged as such. The header names the deployment that
put it in effect (time + trigger). Before any deployment has
applied overrides, it shows the static layer alone, labelled
"static values only". The key set and sources are persisted at
deployment time (`DATA_DIR/in-use/<appId>.json`, key names and
sources only — no values), so the view survives manager restarts;
values themselves are resolved live from the two layers below.

### Static — from the app repo's .env

The file at `<workdir>/<envFile>`, owned by the repo:

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

### Dynamic — overrides for deployments

Overrides kept by the manager at `DATA_DIR/dynamic/<appId>.json`
(key/value pairs, edited in the same table style). They are applied
**at deployment time only** — manual Update, commit-poll and
GitHub-Actions auto-deploys, and env redeploys. Start / Stop /
Restart never apply them; editing the dynamic layer changes nothing
until the next deployment.

How a deployment applies them:

1. The manager discovers the project's services with
   `docker compose config --services`.
2. It (re)generates `DATA_DIR/overrides/<appId>/docker-compose.manager.json`
   (JSON is valid compose) setting `environment:` for every service
   from the dynamic entries, and passes it to `docker compose` as an
   extra `-f` file for the `up` and `ps` steps. Containers therefore
   really receive the dynamic values — and per compose semantics
   `environment:` also wins over `env_file:` for the same key —
   while the repo's `.env` file stays byte-for-byte untouched.
3. The deployment record notes the applied override **key names**
   (`dynamicKeys`, shown in the Activity detail as "Dynamic
   overrides applied: …") — never values. If the override cannot be
   prepared, the deployment fails at its "apply dynamic env" step
   instead of silently deploying without the overrides.

## Security — read this

- **Mounting `/var/run/docker.sock` gives the manager root-equivalent
  control over the host.** Treat the dashboard accordingly: LAN only,
  never expose it to the internet, and always set
  `MANAGER_PASSWORD` in real deployments.
- **.env files usually contain secrets.** Only edit them through the
  dashboard when `MANAGER_PASSWORD` is set (otherwise anyone on the
  LAN can read and change them via the env endpoint). Env **values**
  are returned only by the dedicated env endpoints; they are never
  written to server logs or deployment records (only key names
  are). They do live in `DATA_DIR` by design — the static backups
  under `DATA_DIR/backups/`, the dynamic layers under
  `DATA_DIR/dynamic/`, and the generated compose overrides under
  `DATA_DIR/overrides/` all contain values — so protect `DATA_DIR`
  like a secrets directory.
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
  NDJSON output shapes are handled, and non-JSON warning lines in
  the output are skipped, but exotic compose versions may differ.
  If a status check itself fails, the card shows the error and the
  time of the last check instead of silently reporting "unknown".
- Start/Stop/Restart are fire-and-forget compose calls; they are
  recorded in the activity history as action records, but unlike
  deploys they carry no per-step breakdown.
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
Later phases cover the real Compose v2 `ps` output shapes, the
action journal, the Activity tag structure, and the dynamic env
layer end to end (override file generated and passed to compose,
static file untouched, in-use view correct and persistent, failed
deployments naming their failed step).
A second phase swaps in a **mock GitHub API** server and verifies
the Actions trigger end to end: run parsing, the baseline rule, a
successful run deploying, a failed run not deploying, no
re-triggering after a restart, commit-triggered apps being
unaffected — plus Add App (clone, registry persistence, warnings)
and DELETE / purge. A further phase covers **local folder
projects**: registration in place with repoUrl/branch detection
from a GitHub origin, Actions-triggered deploys into the local
folder, the diverged-checkout failure semantics (pull fails,
working tree untouched), no-remote folders (registration warnings,
rebuild-only Update), and removal safety (purge refused, folders
never deleted).

```sh
npm run test:e2e
NODE_PATH=/tmp/pptr/node_modules node tests/screenshot.mjs   # dashboard screenshots
```

What this does **not** verify (needs a real Docker machine): actual
`docker compose ps` output from a live daemon, real image builds,
and the socket-mount path behaviour in the manager's own container.
