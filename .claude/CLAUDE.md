# Git Workflow Rules

## After a PR is merged, always create a fresh branch

Never push additional commits to a branch whose PR was already merged. Always create a fresh branch from `origin/main` for follow-up work:

```bash
git fetch origin
git checkout -b <new-descriptive-branch> origin/main
```

Use a descriptive name for the new branch (e.g. `fix/state-branch-auth` rather than reusing `feat/stable-chain-sync`).

## Never add a test plan to PR descriptions

When creating a PR with `gh pr create`, omit the `## Test plan` section entirely. Only include the summary of changes.
