# How work happens in Bearpaw

This describes how a change gets filed, labelled, built, documented and
released. It exists because the v1.1 cycle ended in a scramble, and the
investigation into why produced a short answer: the rules were not missing —
`CLAUDE.md` runs to hundreds of lines of them — but two questions had no cheap
answer, and one fact had two possible homes.

Every rule below names the check that enforces it. A rule with no check is a
hope, and this document is not a place for hopes.

## The principle: one home per fact

Every question this process must answer has exactly one object that answers it.
Where two objects could answer the same question, one of them is deleted.

| Question | The one home |
| --- | --- |
| What kind of change is this, and how bad? | Labels — one value per axis |
| What is in this release? | The milestone |
| Where is this right now? | The project board |
| What changed for a user? | `CHANGELOG.md`, under `[Unreleased]` |
| Is this branch finished? | It does not exist — merged branches are deleted |

## 1. File an issue first

**Every pull request links an issue.** The issue carries the labels, the
severity and the milestone; the pull request points at it with a closing
keyword — `Fixes #123`.

This is what makes "is someone already fixing this?" answerable, and it is what
keeps a release scope query from missing work.

Use a template — <https://github.com/jeremyfuksa/bearpaw/issues/new/choose>.
Blank issues are turned off on purpose: each template applies its own type
label and asks for the fields that were missing last cycle, so the correct
label is the default rather than something remembered.

> *Enforced by:* `PR Preflight` checks for a closing keyword in the pull request
> body. Advisory.

## 2. Label it on exactly four axes

| Axis | How many | Values |
| --- | --- | --- |
| **type** | exactly one | `bug`, `feat`, `docs`, `chore` |
| **area** | one or more | `rust`, `frontend`, `protocol`, `ci`, `security`, `accessibility`, `site` |
| **severity** | required on `bug`, absent otherwise | `severity: high`, `severity: medium`, `severity: low` |

Severity means: **high** — data loss, a security boundary failure, or
equivalent. **medium** — a real functional or reliability problem that has a
workaround or a narrower trigger. **low** — polish, test reliability, or
documentation.

There is deliberately **no release label.** The milestone already says which
release something is in, and a second home for that fact is exactly the defect
this document exists to prevent.

Dependabot writes its own labels (`dependencies`, `javascript`,
`github_actions`). Leave those alone.

> *Enforced by:* `PR Preflight` checks for exactly one type label. Advisory.

## 3. Put it in a milestone

One milestone per release, named for the tag: `v1.1.0`, `v1.2.0`. Every issue
and every pull request gets one.

**No milestone means the item is not in a release.** That is the whole
definition — there is no other list.

If something turns out not to be needed for the release it is in, move it to
the next milestone. Deferring is a decision you record, not one you make by
letting a tag go out with the work still open.

> *Enforced by:* `PR Preflight` checks that a pull request has a milestone
> (advisory). The **release gate blocks a tag whose milestone has open items** —
> see step 8.

## 4. Track it on the board

The `Bearpaw` project board has one Status field: **Inbox → Ready → Doing → In
review → Done.** New issues arrive in Inbox; merged pull requests move to Done.

**The board is a view, not a source of truth.** Its data lives outside the
repository and cannot gate CI. Where the board and the milestone disagree, the
milestone wins.

## 5. Branch

Off `main`, never off another unmerged branch. Prefix with the type:
`fix/`, `feat/`, `docs/`, `chore/`, `ci/`, `cleanup/`, `phase/`.

Merged branches are deleted automatically (`delete_branch_on_merge` is on). Do
not turn that off. Sixteen undeleted branches were the entire reason the 1.1
cycle felt like work had been lost — fifteen of them held nothing that was not
already on `main`, and the sixteenth belonged to a pull request that had been
closed on purpose. Nothing was lost. There was just no cheap way to see that.

## 6. Keep it small and single-purpose

One concern per pull request, independently revertible, reviewable in under ten
minutes. Past roughly 250 lines, split it — unless the change is mechanically
uniform (a rename across many files) or splitting would create a non-functional
intermediate state, in which case say so in the description.

If you spot unrelated mess while working, file it. Do not fix it here.

## 7. Write the changelog entry in the pull request that earns it

A `bug` or `feat` change adds its own entry to `CHANGELOG.md` under
`[Unreleased]`, in plain language, describing what a **user** will notice —
not what the code now does.

Do not save this for release time. Reconstructing the changelog at the end is
how five user-visible 1.1 fixes went unrecorded. A `docs` or `chore` change is
exempt, because by definition a user notices nothing.

> *Enforced by:* `PR Preflight` checks that a `bug` or `feat` pull request
> touched `CHANGELOG.md`. Advisory.

## 8. Green before push, then merge deliberately

All five checks pass **locally** before you push. Never push to retry CI.

```bash
cd frontend
npm run format:check && npm run lint && npm run type-check && npm test -- --run
cd ..
cargo test -p bearpaw-api --lib
cargo fmt --all -- --check
cargo check --workspace --all-targets
```

`cargo check --workspace --all-targets` needs `frontend/dist` to exist — in a
fresh checkout run `npm ci && npm run build` first, or the Tauri crate dies in
`generate_context!` with a panic that reads like a Rust regression and is not
one.

Auto-merge is **off** on this repository, and `--auto` does not fail cleanly
when it is off — it silently merges immediately. Never pass it. Wait for the
checks, confirm, then `gh pr merge <n> --squash`.

## 9. Release

Run this first — it answers "are we ready?" without archaeology:

```bash
python3 scripts/release_status.py
```

It reports the declared version, whether the preflight passes, whether the tag
exists, the milestone state, anything still sitting under `[Unreleased]`, and
any remote branch that is fully merged and undeleted.

Then work through [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) and push the
tag. The tag-triggered preflight in
[`build.yml`](../.github/workflows/build.yml) **blocks the build** when:

- the release's milestone is missing, or still has open items;
- `CHANGELOG.md` has no section for the tag;
- any of the six version sources disagrees with the tag;
- the user guide is outside its readability ceiling.

These block rather than advise because a tag is the one action that is hard to
take back.

## Why the per-pull-request checks do not block

`PR Preflight` is deliberately **not** a required status check, and must not
become one. A required check that never runs never reports, which makes a pull
request permanently unmergeable rather than fast — Dependabot and fork pull
requests are exactly the cases that would hit it. This repository has already
paid that cost once; the note lives at the top of
[`tests.yml`](../.github/workflows/tests.yml).

So the per-pull-request checks fail a visible check you can look at and
override. The release gate, where the cost of being wrong is a published
artifact, blocks.

## When a rule here disagrees with reality

Follow the code, and say so. Every rule in this repository's documentation was
true when it was written; some stopped being true without anyone editing the
sentence, and a stale *procedure* is more dangerous than a stale *fact* because
a procedure gets followed rather than read.

Before acting on a documented step that depends on a repository, service or
tool setting, **check the setting.** Docs are evidence; the API is truth.
