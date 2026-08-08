# COD-285: XLSX Terminal Preview Link Implementation Plan

1. Extend `test/terminal-document-link-provider.test.ts` with XLSX detection and activation expectations.
2. Run that single test file and capture the expected RED failure.
3. Add `xlsx` to the terminal document provider's `previewExtensions` set in `src/web/public/terminal-ui.js`.
4. Re-run the focused provider and regex performance suites.
5. Run typecheck, lint, formatting, lockfile, public-asset validation, and production build.
6. Verify the behavior in the isolated beta UI before landing to Bitbucket `local`.
