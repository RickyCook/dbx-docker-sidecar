# dbx-docker-sidecar

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

### dbx integration

The dbx Web API contract, auth/session quirks, and gotchas discovered while building the client. See `docs/agents/dbx.md`.

### Docker integration

dockerode/compose quirks (inspect validation, event streams, container naming). See `docs/agents/docker.md`.
