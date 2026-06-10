# Upstream PR-train prioritization (COD-27)

How the downstream fork decides **which local-only change to upstream next**. Tracked under
Jira **COD-27** ("Plan and deliver upstream PR train for downstream Codeman changes"); each
subissue (COD-28…COD-77) is one focused upstream PR.

The ordering objective is **not** feature value — it is **minimizing future merge-conflict
cost.** Every unmerged subissue is local-only code carried on top of `upstream/master`. The
longer it sits, the more chances upstream has to edit the *same files*, and each such edit is
a conflict we hand-resolve on the next sync (the 2026-06-10 sync resolved 10). So:

> **Priority = how actively upstream is changing the files this PR touches.**
> Hot files → conflict magnets → upstream sooner.

## The metric: recency-weighted churn (14-day half-life)

Flat "commits per year per file" is misleading: a file hot last year but quiet now
*over-ranks*; a file surging this week *under-ranks*. Instead, weight each upstream commit
that touched a file by an **exponential time-decay**, then sum per file:

```
weight(commit) = 0.5 ** (age_in_days / 14)
file_score     = Σ weight(commit) over commits in the last 365 days that touched the file
```

A **14-day half-life** means: a commit today counts `1.0`, two weeks ago `0.5`, a month ago
`0.25`, three months ago `~0.01`. It emphasizes the last ~2 weeks while retaining a couple
months of signal.

### Run it

```bash
git fetch upstream
node scripts/pr-train-churn.mjs            # top 25, ref=upstream/master, half-life 14d
node scripts/pr-train-churn.mjs --top 40   # see more / tune --half, --window, --ref, --paths
```

Output columns: `decayed` (the score), then raw `14d / 90d / 365d` commit counts for sanity.

## Turning scores into a subissue priority

1. **Find each subissue's delta files:** `git diff upstream/master...local --numstat` (after a
   clean merge the merge-base is `upstream/master`, so this is the full downstream delta).
   Confirm a file is still local-only with `git cat-file -e upstream/master:<file>`.
2. **Score the subissue = max decayed score across the files its delta touches.** Critically,
   look at the **wiring files, not just the headline new files.** A feature's new files are
   usually cold (upstream has no version of them, so they can't even conflict), but the
   `server.ts` / `app.js` / route file it wires into may be the hottest file in the tree.
3. **Map score → `priority`:**
   - **High** — touches a top-of-table file (conflict magnet).
   - **Medium** — moderate-churn wiring, or small touches to a hot file.
   - **Low** — predominantly net-new isolated files on cold paths (can't conflict).
4. **Adjust for dependencies** — the Jira `Blocks` / `is blocked by` links override raw score
   (a High PR blocked by another can't go first).
5. Set the Jira `priority` field; record the run as a comment on **COD-27**.

### Two rules of thumb

- **Net-new files are cheap to defer.** No upstream counterpart ⇒ no conflict, regardless of
  diff size. (A huge diff on a cold file beats a tiny diff on `app.js`.)
- **Score the wiring, not the feature.** The 2026-06-10 run is the cautionary tale: the
  attachment cluster (COD-37/38/39) looked Low on flat churn because its new files are cold —
  but its `server.ts` wiring sits on the **single hottest file** (17 commits in 2 weeks), so it
  was re-ranked up. `session.ts`, hot historically, had cooled and dropped.

## When to re-run

**After every upstream sync.** Recompute the delta, revalidate subissues (close any whose PR
merged; check `git merge-base --is-ancestor <pr-merge-sha> upstream/master`), add subissues for
any unmapped local-only delta, and re-run this metric to reprioritize. Record the result on
COD-27.

## Snapshot — 2026-06-10 (post upstream `e1f611b` sync)

Top decayed files: `server.ts` 18.46 (17/2wk), `app.js` 13.39, `index.html` 11.41,
`styles.css` 9.59, `terminal-ui.js` 9.49, `session-routes.ts` 9.14, `settings-ui.js` 8.73,
`tmux-manager.ts` 7.49, `session.ts` 6.60, `auth.ts` 4.53.

Board: **High** COD-34/35 (codex), COD-37 (attachment pipeline), COD-40 (response viewer) ·
**Medium** COD-38/39 (attachments), COD-77 (doctor), COD-71 (misc UX), COD-36 (gemini) ·
**Low** COD-41 (away digest). Open item: the COD-54/55 security hardening (hook-secret /
tunnel guard) touches the three hottest files but has no subissue yet — pending a #113-overlap
check.
