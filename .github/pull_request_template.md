## Summary

<!-- One to three sentences: what changed, and why. -->

Fixes #

<!-- Every PR links an issue. The issue carries the labels, the severity and
     the milestone; this PR points at it. If there genuinely is no issue,
     say so here and why. -->

## Why

<!-- The constraint or finding that prompted this. Not a restatement of the
     summary. Cite file:line, a PR number, or a wire capture. -->

## Changelog

<!-- The line a user will read, or "none — no user-visible change".
     Written here AND added to CHANGELOG.md under [Unreleased] in this PR,
     not at release time. -->

## Test plan

- [ ] `cargo test -p bearpaw-api --lib`
- [ ] `cargo fmt --all -- --check`
- [ ] `cargo check --workspace --all-targets`
- [ ] `npm test -- --run` (from `frontend/`)
- [ ] `npm run lint`
- [ ] `npm run type-check`
- [ ] `npm run format:check`
- [ ] Exercised against real hardware, or stated why that is not applicable

<!-- See docs/PROCESS.md for what has to be true before this merges. -->
