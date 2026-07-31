# COD-255 macOS SFTP listing compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display populated macOS remote workspaces in the File Viewer.

**Architecture:** Keep the SFTP transport and entry model unchanged. Make only the long-list parser tolerant of the macOS link-count token while retaining its numeric size requirement.

**Tech Stack:** TypeScript, Vitest, OpenSSH SFTP long listings.

---

### Task 1: Reproduce and correct the listing parser

**Files:**
- Modify: `test/remote-sftp.test.ts`
- Modify: `src/remote-sftp.ts`

- [ ] Write the failing test for `?` as an SFTP link-count token.
- [ ] Run `npm test -- test/remote-sftp.test.ts -t "unknown link count"` and observe the empty listing failure.
- [ ] Permit `?` in the link-count grammar without changing the numeric size capture.
- [ ] Run `npm test -- test/remote-sftp.test.ts test/routes/file-routes-remote-sftp.test.ts`.
- [ ] Commit the fix, regression, design, and plan with `fix: COD-255 parse macOS SFTP listings`.
