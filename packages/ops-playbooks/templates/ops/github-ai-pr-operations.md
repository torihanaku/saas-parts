# GitHub AI PR Operations

## Goal

AI-authored PRs should move through review and merge queue with minimal manual sorting while `main` remains protected by server-side checks.

## Operating Model

- Use `automerge/eligible` only for low-risk AI branches such as `codex/*`, `claude/*`, `gemini/*`, or `ai/*`.
- Use `queue/hold` or `risk/high` whenever a PR changes workflow, hook, agent handoff, secret, config, or migration paths.
- Keep required checks compatible with both `pull_request` and `merge_group` before adding them to `main-protection`.
- Prefer squash auto-merge so each AI PR lands as one readable unit.

## Rollout

1. Merge the workflow/policy changes.
2. Confirm `agent-handoff-guard`, `lint-and-build`, security, review, and base checks all appear on `merge_group`.
3. Add `agent-handoff-guard` to the ruleset required checks.
4. After observing `pr-fast-check` for several PRs, move full coverage from per-PR required checks to merge queue/nightly only.
5. Keep auto-queue label-gated until the false-positive rate is boringly low.

## Repository Settings

- Squash merge is the standard merge method.
- Merge commits and rebase merges stay disabled so AI-authored PR history remains one PR = one main commit.
- Auto-merge, update branch, and delete branch on merge stay enabled.
- Do not add a workflow to required checks until that workflow runs on `merge_group`.
