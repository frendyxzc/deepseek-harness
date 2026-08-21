# dsh-gitlab-mr — GitLab MR closed loop for intranet DSH

English | [中文](README.zh.md)

Under self-hosted/intranet deployment, use "outbound = git (SSH) + glab (PAT) + skill, inbound = polling plugin + MR registration tool" to run the
"change code → create independent branch → commit → push → create MR → register tracking → respond to comment-thread rework → merge MR → distill experience" loop,
with no public callback URL, no Composio, and no MCP integration.

Two assets:

| File | Purpose |
|---|---|
| `gitlab-mr-poller.mjs` | Function plugin: provides the `gitlab_watch_mr` registration tool + polls registered MRs in the background, detects new comments (filtering bot authors) and merged/closed, and wakes the owning session with `agent.followup()` |
| `gitlab-mr-workflow/SKILL.md` | Agent outbound SOP: git/glab commands, MR rules, comment-reply rules, and the post-merge distillation template |

**Registration-based (no manual session binding needed)**: after the agent creates an MR, it calls `gitlab_watch_mr` once; the plugin persists the
"current session ↔ MR" binding together with the cursor watermark; afterwards new comments / merges on that MR automatically wake
**the session that created it**, even after restart (stored in a state file).

## 0. One-click install (recommended, via setup-dsh)

Integrated into [`scripts/setup-dsh/setup.sh`](../scripts/setup-dsh/setup.sh): supplying a bot username enables it
(interactive prompt, or set `DSH_GITLAB_BOT_USERNAME` / `DSH_GITLAB_API_BASE` / `DSH_GITLAB_TOKEN`),
and it automatically completes all three steps of §1–§3 below (skill → plugin mount → token written to `.env`). See
[the GitLab section of the setup-dsh README](../scripts/setup-dsh/README.md#gitlab-mr-integration-optional).

```sh
./scripts/setup-dsh/setup.sh          # interactively answer GitLab bot username / apiBase / PAT
# or one key:
DSH_GITLAB_BOT_USERNAME=dsh-agent \
DSH_GITLAB_API_BASE='https://gitlab.example.com/api/v4' \
DSH_GITLAB_TOKEN=glpat-... \
  ./scripts/setup-dsh/setup.sh --non-interactive
```

## 1. Install the skill (manual deployment)

```bash
# project-level (goes into git) or user-level (machine-wide), choose one
cp -R gitlab-mr-workflow /path/to/project/.agents/skills/
cp -R gitlab-mr-workflow ~/.dsh/skills/
```

## 2. Mount the poller plugin

`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: gitlab-mr
      name: /absolute/path/to/gitlab-mr-poller.mjs
      config:
        apiBase: 'https://<your-gitlab-domain>/api/v4'   # self-hosted instance
        botUsername: dsh-agent                         # the bot's GitLab username
        pollIntervalMs: 300000                         # 5 minutes
```

## 3. Environment variables

```bash
export GITLAB_TOKEN=<bot account PAT>   # scope at least api (read MR/comments; agent writes via glab need write scope)
```

The poller resolves the token through DSH's `ctx.credentials` first (referenced by `tokenEnv`), falling back to the same-named environment variable. The token is never written to configuration.

## 4. Registration mechanism (replaces manual session binding)

After the agent runs `glab mr create` in a session, it calls the tool:

```
gitlab_watch_mr(project="group/repo", mrIid=123)
```

The plugin takes the current session id from `exec.agent.id`, reads the MR's current latest comment id as the watermark
(historical comments are not replayed), and writes `{ MR → sessionId → cursor }` into the state file. Afterwards:

- A **new comment** on the MR (non-bot author, non-system note) → immediately wakes this session.
- The MR is **merged** → wakes the session for "distillation" and removes it from tracking.
- The MR is **closed** → wakes the session with a stop notice and removes it from tracking.

If the session is closed / not yet resumed after registration, the poller skips delivery but **keeps the registration and does not advance the cursor**, delivering on the next poll cycle after the session returns, so no event is lost.

## 5. Configuration fields

| Field | Default | Description |
|---|---|---|
| `tokenEnv` | `GITLAB_TOKEN` | token source |
| `apiBase` | `https://gitlab.com/api/v4` | change the domain for self-hosted |
| `botUsername` | — (required) | loopback filter: comments authored by it are not delivered |
| `pollIntervalMs` | `300000` | poll interval (minimum 10s) |
| `stateFilePath` | `.dsh-gitlab-mr-state.json` | registration/cursor persistence file (relative to `$DSH_HOME`) |
| `perPage` | `100` | comments fetched per request |

## 6. Semantics and limits

- **Only registered MRs are tracked**: never scan the project's full opened-MR set, avoiding disturbing unrelated MRs and mis-delivering someone else's MR to your session.
- **Watermark set at registration**: first registration only records the "current latest comment id"; historical comments are not replayed.
- **Loopback debounce**: comments by `botUsername` and `system` notes are not delivered, but the watermark still advances to prevent duplicate triggers.
- **Merged/closed means stop**: on `merged`/`closed` it is removed from tracking; `merged` additionally injects a "distillation" message.
- **Kept when the session is not running**: when the bound session is offline, skip delivery, do not advance the cursor, and do not remove the registration; deliver on the next cycle after recovery.
- **Single-machine state file**: the cursor is in-process JSON, suitable for a single intranet instance; multiple replicas need shared storage.
- **Loading constraint**: the local `.mjs` is a bare plugin; if `verify-cordis-config` reports an undeclared dependency, add it to your profile's resolver manifest `dependencies`, or wrap it in your own bundle and reference it by name.

## 7. Quick verification

1. Start DSH; the log shows `[gitlab-mr] started …`.
2. Have the agent run "create branch → commit → `glab mr create`" on a repository, then call `gitlab_watch_mr`.
3. Post a comment on the MR from a non-bot GitLab account.
4. After one poll cycle (≤5 minutes), the agent session should receive `【GitLab MR comment】…` and be woken; after merging the MR it receives `【GitLab MR merged】…` and is woken for distillation.
