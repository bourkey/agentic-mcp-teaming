# Consumer Workflow — Reference Example

These files document the full opsx workflow as implemented in a consumer project (`generic-consumer`). They serve as the reference design for how any project consuming the MCP coordinator should structure its change lifecycle.

## What this is

A consumer project runs multi-agent work across three area panes (frontend, backend, misc), each in its own git worktree. The coordinator peer bus ties the panes together — change events flow automatically without manual coordination.

## Stage sequence

```
propose → worktree → review (--artifacts) → apply → review (--implementation) → archive → ship → merge
```

| Stage | Command | Pane | Description |
|-------|---------|------|-------------|
| 1 | `propose` | main | Create change proposal + design + spec + tasks |
| 2 | `worktree` | main | Set up feature branch + worktree for the area |
| 3 | `review --artifacts` | area | Multi-agent review of spec/design before coding |
| 4 | `apply` | area | Implement all tasks in the change |
| 5 | `review --implementation` | area | Multi-agent review of implementation |
| 6 | `archive` | area | Move change artifacts to archive, finalize |
| 7 | `ship` | area | Push branch + open PR |
| 8 | `merge` | main | Squash merge, rotate worktree to next change |

Supporting commands (can run any time):
- `draft` — capture a change idea from a worktree pane and hand it to main
- `status` — dashboard of active worktrees, stages, and queue
- `sync` — rebuild `todos.md` from GitHub issues + git state

## Peer bus integration

Each stage emits events on the peer bus so idle panes wake automatically:

| Event | Emitter | Recipient |
|-------|---------|-----------|
| `worktree-ready` | `worktree` on main | area pane |
| `ship-ready` | `ship` on area pane | main |
| `rebased` | `merge` on main | each area pane |
| `slot-freed` | `merge` on main | main |
| `todos-updated` | `sync` on main | all panes |

## Files

- `draft.md` — capture idea from worktree, write to `openspec/drafts/`
- `worktree.md` — set up feature branch + handle priority inversion + paused-branch logic
- `review.md` — multi-agent iterative review loop (artifacts or implementation mode)
- `ship.md` — push branch + open PR + emit `ship-ready`
- `status.md` — read-only dashboard from `todos.md`
- `sync.md` — rebuild `todos.md` from GitHub + git + emit `todos-updated`
- `merge.md` — squash merge + priority compaction + worktree rotation + paused-branch resume

## Adapting to a new project

1. Copy `.claude/commands/opsx/` from this reference into the consumer project
2. Replace `generic-consumer` in path references with the consumer project name
3. Ensure `scripts/install-hooks.sh` exists in the consumer project (used by `worktree`)
4. Set `COORDINATOR_SESSION_NAME` in the launcher so peer-bus emits fire
5. Register each area pane with `autoWakeKey: "claude-inbox"` on the coordinator
