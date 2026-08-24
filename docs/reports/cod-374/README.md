# COD-374 Mobile Input Latency Measurement Protocol

Phase A supplies the fail-closed measurement, reconciliation, and report harness. It creates no cohort evidence and
makes no latency attribution. The frozen products remain:

- baseline `d080481690dc62ffc0d0d4f8e7daae2cc8bf8613`, tree
  `1c3e2b5aa2adad328e86d66c08f0b941f1900b1e`;
- candidate `f3851229167a5078a15ae398c006cc2756690296`, tree
  `608989a703ae9fd7ac692c41d0a2e3f733e192c3`.

The diagnostic branch, harness commit, and instrumentation overlay are not candidate product revisions.

## Attribution boundary

COD-374 publishes browser-, server-, pane-, and xterm-local durations only. It does not calibrate browser and server
clocks, subtract timestamps across clock domains, identify a first delayed boundary, or make a cross-domain causal claim.
Every valid diagnostic report says **INCONCLUSIVE ACROSS CLOCK DOMAINS**.

The harness models the Task 3 event formats directly:

- browser events retain the exact `BrowserLatencyEvent` fields, global output/write events, per-generation input and
  visibility events, output ordinals, write IDs, token hash/length, generation, and input index;
- server events retain the exact optional `MobileInputTraceEvent` fields and accept multiple upstream chunks,
  connection-specific chunks, and flush batches;
- trace-off samples contain no server collector events; trace-on samples contain the complete server trace;
- pane results bind the same token hash/length and input index, preserving every probe, status, and error hash.

The report recomputes the end-to-end browser duration, every consecutive local stage duration, pane interval and poll
cost, event and ordinal counts, server multiplicity, and correctness counts. Producer summary scalars cannot authorize a
result. Each long-task window must enclose first keydown through the selected final paint.

## Frozen overlay boundary

Only these product files may be changed by either instrumentation overlay:

- `src/perf/mobile-input-trace.ts`
- `src/session.ts`
- `src/web/routes/perf-trace-routes.ts`
- `src/web/routes/ws-routes.ts`
- `src/web/server.ts`

The verifier reads each patch once, hashes those exact bytes, applies the bytes to the frozen product through Git stdin,
and inspects `git status --porcelain=v1 -z --untracked-files=all --ignored=matching`. Added, modified, deleted, copied,
renamed, and ignored paths are all subject to the exact allowlist. Each allowlisted path must be a regular nonsymlink
file; its Git mode and content hash feed the deterministic manifest. Patch applicability or cleanup failure blocks
publication.

## Experiment lifecycle and storage

Live evidence must use a newly created, current-UID `0700` regular directory directly under resolved `os.tmpdir()`, with
a strict `cod374-*` basename, never inside the repository. Every mutation revalidates that root. The
repository must be clean and its harness, product, lockfile, and vendor objects verified by `verifyExperimentPreflight`
immediately before each launched attempt. The opaque proof returned by that verifier is required when the attempt is
published. Independent runtime probe callbacks measure the OpenCode version, viewport, font, and
server/browser/OpenCode PID plus `/proc` start identity. Process start wall time is derived from a bracketed
`/proc/uptime` measurement with recorded uncertainty rather than integer-quantized `btime`; final PID/start-tick
identities must exactly match the launch observations. The recorded start uncertainty is capped at a conservative
1000ms; larger values invalidate the evidence instead of making process/repetition overlap vacuous. Each CPU cell
retains five fixed-loop 1x samples and five
samples after the requested CDP throttle; the harness recomputes both medians and their bounded realized ratio. The
producer also records live load averages, hashes the actual tmux and temporary-root identities, derives the browser
clock from captured events, and derives server/harness clocks at runtime. An opaque one-use proof binds these
observations to the whole attempt rather than trusting caller-supplied fields.

`scripts/perf/cod-374-runner.mjs` is the Phase B producer. It materializes and verifies the exact overlay before launch,
then provisions one controlled `node_modules` symlink to the clean harness dependency root. The source must be a
current-UID real directory, the bound package-lock content hash must match, the runtime target must be absent, and the
symlink must resolve exactly before launch and again before publication. A bounded deterministic content manifest hashes
every installed package in `node_modules/.package-lock.json`, including dev browser/launcher packages such as
Playwright and the nested `tsx`/`esbuild`/platform closure, with paths, file modes, sizes, bytes, and symlink identities.
Selected symlinks must resolve inside
the exact harness repository and bind the resolved target's device, inode, relative identity, and bounded content; this
covers the installed self/workspace package links without following the `node_modules` cycle. The manifest is capped at 50,000 entries and 1 GiB and is
recomputed before launch, after launch, and before publication together with exact source device/inode identity.
`dependencyRootHash` remains a separate local infrastructure identity for the resolved path; portable dependency
provenance remains the package-lock and dependency-content hashes. This explicit
infrastructure symlink is added only after the five-file overlay manifest is verified and does not alter the frozen
product tree or overlay manifest. The runner launches from that same worktree realpath, verifies live `/proc` cwd/cmdline/start identities, hashes served `/`,
`/app.js`, and `/styles.css`, measures the browser configuration asynchronously, captures the real Task 3 artifacts,
and publishes only through the locked producer transaction. The overlay remains alive until runtime cleanup completes;
either cleanup failure is retained as an immutable rejected attempt and fatally stops the schedule.

Detached product trees also omit the ignored generated browser vendor assets. The runner parses the already hash-bound
vendor manifest as an exact 12-file allowlist, verifies every source as a current-UID regular file with bounded size,
safe mode, and exact content hash, preserves and verifies the two tracked files, and provisions only the ten absent
ignored files as individual links. It never replaces the mixed tracked/generated vendor directory. A deterministic
runtime-vendor proof binds source file identity, mode, size, and content and is recomputed before launch, after launch,
and before publication. The final SHA-256 proof is retained as `provenance.runtimeVendorHash` (plan/preflight/crash
evidence uses null because no runtime has yet been proven) and printed in the report. Unknown, duplicate, escaping,
mutated, or pre-existing ignored targets reject the attempt while leaving the product and overlay manifests unchanged.

The global schedule is fixed:

1. calibration `trace-off` repetition 1;
2. calibration `trace-on` repetition 1;
3. calibration `trace-off` repetition 2;
4. diagnostic baseline repetition 1;
5. diagnostic candidate repetition 1;
6. diagnostic candidate repetition 2;
7. diagnostic baseline repetition 2.

Each accepted repetition has 10 unfiltered samples at 1x and 4x. Tracing passes only if trace-on p95 is no more than 5ms
and no more than 10 percent worse than trace-off at both rates. Both bounds must pass before attempt 4 is permitted.

A rejected preflight may have nullable server/browser/tmux provenance and zero cells. A launched partial attempt retains
the exact completed cell/sample prefix and nullable lifecycle provenance; a completed contaminated attempt retains its
full process, cells, diagnostics, and cleanup state. Any rejected outcome stops the experiment immediately. No later
attempt and no selective retry is allowed; an invalid report is generated honestly from the attempts available.

## Evidence-source transaction

The producer transaction takes an exclusive `.cod374-experiment.lock`, reconciles before doing anything else, verifies
the next scheduled attempt, and durably publishes `inflight.json` before any producer, browser, or server launch. A dead
reservation owner is converted into an immutable rejected `producer-crash` attempt with cleanup unknown/failed, so a
crash cannot create a selective retry. The transaction publishes canonical evidence as `attempts/attempt-NNNN.json` with exclusive atomic link,
file fsync, and directory fsync. Temporary records exist only in owned `.staging`; attempt files are the source of truth.

`reconcileExperimentLedger` scans every directory entry and rejects unknown names, gaps, partial or noncanonical JSON,
symlinks, hardlinks, and special files. It validates every attempt and hash, then atomically regenerates and fsyncs the
whole `ledger.json` manifest. A crash after evidence publication leaves an orphan that the next mandatory reconciliation
discovers. A crash before the link or after the link but before staging unlink is recovered idempotently. A crash after
ledger regeneration is also idempotent. Locks bind PID plus Linux process-start identity: a live owner
blocks concurrent writers, while a lock left by a proven-dead process is safely reclaimed before reconciliation.
Report, finalizing, finalized, lock, reclaim, reservation, and attempt publications all recover owned stage-only and
target-plus-stage hardlink crash states before reading their targets.

The summarizer reconciles again and proves that the ledger lists every attempt file with no extras before validating the
schedule or publishing. Raw evidence and the final report may be copied into this directory only in a later evidence
commit after the external experiment has stopped; in-repository evidence is never excluded from a live cleanliness check.

## Phase B producer command

Create the experiment root with `mktemp -d /tmp/cod374-XXXXXXXX` (which supplies mode `0700`), then run each immutable
schedule plan separately and in order; filenames are explicit and globbing is forbidden:

```bash
npx tsx scripts/perf/cod-374-runner.mjs \
  --experiment-root /tmp/cod374-EXPERIMENT \
  --repository-root /opt/projects/Codeman/.worktrees/COD-370-active-viewer-terminal-sizing \
  --vendor-manifest /tmp/cod374-inputs/vendor-manifest.json \
  --repetition-plan /tmp/cod374-inputs/attempt-0001-plan.json \
  --overlay-artifact /tmp/cod374-inputs/candidate-overlay.json
```

Attempts 1-3 are calibration off/on/off. The runner refuses attempt 4 unless the reconciled calibration passes both
overhead bounds. Any rejected or contaminated attempt stops the schedule and permits only an invalid report from the
evidence retained so far; it is never retried.

The first Phase B experiment (`32e33dfa699bd0f7`) is permanently invalid and must never be retried. Its immutable
attempt hash is `d43195872fe9109a1a67aeda378c8cb19366d376f7be78858f1f213fef39c940`; report hash is
`036a54d2813d4754186628c57475e12fd2836a6370785223cb28cfdc01338860`. It failed before samples because the detached
runtime had no dependency root. The old experiment remains finalized evidence. Any corrected calibration requires a
fresh experiment ID and fresh external roots after this harness correction is committed and reviewed.

The second Phase B experiment (`194d04296ddc0953`) is also permanently invalid and must never be retried. Its attempt,
ledger, report, and finalized hashes are respectively
`231627b26f8a69c4ec8c9f443eb478806b180c7f6358a46425f1f76236e20c32`,
`18ae4b5a17091609bd731faabab333431832e1a8494537fb2110bacd11e71109`,
`43b7b593a97fb5ec0cf2e98b0891c839c5b0edcab558c49c9df04797519791b8`, and
`11124dc2170898787cabc39e17a2f67baef6c4f679ff410d115011ca0fc70e02`; the bounded outer startup-message hash is
`4f5bcd7681299314`. Attempt 1 stopped with zero cells after browser/server allocation. The app marked its shell loaded
before the deferred animation-frame terminal initialization, while the old runtime selected the newly created session
immediately and dereferenced null terminal options. The corrected runtime waits for initialized terminal options and an
open SSE stream before creation, then waits for the exact session to exist before selection and proves the exact active
session, ready WebSocket, terminal buffer, pane+xterm composer, real composer-row click/focus, and 500 ms stability.
The click row is derived independently from the visible tmux pane and xterm viewport (not tmux scrollback), and the two
unique row indices must match.
The follow-up materialized-runtime integration additionally proved that ignored vendor files must be provisioned for a
detached product. Cleanup for the invalid attempt verified browser, server, tmux, and temporary-root absence; hooks and
listeners were never allocated. Only a fresh experiment may exercise the corrected harness.

The third Phase B experiment (`381941ff3eeec967`) is permanently invalid and must never be retried. Its attempt,
ledger, report, and finalized hashes are respectively
`23dd88651bcf17641c225fcae0763a45c055f3e08b1eef689cad19242a07f545`,
`635f807e15fd65ef9ccd275e8e5db1f6e0fe30f6616c81bf64f57efdd2d1c903`,
`b750d8f4555c976c03ffa7a88da520b3ec83a70a7f362da6fbb35b4ce877c556`, and
`85f29237b3da049ffd074e8cbfc5ad32ca2f53e0328ea65e2c910ae428162743`. Attempt 1 retained zero cells, runtime-vendor
proof `c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, stdout/stderr hashes
`4e03e51b542ea007`/`51326955270cd50b`, startup-stage hash `30e9e22ea450c474`, startup-name hashes
`3cd79a2766575df4` and `54a0e8c17ebb21a1`, and startup-message hashes `0bdcf894ac84c582` and
`81c304ef6ed1beb5`; its bounded outer failure hash is `4f5bcd7681299314`. The production
`node --import tsx` loader transformed the function callback passed to `page.addInitScript` and introduced a free
`__name` reference. The browser raised `__name is not defined` before creating `window.__cod374LatencyTrace`, so hook
installation could not begin. The corrected installer supplies a static, self-contained plain-JavaScript `content`
payload with no transform helpers or callback-serialization ordering dependency. Aggregate cleanup verified every
resource absent or restored; hooks were not allocated. Only a wholly fresh experiment after commit and review may run
the corrected harness.

The fourth Phase B experiment (`fe48f15eeb83d566`) is permanently invalid and must never be retried. Its attempt,
ledger, report, and finalized hashes are respectively
`12204036be0d3a25a211bf3aae20a45ca87f6246dfb3804449053cecfc0410cd`,
`6b8b87f3bd0a06617e585e23712d778d6106d7e45bdca8daee6a1d58ddc92129`,
`32ae41cc71fd03c6319ae8ddd11be794efe2d7e1e6bf14dd22a363831e95e9bb`, and
`53a0a450c198855f10a0a4549e50994e66e5fb914c251ad7f79b37e404eb66f6`. Attempt 1 retained zero cells, runtime-vendor
proof `c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, stdout/stderr hashes
`0e92e5e74a210dc8`/`b5f762ade2336ade`, and startup-message hashes `0bdcf894ac84c582` and
`e9a3d8fa25ed9e27`; its bounded outer failure hash is `4f5bcd7681299314`. The static init payload succeeded and the
real session/composer readiness barrier completed, but production `node --import tsx` independently transformed the
function callback passed to `page.evaluate` by `installBrowserLatencyHooks`. Its free `__name` raised a browser
`ReferenceError` before wrappers were installed. The corrected hook installer evaluates an exact static plain-JavaScript
expression and serializes only a validated fail-stage enum. Exact-loader coverage audits every browser callback used by
setup, capture, and cleanup; transform helpers remaining in the loaded runtime are proved Node-local only. Aggregate
cleanup verified every resource absent or restored and hooks were not allocated. Only another wholly fresh experiment
after commit and review may run the corrected harness.

The fifth Phase B experiment (`6706cafd8c32f6c0`) is permanently invalid and must never be retried. Its attempt,
ledger, report, and finalized hashes are respectively
`193fd39b6f41d7928538c2cd2392b339941b45fbe51d043e2d2f4ded8e16b65b`,
`3b6100b36c06b01e113b7d01e34b20aff1b50e48b88cb36eb797f14fc8be7e99`,
`217123849a4e280f371afd796840d8b5146e663047f0ce56f32ca480429c6e3c`, and
`259e55818e3937787301463a14b3c8ca538c4236eedc73f80d4004f35798caf6`. Attempt 1 retained zero cells, runtime-vendor
proof `c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, bounded failure hash
`b12becd4e90bf372`, and startup-message hash `dec3d9ab7735b19b`. Browser hooks and readiness were healthy; startup then
rejected the live `/` response because the old verifier compared its raw bytes to the immutable source
`src/web/public/index.html` hash. `renderIndexHtml` necessarily replaces the title, adds numeric local-asset cache
busters, injects the exact CLI-availability bootstrap, and may remove either of two exact hidden-toggle class markers.
The corrected verifier keeps the source hash as provenance, reverses only those structurally exact mutations, and then
requires byte equality with the frozen source. It rejects ambiguous, duplicate, reordered, injected, or unknown
mutations. Referenced live `/app.js` and `/styles.css` remain raw byte-for-byte checks against their source hashes.
Aggregate cleanup verified every resource absent or restored. No retry is permitted; a corrected calibration requires
a wholly new experiment after commit and review.

The sixth Phase B experiment (`9c4d0087fa344ef1`) is permanently invalid and must never be retried. Its attempt,
ledger, report, and finalized hashes are respectively
`00465b54fe716a9da4792a1ba552ecd32dea42bbfdb03cfa1a85bffd55958d8a`,
`17ac23e5765cbf42bd5ed91920b6b241e2ee58141becec55b726cd7b84e40c85`,
`56600a0b026886afd387978bb04a86aec6fc88749ea3902a0d364b1323c46a56`, and
`b64ed63213b92931f143c40415c23c4c9684d6c730db31df20934975fa6cc703`. Attempt 1 retained zero cells, runtime-vendor
proof `c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, bounded failure hash
`9eea4651f2e1886f`, and startup-message hash `063c9eb222973875`. The exact dynamic plaintext was intentionally not
retained and is unrecoverable, so the original trigger remains indeterminate rather than guessed. Read-only
post-finalization inspection proved the recorded server, browser, and OpenCode PIDs dead and found no attempt-owned
process, tmux socket, scenario root, or overlay root. The false cleanup fields instead exposed a deterministic harness
accounting defect: cleanup had already run and nulled its live handles before a later proof-construction error reached
the outer catch, which rebuilt cleanup from `runtime === null` instead of the durable proof. The corrected runner uses
explicit unallocated/live/cleaned resource states, invokes each cleanup once, monotonically merges returned or
exception-carried partial proofs, hoists completed cells and diagnostics, and classifies later validation separately as
`runtime-proof-failed` while retaining cleanup errors separately. No retry is permitted; a future calibration requires
a wholly new experiment after commit and review. Final real-runtime gating also reproduced a composer-row TOCTOU: the
pane and xterm matched inside the readiness wait, then changed before the action reread. The corrected barrier requires
two consecutive identical, exactly equal pane/xterm snapshots and clicks the row from that accepted snapshot without a
second read or fixed sleep.

The seventh Phase B experiment (`9e070ba5a75eca90`) is permanently invalid and must never be retried. Its attempt,
ledger, report, and finalized hashes are respectively
`3bcea24a95da48dce284c6d45bb45bfb4766eb1e5913e24dbcaf594f18caf133`,
`b7d751a3df2810e31a20a02afe9fd7fbd5cbe852080d32d3e96e5fabebb4566b`,
`dca02c5b6c15430c713f319fc775d0af295ea36ae67da4becb28609ef4eba581`, and
`3b720bf2738b06b6e39db62274fc7c4efdb6c450bf1bc0e9ebd119866e1098b2`. Attempt 1 stopped with zero published samples
and bounded failure hash `793268f4b26a4359`; attempts 2-3 and diagnostic ABBA never ran. The exact retained trace proved
that the four write events were complete. The old strict sequence required write, return, callback, parsed, but
`@xterm/xterm` 6.0.0 may synchronously invoke both the callback and `onWriteParsed` inside `Reflect.apply` before the
wrapper can record return, legally producing write, callback, parsed, return. The validator now enforces the causal
partial order instead: write first, callback before parsed, and exactly one return either before callback or after
parsed, while preserving per-write identity and global monotonic checks. Reports derive the same three nonnegative
causal intervals for either schedule: write-to-return, write-to-callback, and callback-to-parsed. The failed strict validation occurred after
runtime cleanup and the transaction replaced the invalid partial with a generic producer-crash sentinel. The corrected
runner derives the longest schema-valid cell/sample prefix, retains the durable cleanup proof and safe failure hashes,
and publishes that rejected partial rather than allowing transaction fallback to erase it. No retry is permitted; a
future calibration requires a wholly fresh experiment after commit and review.

The eighth Phase B experiment (`c5a5074cc3710e0f`) is permanently invalid and must never be retried. Its attempt,
ledger, report, and finalized hashes are respectively
`72dc5e1f5d2739cb9a5b20464a6635696840a6a9dec5aabd3193bb6dba4d28f3`,
`53ed53b9dea564629dcf8ffd11140f64485f85dde3ea525271a8c52d137645d8`,
`c63d82bbe24e32e88408fb4f5fb977dba6e5ac9a43fa1a83f2a69a5179767d2d`, and
`0be60a490bbedd93016698ada387295937928666abd6be292d0c40b7cf682f3e`. Attempt 1 stopped trace-off with one retained
1x cell, zero samples, runtime-vendor proof `c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`,
bounded failure hash `386f7e7852f75046`, and startup-message hash `f9cc966fa89ba331`; all aggregate cleanup fields were
verified true, and attempts 2-3 and diagnostic ABBA did not run. The decoded error was `COD-374 evidence invalid:
browser visibility is not joined to a parsed write`. The real hook recorded the selected visibility chain with the
correct generation and input identity but `selectAttribution` annotated only the matching global output stages. The
synthetic fixture had manually supplied `attributedGeneration` and `attributedInputIndex`, masking that producer gap.
The corrected hook stamps the matching selected parse-visible, render, visible, and paint events with the same context
while retaining exact ordinal/write ID matching and the existing multi-generation selection/RAF fences. A browser-hook
contract executes parse, render, and RAF, then passes the unmodified hook events through the Task 3 adapter and strict
evidence derivation. No retry is permitted; a future calibration requires a wholly fresh experiment after commit and
review.

The ninth Phase B experiment (`92b2296a98c9bcf5`) is permanently invalid and must never be retried. Its attempt,
ledger, report, and finalized hashes are respectively
`3aae425b0b178bca40001aad5327cd2e55449e24c2846dcdec6b816d2f9a1860`,
`4281c8e515e80c202aa08280a05e727e91fb3f9c59a8a6708b54256c649f5cd5`,
`dca02c5b6c15430c713f319fc775d0af295ea36ae67da4becb28609ef4eba581`, and
`bac703d0fa329d6d8707357e8b2583f90066bfefb46c7851039ab1ed90cb43ca`. Attempt 1 stopped trace-off with zero retained
cells and bounded failure hash `793268f4b26a4359`; attempts 2-3 and diagnostic ABBA did not run. The immutable attempt
was reduced to the canonical producer-crash shape, so its false/unknown cleanup values remain authoritative even though
a later read-only inventory found no matching process, runtime worktree, or scenario root. The runtime observation
failed because the probe read the inherited computed `.xterm` font size (16px), while the exact active terminal option
and frozen plan used 9px. The corrected probe accepts only the finite positive numeric value from
`window.app.terminal.options.fontSize`. Publication-time observation mismatches now become a schema-valid
`runtime-proof-failed` partial that retains completed cells, diagnostics, and cleanup proof using safe hashes; they can
no longer fall through to the producer-crash sentinel. No retry is permitted; a corrected calibration requires a
wholly new experiment after commit and review.

The tenth Phase B experiment (`ec09d0f327f75693`) is permanently invalid and must never be retried. Attempt 1 trace-off
was accepted with 20 samples at hash `38e0b8a3c09affab7a9d39093dcbff6200892bf5be873545b91f2c57f410a981`.
Attempt 2 trace-on was rejected at hash `b0e719bc83dbc4b3a8ad07424ba7bc109482c1750b4076fc3730c659b28b0701`;
the final ledger, INVALID report, and finalized hashes are
`380db1ee3a9b7f4078f145b823170fa23f98f84add63031954295287a66a7d40`,
`e691ecc952690c5b4e3ea7f7abc80a0aa31cfb1ad35475c34ea75b35bfe0e843`, and
`40c9720525bdc9154f7c9ee6f910a36787202c8213c1da8d3151c0922aad9b27`. Attempt 3 and diagnostic ABBA did not run.
The exact proof failure was `COD-374 evidence invalid: selected server output was not delivered`, with message hash
`d6ebef36d1895073` and Error-prefixed hash `ca0b385822aac2f6`. The route recorded `server.output.post-send` only after
`socket.send` returned successfully but omitted the corresponding `delivered: true` fact, while synthetic evidence had
supplied it. The corrected route records delivery only on that successful-return path; a throwing send retains pre-send
evidence and cannot claim post-send delivery. The corrected candidate/baseline overlay patch hashes are respectively
`2ac79883807576298fc13460f34ce5c418e0b4fb995470470df9e34497863a3b` and
`ec6b3e713f59c1e9869e1ec9af90b0642a3a2ea09d0b90e5cb27d2842231bd97`; the corrected five-file manifest hash is
`d730f0c05ba56d852e451df9b041b5212240ee257706527d0dbea6a96c9672fa`. Independently, attempt 2 retained a 56ms
browser long task and `runtime-contaminated` detail hash `9337373a4dd1a723`. That contamination remains terminal and
its relationship to tracing overhead is indeterminate: fixing the instrumentation contract cannot rehabilitate or
reinterpret this experiment. All cleanup fields were true, but no retry is permitted; any future calibration requires
a wholly new experiment after commit and review.

## Fail-closed report command

```bash
node scripts/perf/cod-374-summarize.mjs \
  --experiment-root /tmp/cod374-EXPERIMENT \
  --output-directory /tmp/cod374-output-EXPERIMENT \
  --output /tmp/cod374-output-EXPERIMENT/input-latency-attribution.md \
  --vendor-manifest /tmp/cod374-inputs/vendor-manifest.json \
  --candidate-overlay /tmp/cod374-inputs/candidate.patch \
  --baseline-overlay /tmp/cod374-inputs/baseline.patch \
  --repository-root /opt/projects/Codeman/.worktrees/COD-370-active-viewer-terminal-sizing
```

The explicitly supplied output directory must also be a newly created current-UID `0700` direct child of `os.tmpdir()`
with a `cod374-output-*` basename, separate from the experiment root. The output path must be unused. Report publication
holds the experiment lock through reconcile, verification, report publication, and the atomic finalized marker; it uses
an adjacent fsynced temporary file, an exclusive hard link, and parent-directory fsync. Dynamic report content is
escaped; raw payloads, characters, pane/xterm text, responses, private
paths, and free-form environment strings are forbidden. Opaque values are bounded hashes and statuses are tight enums.

## Phase A TDD ledger

- Initial RED: the report module was absent.
- First-review RED: collector stage, lossless evidence, provenance, overlay, ledger, median, privacy, and durable
  publication boundaries were missing.
- Second-review RED: the 43-test real-shape suite produced 31 expected failures against the incompatible v1 schema and
  append ledger. Follow-up REDs covered completed contamination, output identities, multi-batch output, crash-after-ledger,
  manifest symlinks, and clean-repository preflight proof.
- Final corrective REDs covered full multi-generation windows, async write joins, partial lifecycle, measured runtime
  proofs, reconcile-before-validation, killed-process lock recovery, realpath containment, recursive canonical JSON, and
  complete calibration/diagnostic/cleanup reporting.
- Independent final-review REDs corrected real Task 3 input-received identity, mutually exclusive generation completion,
  one-write paint fences, retained-sample detail in invalid reports, and identity-bound stale-lock reclamation.
- Final producer REDs covered exact Task 3 ordinal-only schemas, q plus coalesced z/1 identity, trace-off collector
  absence, live overlay lifetime, served assets, live server/browser/OpenCode process identity, and transaction-backed
  publication through test-only async seams. Follow-up adversarial REDs covered raw UUID privacy, mismatched overlay
  launch provenance, retained partial capture prefixes, measured CPU ratios, post-ACK flush boundaries, runtime-derived
  clocks/load/process identities, output-root rebinding, and linked finalization paths.
- The production-loader corrective RED ran the exact `node --import tsx` dynamic-import path and observed a function
  payload containing free `__name`, browser page error `__name is not defined`, and absent trace state. GREEN proves a
  static content payload with byte-for-byte tracing-behavior parity, no transform helpers, successful state creation,
  full detached-runtime hook installation, and complete cleanup. The first loader correction expanded the combined
  report/runner gate to 105/105.
- The second production-loader RED kept the static init state healthy but reproduced free `__name` in the hook-install
  `page.evaluate` callback. GREEN installs and removes the static hook expression on a real page, rejects non-whitelisted
  fail-stage data before evaluation, and audits setup/capture/cleanup callbacks through the exact loader. The current
  combined report/runner gate passes 106/106.
- Historical initial GREEN checkpoint: the same combined report/runner command passed 77/77 before the subsequent
  producer and production-loader cases expanded it to the later gates above.
- Static gates: `npm run typecheck`, `node --check scripts/perf/cod-374-summarize.mjs`, focused Prettier, and
  `git diff --check`.

No calibration, diagnostic ABBA, raw cohort, or final attribution report was run or generated in Phase A.
