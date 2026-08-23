import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])])
  );
}

export function validateBenchmarkPhase(phase) {
  if (typeof phase !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(phase)) {
    throw new Error('phase must be a lowercase filesystem-safe label');
  }
  return phase;
}

export function compactReportFilenamesForPhase(phase) {
  validateBenchmarkPhase(phase);
  return phase === 'before'
    ? { summary: 'baseline-summary.json', environment: 'baseline-environment.json' }
    : { summary: `${phase}-summary.json`, environment: `${phase}-environment.json` };
}

function resolveAssetPath(runtimeRoot, assetPath) {
  if (
    typeof assetPath !== 'string' ||
    assetPath.length === 0 ||
    isAbsolute(assetPath) ||
    assetPath.includes('\\') ||
    assetPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`generated runtime asset is outside declared runtime root: ${assetPath}`);
  }
  const resolvedRoot = resolve(runtimeRoot);
  const resolvedPath = resolve(resolvedRoot, assetPath);
  const pathFromRoot = relative(resolvedRoot, resolvedPath);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..' || isAbsolute(pathFromRoot)) {
    throw new Error(`generated runtime asset is outside declared runtime root: ${assetPath}`);
  }
  return resolvedPath;
}

async function listRegularAssetFiles(runtimeRoot, directory) {
  const absoluteDirectory = resolveAssetPath(runtimeRoot, directory);
  const directoryStatus = await lstat(absoluteDirectory).catch(() => null);
  if (!directoryStatus?.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error(`generated runtime asset directory is missing, not a directory, or a symlink: ${directory}`);
  }
  const files = [];
  const visit = async (absolutePath) => {
    for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
      const entryPath = join(absolutePath, entry.name);
      const relativePath = relative(resolve(runtimeRoot), entryPath).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`generated runtime asset must not be a symlink: ${relativePath}`);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`generated runtime asset must be a regular file: ${relativePath}`);
    }
  };
  await visit(absoluteDirectory);
  return files;
}

export async function collectGeneratedRuntimeAssetManifest({
  repositoryRoot,
  runtimeRoot,
  requiredAssets,
  monitoredDirectories,
  allowedFiles,
  documentedNonRuntimeFiles = [],
}) {
  const resolvedRepositoryRoot = await realpath(repositoryRoot);
  const resolvedRoot = await realpath(runtimeRoot);
  const runtimeRootFromRepository = relative(resolvedRepositoryRoot, resolvedRoot);
  if (
    runtimeRootFromRepository === '..' ||
    runtimeRootFromRepository.startsWith(`..${sep}`) ||
    isAbsolute(runtimeRootFromRepository)
  ) {
    throw new Error('generated runtime root is outside supplied repository root');
  }
  const allowed = new Set(allowedFiles);
  for (const path of [...requiredAssets, ...monitoredDirectories, ...allowedFiles])
    resolveAssetPath(resolvedRoot, path);
  const discovered = (
    await Promise.all(monitoredDirectories.map((directory) => listRegularAssetFiles(resolvedRoot, directory)))
  ).flat();
  const unexpected = discovered.filter((path) => !allowed.has(path)).sort();
  if (unexpected.length > 0) throw new Error(`unexpected generated runtime asset: ${unexpected.join(', ')}`);

  const files = [];
  for (const path of [...requiredAssets].sort()) {
    const absolutePath = resolveAssetPath(resolvedRoot, path);
    const status = await lstat(absolutePath).catch(() => null);
    if (!status) throw new Error(`missing required generated runtime asset: ${path}`);
    if (status.isSymbolicLink()) throw new Error(`generated runtime asset must not be a symlink: ${path}`);
    if (!status.isFile()) throw new Error(`generated runtime asset must be a regular file: ${path}`);
    const resolvedFile = await realpath(absolutePath);
    if (relative(resolvedRoot, resolvedFile).startsWith(`..${sep}`)) {
      throw new Error(`generated runtime asset is outside declared runtime root: ${path}`);
    }
    const content = await readFile(absolutePath);
    files.push({ path, bytes: content.length, sha256: sha256(content) });
  }
  const policy = {
    requiredAssets: [...requiredAssets].sort(),
    monitoredDirectories: [...monitoredDirectories].sort(),
    allowedFiles: [...allowedFiles].sort(),
    documentedNonRuntimeFiles: [...documentedNonRuntimeFiles].sort(),
  };
  const manifest = {
    schemaVersion: 1,
    algorithm: 'sha256',
    runtimeRoot: runtimeRootFromRepository.split(sep).join('/'),
    policy,
    files,
  };
  return { ...manifest, manifestHash: sha256(JSON.stringify(canonicalJson(manifest))) };
}

function comparableGeneratedAssetManifest(manifest) {
  return canonicalJson({
    schemaVersion: manifest?.schemaVersion,
    algorithm: manifest?.algorithm,
    runtimeRoot: manifest?.runtimeRoot,
    policy: manifest?.policy,
    files: manifest?.files,
    manifestHash: manifest?.manifestHash,
  });
}

export function assertGeneratedAssetManifestMatches({ accepted, actual }) {
  if (!accepted?.files) throw new Error('accepted baseline generated runtime asset manifest is unavailable');
  if (
    JSON.stringify(comparableGeneratedAssetManifest(accepted)) !==
    JSON.stringify(comparableGeneratedAssetManifest(actual))
  ) {
    throw new Error('generated runtime asset manifest does not match accepted baseline');
  }
  return true;
}

export async function verifyPostRunGeneratedAssets({
  preRunManifest,
  collectPostRun,
  checkedAt = new Date().toISOString(),
}) {
  const evidence = {
    checkedAt,
    result: 'failed',
    preHash: preRunManifest?.manifestHash ?? null,
    postHash: null,
    error: null,
  };
  try {
    const postRunManifest = await collectPostRun();
    evidence.postHash = postRunManifest.manifestHash ?? null;
    assertGeneratedAssetManifestMatches({ accepted: preRunManifest, actual: postRunManifest });
    evidence.result = 'matched';
    return evidence;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    return evidence;
  }
}

export async function assertGeneratedAssetsStableAtPublication({
  preRunManifest,
  collectCurrent,
  checkedAt = new Date().toISOString(),
}) {
  const verification = await verifyPostRunGeneratedAssets({
    preRunManifest,
    collectPostRun: collectCurrent,
    checkedAt,
  });
  if (verification.result !== 'matched') {
    const error = new Error(
      `generated runtime assets changed immediately before compact report publication: ${verification.error}`
    );
    error.verification = verification;
    throw error;
  }
  return verification;
}

export async function guardGeneratedAssetPublication({
  preRunManifest,
  collectPostRun,
  verifyPublicationState = async () => null,
  publish,
}) {
  const verification = await verifyPostRunGeneratedAssets({ preRunManifest, collectPostRun });
  if (verification.result !== 'matched') {
    const error = new Error(`generated runtime assets changed during benchmark run: ${verification.error}`);
    error.verification = verification;
    throw error;
  }
  try {
    const publicationState = await verifyPublicationState();
    return { verification, publicationState, publishedValue: await publish(verification, publicationState) };
  } catch (error) {
    if (error && typeof error === 'object' && !error.verification) error.verification = verification;
    throw error;
  }
}

export function validatePairedReports({ summaryContent, environmentContent, summaryPath, environmentPath }) {
  let summary;
  let environment;
  try {
    summary = JSON.parse(summaryContent);
    environment = JSON.parse(environmentContent);
  } catch {
    throw new Error('compact report pair contains malformed JSON');
  }
  if (!summary?.reportSetId || summary.reportSetId !== environment?.reportSetId) {
    throw new Error('compact report pair reportSetId does not match');
  }
  if (
    summary.reportPair?.role !== 'summary-canonical-success-marker' ||
    environment.reportPair?.role !== 'environment' ||
    summary.reportPair?.environmentContentSha256 !== sha256(environmentContent) ||
    (environmentPath && summary.reportPair?.environmentFile !== basename(environmentPath)) ||
    (summaryPath && environment.reportPair?.canonicalSummaryFile !== basename(summaryPath))
  ) {
    throw new Error('compact report pair content relation does not match');
  }
  return {
    reportSetId: summary.reportSetId,
    environmentContentSha256: summary.reportPair.environmentContentSha256,
  };
}

export async function writePairedJsonArtifacts({
  summaryPath,
  environmentPath,
  summary,
  environment,
  reportSetId,
  beforeRename = async () => {},
  renameImpl = rename,
}) {
  if (typeof reportSetId !== 'string' || reportSetId.length === 0) throw new Error('reportSetId is required');
  const environmentDocument = {
    ...environment,
    reportSetId,
    reportPair: { role: 'environment', canonicalSummaryFile: basename(summaryPath) },
  };
  const environmentContent = `${JSON.stringify(environmentDocument, null, 2)}\n`;
  const summaryDocument = {
    ...summary,
    reportSetId,
    reportPair: {
      role: 'summary-canonical-success-marker',
      environmentFile: basename(environmentPath),
      environmentContentSha256: sha256(environmentContent),
    },
  };
  const summaryContent = `${JSON.stringify(summaryDocument, null, 2)}\n`;
  validatePairedReports({ summaryContent, environmentContent, summaryPath, environmentPath });

  await Promise.all([
    mkdir(dirname(summaryPath), { recursive: true }),
    mkdir(dirname(environmentPath), { recursive: true }),
  ]);
  const suffix = `${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  const summaryTemporaryPath = join(dirname(summaryPath), `.${basename(summaryPath)}.${suffix}`);
  const environmentTemporaryPath = join(dirname(environmentPath), `.${basename(environmentPath)}.${suffix}`);
  try {
    await Promise.all([
      writeFile(summaryTemporaryPath, summaryContent, { flag: 'wx' }),
      writeFile(environmentTemporaryPath, environmentContent, { flag: 'wx' }),
    ]);
    await beforeRename();
    await renameImpl(environmentTemporaryPath, environmentPath);
    await renameImpl(summaryTemporaryPath, summaryPath);
  } finally {
    await Promise.all([rm(summaryTemporaryPath, { force: true }), rm(environmentTemporaryPath, { force: true })]);
  }
  return validatePairedReports({ summaryContent, environmentContent, summaryPath, environmentPath });
}

export function assertRuntimePackageManifestMatches({ declaredRevision, revisionContent, actualContent }) {
  const normalize = (content) => {
    const manifest = JSON.parse(content);
    if (manifest.scripts) delete manifest.scripts['perf:cod356'];
    return JSON.stringify(canonicalJson(manifest));
  };
  const revision = normalize(revisionContent);
  const actual = normalize(actualContent);
  if (actual !== revision) throw new Error('runtime package manifest does not match declared revision');
  return {
    allowedDifference: 'scripts.perf:cod356 only',
    comparedToRevision: declaredRevision,
    normalizedHash: sha256(actual),
  };
}

export function assertRuntimeTreeMatchesRevision({ runtimeRevision, changedPaths, untrackedPaths }) {
  const differences = [...changedPaths, ...untrackedPaths];
  if (differences.length > 0) {
    throw new Error(
      `runtime tree does not match declared revision ${runtimeRevision}: ${differences.sort().join(', ')}`
    );
  }
  return true;
}

export async function resolveRuntimeRevisionPolicy({
  phase,
  requestedRevision,
  branchBaseRevision,
  comparisonRevision,
  headRevision,
  resolveCommit,
  isAncestor,
}) {
  const explicit = requestedRevision !== undefined;
  if (phase !== 'before' && !explicit) {
    throw new Error(`phase ${phase} requires --runtime-revision with a full commit SHA`);
  }
  const declaredRevision = requestedRevision ?? comparisonRevision;
  if (!/^[0-9a-f]{40}$/.test(declaredRevision)) {
    throw new Error('--runtime-revision must be a full 40-character lowercase commit SHA');
  }
  if (phase === 'before' && declaredRevision !== comparisonRevision) {
    throw new Error(`before phase requires immutable comparison revision ${comparisonRevision}`);
  }
  let resolvedRevision;
  try {
    resolvedRevision = await resolveCommit(declaredRevision);
  } catch {
    throw new Error(`unknown runtime revision: ${declaredRevision}`);
  }
  if (resolvedRevision !== declaredRevision) throw new Error(`unknown runtime revision: ${declaredRevision}`);
  if (phase !== 'before') {
    if (declaredRevision === comparisonRevision) {
      throw new Error('post-change runtime revision must be a strict descendant of comparison revision');
    }
    if (!(await isAncestor(comparisonRevision, declaredRevision))) {
      throw new Error('post-change runtime revision must be a descendant of comparison revision');
    }
    if (!(await isAncestor(declaredRevision, headRevision))) {
      throw new Error('post-change runtime revision must be reachable from current HEAD');
    }
  }
  return {
    runtimeRevision: declaredRevision,
    explicit,
    branchBaseRevision,
    comparisonRevision,
    comparisonBaselineRevision: comparisonRevision,
    headRevision,
  };
}

export function buildHarnessProvenance({
  branchBaseRevision,
  comparisonRevision,
  runtimeRevision,
  headRevision,
  runtimeTreeHash,
  harnessFiles,
  dirtyHarnessPaths = dirtyTrackedPaths,
  dirtyTrackedPaths,
  ownedPaths,
}) {
  const manifest = harnessFiles
    .map(({ path, content }) => {
      const bytes = Buffer.from(content);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const harnessPathSet = new Set(manifest.map(({ path }) => path));
  const ownedPathSet = new Set(ownedPaths);
  const dirtyHarnessFiles = dirtyHarnessPaths.filter((path) => harnessPathSet.has(path)).sort();
  return {
    runtimeRevision,
    branchBaseRevision,
    comparisonRevision,
    comparisonBaselineRevision: comparisonRevision,
    runtimeTreeHash,
    headRevision: {
      value: headRevision,
      semantics: 'informational only; not the measured runtime or harness identity',
    },
    harnessHeadRevision: {
      value: headRevision,
      semantics: 'informational commit containing or preceding the working-tree harness content',
    },
    harness: {
      algorithm: 'sha256 of sorted path/byte-length/content-sha256 manifest',
      contentHash: sha256(JSON.stringify(manifest)),
      files: manifest,
      dirty: dirtyHarnessFiles.length > 0,
      dirtyPaths: dirtyHarnessFiles,
    },
    outOfScopeTrackedDirtyPaths: dirtyTrackedPaths.filter((path) => !ownedPathSet.has(path)).sort(),
  };
}

export function parseTrackedStatusPaths(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(3);
      const renameSeparator = value.indexOf(' -> ');
      return renameSeparator === -1 ? value : value.slice(renameSeparator + 4);
    });
}

function git(root, ...arguments_) {
  return new Promise((resolveOutput, reject) => {
    execFile('git', arguments_, { cwd: root, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${arguments_.join(' ')} failed: ${stderr.trim() || error.message}`));
      else resolveOutput(stdout);
    });
  });
}

export async function assertCurrentHeadRevision({ root, sourceCommit }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) throw new Error('provenance source commit must be a full commit SHA');
  const currentHead = (await git(root, 'rev-parse', 'HEAD')).trim();
  if (currentHead !== sourceCommit) throw new Error('current HEAD moved after provenance capture');
  return currentHead;
}

async function loadBoundReportFile({ root, reportPath, sourceCommit }) {
  let blobObjectId;
  let committedContent;
  let indexBlobObjectId;
  let indexContent;
  try {
    blobObjectId = (await git(root, 'rev-parse', '--verify', `${sourceCommit}:${reportPath}`)).trim();
    committedContent = await git(root, 'cat-file', '-p', blobObjectId);
  } catch {
    throw new Error(`committed accepted baseline blob is missing: ${reportPath}`);
  }
  try {
    indexBlobObjectId = (await git(root, 'rev-parse', '--verify', `:${reportPath}`)).trim();
    indexContent = await git(root, 'cat-file', '-p', indexBlobObjectId);
  } catch {
    throw new Error(`index baseline report is missing: ${reportPath}`);
  }
  if (indexContent !== committedContent || indexBlobObjectId !== blobObjectId) {
    throw new Error('index baseline report does not match committed Git blob');
  }
  const workingContent = await readFile(join(root, reportPath), 'utf8').catch(() => null);
  if (workingContent !== committedContent) {
    throw new Error('working baseline report does not match committed Git blob');
  }
  return {
    reportPath,
    blobObjectId,
    committedContent,
    contentSha256: sha256(committedContent),
    indexBlobObjectId,
    indexContentSha256: sha256(indexContent),
    workingContentSha256: sha256(workingContent),
  };
}

export async function loadCommittedBaselineAssetManifest({ root, reportPath, sourceCommit }) {
  await assertCurrentHeadRevision({ root, sourceCommit });
  const environmentReportPath = reportPath.replace(/-summary\.json$/, '-environment.json');
  if (environmentReportPath === reportPath) throw new Error('accepted baseline summary path is invalid');
  const summaryFile = await loadBoundReportFile({ root, reportPath, sourceCommit });
  const environmentFile = await loadBoundReportFile({ root, reportPath: environmentReportPath, sourceCommit });
  await assertCurrentHeadRevision({ root, sourceCommit });
  validatePairedReports({
    summaryContent: summaryFile.committedContent,
    environmentContent: environmentFile.committedContent,
    summaryPath: reportPath,
    environmentPath: environmentReportPath,
  });
  let report;
  try {
    report = JSON.parse(summaryFile.committedContent);
  } catch {
    throw new Error('committed accepted baseline manifest is malformed');
  }
  const manifest = report?.provenance?.generatedRuntimeAssets;
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.algorithm !== 'sha256' ||
    !manifest?.policy ||
    !Array.isArray(manifest?.files) ||
    !/^[a-f0-9]{64}$/.test(manifest?.manifestHash ?? '')
  ) {
    throw new Error('committed accepted baseline manifest is malformed');
  }
  return {
    manifest,
    benchmarkProtocol: report?.benchmarkProtocol ?? null,
    binding: {
      sourceCommit,
      blobObjectId: summaryFile.blobObjectId,
      contentSha256: summaryFile.contentSha256,
      indexBlobObjectId: summaryFile.indexBlobObjectId,
      indexContentSha256: summaryFile.indexContentSha256,
      workingContentSha256: summaryFile.workingContentSha256,
      environmentBlobObjectId: environmentFile.blobObjectId,
      environmentContentSha256: environmentFile.contentSha256,
      environmentIndexBlobObjectId: environmentFile.indexBlobObjectId,
      environmentIndexContentSha256: environmentFile.indexContentSha256,
      environmentWorkingContentSha256: environmentFile.workingContentSha256,
      reportSetId: report.reportSetId,
      indexMatchesHead: true,
      workingMatchesHead: true,
      reportPath,
      environmentReportPath,
      semantics: 'accepted generated runtime asset baseline pair loaded from immutable report blobs at sourceCommit',
    },
  };
}

export async function resolveRuntimeRevisionPolicyFromGit({
  root,
  phase,
  requestedRevision,
  branchBaseRevision,
  comparisonRevision,
}) {
  const headRevision = (await git(root, 'rev-parse', 'HEAD')).trim();
  return resolveRuntimeRevisionPolicy({
    phase,
    requestedRevision,
    branchBaseRevision,
    comparisonRevision,
    headRevision,
    resolveCommit: async (revision) => (await git(root, 'rev-parse', '--verify', `${revision}^{commit}`)).trim(),
    isAncestor: async (ancestor, descendant) =>
      git(root, 'merge-base', '--is-ancestor', ancestor, descendant)
        .then(() => true)
        .catch(() => false),
  });
}

export async function collectBenchmarkProvenance({
  root,
  phase,
  requestedRuntimeRevision,
  branchBaseRevision,
  comparisonRevision,
  runtimePaths,
  harnessPaths,
  ownedPaths,
  generatedAssetPolicy,
  acceptedBaselineReportPath,
}) {
  const revisionPolicy = await resolveRuntimeRevisionPolicyFromGit({
    root,
    phase,
    requestedRevision: requestedRuntimeRevision,
    branchBaseRevision,
    comparisonRevision,
  });
  const { runtimeRevision } = revisionPolicy;
  const changedPaths = (await git(root, 'diff', '--name-only', runtimeRevision, '--', ...runtimePaths))
    .trim()
    .split('\n')
    .filter(Boolean);
  const untrackedPaths = (await git(root, 'ls-files', '--others', '--exclude-standard', '--', ...runtimePaths))
    .trim()
    .split('\n')
    .filter(Boolean);
  assertRuntimeTreeMatchesRevision({ runtimeRevision, changedPaths, untrackedPaths });

  const runtimeManifest = await git(root, 'ls-tree', '-r', runtimeRevision, '--', ...runtimePaths);
  const packageManifestVerification = assertRuntimePackageManifestMatches({
    declaredRevision: runtimeRevision,
    revisionContent: await git(root, 'show', `${runtimeRevision}:package.json`),
    actualContent: await readFile(join(root, 'package.json'), 'utf8'),
  });
  const generatedRuntimeAssets = await collectGeneratedRuntimeAssetManifest(generatedAssetPolicy);
  let acceptedGeneratedAssetBaseline = null;
  let acceptedBenchmarkProtocol = null;
  if (phase !== 'before') {
    const accepted = await loadCommittedBaselineAssetManifest({
      root,
      reportPath: acceptedBaselineReportPath,
      sourceCommit: revisionPolicy.headRevision,
    });
    assertGeneratedAssetManifestMatches({
      accepted: accepted.manifest,
      actual: generatedRuntimeAssets,
    });
    acceptedGeneratedAssetBaseline = accepted.binding;
    acceptedBenchmarkProtocol = accepted.benchmarkProtocol;
  }
  const harnessFiles = await Promise.all(
    harnessPaths.map(async (path) => ({ path, content: await readFile(join(root, path)) }))
  );
  const dirtyHarnessPaths = parseTrackedStatusPaths(
    await git(root, 'status', '--porcelain=v1', '--untracked-files=all')
  );
  const dirtyTrackedPaths = parseTrackedStatusPaths(
    await git(root, 'status', '--porcelain=v1', '--untracked-files=no')
  );
  await assertCurrentHeadRevision({ root, sourceCommit: revisionPolicy.headRevision });
  return {
    ...buildHarnessProvenance({
      branchBaseRevision,
      comparisonRevision,
      runtimeRevision,
      headRevision: revisionPolicy.headRevision,
      runtimeTreeHash: sha256(runtimeManifest),
      harnessFiles,
      dirtyHarnessPaths,
      dirtyTrackedPaths,
      ownedPaths,
    }),
    runtimePaths,
    revisionPolicy,
    runtimePackageHash: packageManifestVerification.normalizedHash,
    generatedRuntimeAssets: {
      ...generatedRuntimeAssets,
      comparison:
        phase === 'before'
          ? 'authoritative accepted baseline manifest'
          : 'exact file bytes and sizes match accepted before baseline manifest',
    },
    acceptedGeneratedAssetBaseline,
    acceptedBenchmarkProtocol,
    packageManifestVerification,
    runtimeVerification:
      'git diff and untracked-file checks against declared runtime revision passed before resource creation',
  };
}
