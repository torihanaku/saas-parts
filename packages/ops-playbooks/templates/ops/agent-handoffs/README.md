# Agent Handoffs

Write per-branch handoff notes here instead of appending feature work logs to
`AGENTS.md`.

## File Name

Use:

```text
<YYYYMMDD>-<branch-name-with-slashes-replaced-by-dashes>.md
```

Example:

```text
20260506-codex-benchmark-percentile-ui-20260506.md
```

## Template

```markdown
# <Branch or Task Title>

- Date: YYYY-MM-DD
- Branch: `<branch>`
- Issues / PRs: #1234, PR #5678

## Summary

What changed and why.

## Validation

- `bun run test -- ...`
- `bun run build`
- `bun run lint`

## Follow-up

Anything the next agent or operator must know.
```

Keep this directory append-only for feature work. Update `AGENTS.md` only for
stable repo rules or cross-agent operating policy.
