# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/konongxyz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/konongxyz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An original, dependency-free GitHub-compatible git forge in Node 22 (standard library only): real git objects in memory, GitHub REST v3, git smart-HTTP (protocol v2 and v0), GraphQL v4 and MCP surfaces. Passes the kit's full 120-check conformance suite.

## Run it

```sh
node main.ts   # with MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN set
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9m688dgh&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

An original, dependency-free implementation of a GitHub-compatible forge,
written for the make.fun `github-core-clone-01` bounty. It runs on Node 22
(standard library only: `node:http`, `node:crypto`, `node:zlib`) and keeps
every repository in memory as real git objects (SHA-1 blobs, trees, commits
and annotated tags in the genuine git object format).

## What it serves

- **Lifecycle** — `main.ts` binds an ephemeral port, registers it with the
  env at `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done`
  until the trial ends. The HTTP application itself lives in `app.ts`.
- **GitHub REST v3** under `/api/v3/` — repositories (create, read, update,
  delete, list with `Link` pagination), branches and git refs, commits,
  contents (create/update/delete files, directory listings), labels,
  issues with comments, and pull requests (list, files diff, squash merge
  with three-way conflict detection). Every reply is JSON and carries an
  `X-GitHub-Request-Id` header; the bearer token in
  `$MAKEFUN_SHOP_TOKEN` is required on every API route.
- **Git smart HTTP** at `/<owner>/<repo>.git/…` — `info/refs`,
  `git-upload-pack` and `git-receive-pack` implemented from scratch:
  protocol v2 (`ls-refs` with server-side ref-prefix filtering and unborn
  HEAD, `fetch` with shallow/deepen semantics and incremental packs) plus
  the v0 advertisement/fetch fallback, and pushes with fast-forward
  enforcement and `report-status` replies. No git binary is involved on
  either side.
- **GitHub GraphQL v4** at `/api/graphql` — a small executor for the
  documents `gh` and `github-mcp-server` actually send: `viewer`,
  `repository`, `node(id:)`, `__type` introspection, issue/pull-request
  connections with cursor pagination, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` mutations,
  including batched operations.
- **MCP** at `/mcp` — Model Context Protocol over streamable HTTP
  (`server/discover`, `initialize`, `tools/list`, `tools/call`) with tools
  for repositories, issues and pull requests whose effects are the same
  objects the REST API serves.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait, exit).
- `app.ts` — the whole forge: object store, pack reader/writer, the REST,
  git, GraphQL and MCP surfaces.

## Running it

The platform runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN` in the environment. There is no install step and no
dependency to fetch.
