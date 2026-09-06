#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL_KINDS = ['claude', 'codex', 'marketplace'];

function emptyResult(receiptPath) {
  return {
    ok: false,
    receiptPath,
    version: undefined,
    commit: undefined,
    checks: [],
    errors: [],
  };
}

function readJsonDocument(filePath, label, result) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      result.errors.push(`${label} is missing at ${filePath}`);
    } else {
      result.errors.push(`${label} could not be read at ${filePath}: ${error.message}`);
    }
    return undefined;
  }

  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      result.errors.push(`${label} must contain a JSON object at ${filePath}`);
      return undefined;
    }
    return value;
  } catch (error) {
    result.errors.push(`${label} is not valid JSON at ${filePath}: ${error.message}`);
    return undefined;
  }
}

function addComparison(result, name, expected, actual, errorLabel) {
  const ok = actual === expected;
  result.checks.push({ name, ok, expected, actual });
  if (!ok) {
    result.errors.push(`${errorLabel} mismatch: expected ${expected}, found ${String(actual)}`);
  }
}

function validateReceipt(receipt, result) {
  if (receipt.schemaVersion !== 1) {
    result.errors.push(`deployment receipt schemaVersion must be 1 (found ${String(receipt.schemaVersion)})`);
  }
  if (typeof receipt.version !== 'string' || receipt.version.length === 0) {
    result.errors.push('deployment receipt version must be a non-empty string');
  }
  if (typeof receipt.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(receipt.commit)) {
    result.errors.push('deployment receipt commit must be a full 40-hex Git commit');
  }
  if (typeof receipt.workerSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(receipt.workerSha256)) {
    result.errors.push('deployment receipt workerSha256 must be a 64-hex SHA-256');
  }
  if (typeof receipt.knownMarketplacesPath !== 'string' || receipt.knownMarketplacesPath.length === 0) {
    result.errors.push('deployment receipt knownMarketplacesPath must be a non-empty string');
  }
  if (receipt.installedPluginsPath !== undefined &&
      (typeof receipt.installedPluginsPath !== 'string' || receipt.installedPluginsPath.length === 0)) {
    result.errors.push('deployment receipt installedPluginsPath must be a non-empty string when provided');
  }
  if (receipt.sourceRoot !== undefined &&
      (typeof receipt.sourceRoot !== 'string' || receipt.sourceRoot.length === 0)) {
    result.errors.push('deployment receipt sourceRoot must be a non-empty string when provided');
  }
  if (receipt.installationRoots === null || typeof receipt.installationRoots !== 'object' || Array.isArray(receipt.installationRoots)) {
    result.errors.push('deployment receipt installationRoots must be an object');
    return;
  }
  for (const name of INSTALL_KINDS) {
    if (typeof receipt.installationRoots[name] !== 'string' || receipt.installationRoots[name].length === 0) {
      result.errors.push(`deployment receipt installationRoots.${name} must be a non-empty string`);
    }
  }
}

function checkSourceRoot(result, sourceRoot, receipt) {
  let actualCommit;
  try {
    actualCommit = childProcess.execFileSync(
      'git',
      ['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    addComparison(
      result,
      'source Git commit',
      receipt.commit.toLowerCase(),
      actualCommit.toLowerCase(),
      'source Git commit',
    );
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    result.errors.push(`source Git commit could not be read from ${sourceRoot}: ${detail}`);
  }

  const workerPath = path.join(sourceRoot, 'plugin', 'scripts', 'worker-service.cjs');
  let contents;
  try {
    contents = fs.readFileSync(workerPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      result.errors.push(`source worker bundle is missing at ${workerPath}`);
    } else {
      result.errors.push(`source worker bundle could not be read at ${workerPath}: ${error.message}`);
    }
    return;
  }
  const actualSha256 = crypto.createHash('sha256').update(contents).digest('hex');
  addComparison(
    result,
    'source worker SHA-256',
    receipt.workerSha256.toLowerCase(),
    actualSha256,
    'source worker SHA-256',
  );
}

function checkInstallRoot(result, name, root, receipt) {
  const packagePath = path.join(root, 'package.json');
  const packageJson = readJsonDocument(packagePath, `${name} package.json`, result);
  if (packageJson) {
    addComparison(
      result,
      `${name} package version`,
      receipt.version,
      packageJson.version,
      `${name} package version`,
    );
  }

  const manifestDirectory = name === 'codex' ? '.codex-plugin' : '.claude-plugin';
  const manifestPath = path.join(root, manifestDirectory, 'plugin.json');
  const manifest = readJsonDocument(manifestPath, `${name} manifest`, result);
  if (manifest) {
    const comparableVersion = name === 'codex' && typeof manifest.version === 'string'
      ? manifest.version.split('+', 1)[0]
      : manifest.version;
    addComparison(
      result,
      `${name} manifest version`,
      receipt.version,
      comparableVersion,
      `${name} manifest version`,
    );
  }

  const workerPath = path.join(root, 'scripts', 'worker-service.cjs');
  let contents;
  try {
    contents = fs.readFileSync(workerPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      result.errors.push(`${name} worker bundle is missing at ${workerPath}`);
    } else {
      result.errors.push(`${name} worker bundle could not be read at ${workerPath}: ${error.message}`);
    }
    return;
  }
  const actualSha256 = crypto.createHash('sha256').update(contents).digest('hex');
  addComparison(
    result,
    `${name} worker SHA-256`,
    receipt.workerSha256.toLowerCase(),
    actualSha256,
    `${name} worker SHA-256`,
  );
}

function checkActiveClaudeInstall(result, receipt) {
  const installedPluginsPath = receipt.installedPluginsPath || path.join(
    path.dirname(receipt.knownMarketplacesPath),
    'installed_plugins.json',
  );
  const installedPlugins = readJsonDocument(
    installedPluginsPath,
    'installed_plugins.json',
    result,
  );
  if (!installedPlugins) return;

  const entries = installedPlugins.plugins?.['claude-mem@thedotmack'];
  const userEntry = Array.isArray(entries)
    ? entries.find((entry) => entry && entry.scope === 'user')
    : undefined;
  if (!userEntry) {
    result.errors.push(
      'installed_plugins.json has no user-scoped claude-mem@thedotmack entry ' +
      `at ${installedPluginsPath}`,
    );
    return;
  }

  addComparison(
    result,
    'active Claude install path',
    receipt.installationRoots.claude,
    userEntry.installPath,
    'active Claude install path',
  );
  addComparison(
    result,
    'active Claude version',
    receipt.version,
    userEntry.version,
    'active Claude version',
  );
}

function auditLocalInstall(receiptPath) {
  const result = emptyResult(receiptPath);
  const receipt = readJsonDocument(receiptPath, 'deployment receipt', result);
  if (!receipt) return result;

  result.version = receipt.version;
  result.commit = receipt.commit;
  validateReceipt(receipt, result);
  if (result.errors.length > 0) return result;

  for (const name of INSTALL_KINDS) {
    checkInstallRoot(result, name, receipt.installationRoots[name], receipt);
  }
  if (receipt.sourceRoot !== undefined) {
    checkSourceRoot(result, receipt.sourceRoot, receipt);
  }

  const knownMarketplaces = readJsonDocument(
    receipt.knownMarketplacesPath,
    'known_marketplaces.json',
    result,
  );
  if (knownMarketplaces) {
    const autoUpdate = knownMarketplaces.thedotmack?.autoUpdate;
    const autoUpdateOk = autoUpdate === false;
    result.checks.push({
      name: 'thedotmack marketplace auto-update disabled',
      ok: autoUpdateOk,
      expected: false,
      actual: autoUpdate,
    });
    if (!autoUpdateOk) {
      result.errors.push(
        'known_marketplaces.json thedotmack.autoUpdate must be explicitly false ' +
        `(found ${autoUpdate === undefined ? 'missing' : JSON.stringify(autoUpdate)})`,
      );
    }
  }
  checkActiveClaudeInstall(result, receipt);

  result.ok = result.errors.length === 0;
  return result;
}

function formatAuditResult(result) {
  if (result.ok) {
    return [
      'claude-mem local installation audit passed',
      `receipt: ${result.receiptPath}`,
      `version ${result.version}; commit ${result.commit}`,
      `${result.checks.length} checks passed`,
    ].join('\n');
  }

  const lines = [
    'claude-mem local installation audit failed',
    `receipt: ${result.receiptPath}`,
  ];
  if (result.version || result.commit) {
    lines.push(`recorded version ${result.version ?? 'unknown'}; commit ${result.commit ?? 'unknown'}`);
  }
  lines.push(...result.errors.map((error) => `- ${error}`));
  lines.push('Action: correct the listed drift, redeploy from the recorded source and replace this receipt.');
  return lines.join('\n');
}

if (require.main === module) {
  const receiptPath = process.argv[2] || path.join(
    os.homedir(),
    '.local',
    'state',
    'claude-mem-maintenance',
    'deployment.json',
  );
  const result = auditLocalInstall(receiptPath);
  const output = `${formatAuditResult(result)}\n`;
  if (result.ok) {
    process.stdout.write(output);
  } else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
}

module.exports = { auditLocalInstall, formatAuditResult };
