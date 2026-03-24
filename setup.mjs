#!/usr/bin/env node

/**
 * Cross-platform setup script for Lakehouse Analytics.
 * Works on macOS, Linux, and Windows.
 *
 * Usage: node setup.mjs
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';
import { createInterface } from 'readline';

const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';

// --- Helpers ---

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function log(msg) { console.log(msg); }
function ok(label, detail = '') { console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${detail}` : ''}`); }
function fail(label) { console.log(`  ${RED}✗${RESET} ${label}`); }
function warn(msg) { console.log(`  ${YELLOW}!${RESET} ${msg}`); }

function commandExists(cmd) {
  try {
    const check = isWindows ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getVersion(cmd, flag = '--version') {
  try {
    return execSync(`${cmd} ${flag}`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// --- Checks ---

log(`\n${BOLD}=== Lakehouse Analytics Setup ===${RESET}\n`);
log(`Platform: ${platform()}\n`);

let missing = [];

// Node.js
log('Checking dependencies...\n');

const nodeVer = getVersion('node', '-v');
if (nodeVer) {
  const major = parseInt(nodeVer.replace('v', '').split('.')[0]);
  if (major >= 18) {
    ok('Node.js', `(${nodeVer})`);
  } else {
    fail(`Node.js ${nodeVer} — need v18+`);
    missing.push('node');
  }
} else {
  fail('Node.js — not found');
  missing.push('node');
}

// npm
if (commandExists('npm')) {
  ok('npm', `(${getVersion('npm', '-v') || 'installed'})`);
} else {
  fail('npm — not found (comes with Node.js)');
  missing.push('npm');
}

// uv/uvx (for Trino MCP)
if (commandExists('uvx')) {
  ok('uvx', '(for Trino MCP server)');
} else if (commandExists('uv')) {
  ok('uv', '(uvx available via uv tool run)');
} else {
  fail('uv/uvx — not found (needed for Trino MCP server)');
  missing.push('uv');
}

log('');

// --- Install missing deps ---

if (missing.length > 0) {
  log(`${RED}Missing: ${missing.join(', ')}${RESET}\n`);

  if (isMac && commandExists('brew')) {
    const reply = await ask('Install missing dependencies with Homebrew? (y/N) ');
    if (reply.toLowerCase() === 'y') {
      for (const dep of missing) {
        if (dep === 'npm') continue; // comes with node
        log(`\nInstalling ${dep}...`);
        try {
          execSync(`brew install ${dep}`, { stdio: 'inherit' });
          ok(`${dep} installed`);
        } catch {
          fail(`Failed to install ${dep}`);
        }
      }
      log('');
    } else {
      printManualInstall(missing);
      process.exit(1);
    }
  } else if (isWindows) {
    if (commandExists('winget')) {
      const reply = await ask('Install missing dependencies with winget? (y/N) ');
      if (reply.toLowerCase() === 'y') {
        for (const dep of missing) {
          if (dep === 'npm') continue;
          const wingetId = dep === 'node' ? 'OpenJS.NodeJS.LTS' : dep === 'uv' ? 'astral-sh.uv' : null;
          if (wingetId) {
            log(`\nInstalling ${dep}...`);
            try {
              execSync(`winget install -e --id ${wingetId}`, { stdio: 'inherit' });
              ok(`${dep} installed`);
            } catch {
              fail(`Failed to install ${dep}`);
            }
          }
        }
        log(`\n${YELLOW}You may need to restart your terminal for PATH changes.${RESET}\n`);
      } else {
        printManualInstall(missing);
        process.exit(1);
      }
    } else {
      printManualInstall(missing);
      process.exit(1);
    }
  } else {
    printManualInstall(missing);
    process.exit(1);
  }
}

// --- npm install ---

log('Installing npm packages...\n');
try {
  // On Windows, use npm.cmd explicitly to avoid PowerShell execution policy issues with npm.ps1
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';
  execSync(`${npmCmd} install`, { stdio: 'inherit' });
  log('');
  ok('npm packages installed');
} catch (e) {
  if (isWindows && String(e).includes('cannot be loaded')) {
    fail('npm.ps1 blocked by PowerShell execution policy');
    log(`\n${YELLOW}Fix: run this command in PowerShell, then retry:${RESET}`);
    log(`  ${BOLD}Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned${RESET}\n`);
    log(`Or use Command Prompt (cmd.exe) instead of PowerShell.\n`);
  } else {
    fail('npm install failed');
  }
  process.exit(1);
}

// --- Pre-warm Trino MCP ---

log('\nPre-warming Trino MCP server (downloads dependencies on first run)...');
const uvxCmd = commandExists('uvx') ? 'uvx' : commandExists('uv') ? 'uv tool run' : null;
if (uvxCmd) {
  const result = spawnSync(
    uvxCmd.split(' ')[0],
    [...(uvxCmd.includes(' ') ? ['tool', 'run'] : []), '--from', 'git+https://github.com/Remitly/toolbox.git#subdirectory=trino', 'trino-mcp', '--help'],
    { timeout: 60000, stdio: 'pipe' }
  );
  if (result.status === 0 || result.status === null) {
    ok('Trino MCP dependencies cached');
  } else {
    warn('Trino MCP pre-warm failed (will download on first query)');
  }
} else {
  warn('Skipped (uvx not found)');
}

// --- .env.local check ---

log('');
if (existsSync('.env.local')) {
  ok('.env.local exists — settings can be updated in the app UI');
} else {
  warn('No .env.local found — the app will prompt for your API key on first launch');
}

// --- Done ---

log(`\n${GREEN}${BOLD}=== Setup complete ===${RESET}\n`);
log('Start the app:');
log(`  ${BOLD}${isWindows ? 'npm.cmd' : 'npm'} run dev${RESET}\n`);
log(`Then open ${BOLD}http://localhost:3000${RESET}\n`);

// --- Helper ---

function printManualInstall(deps) {
  log(`\n${YELLOW}Please install manually:${RESET}\n`);
  for (const dep of deps) {
    if (dep === 'node') {
      log('  Node.js 18+:  https://nodejs.org/');
      if (isWindows) log('                winget install OpenJS.NodeJS.LTS');
      else if (isMac) log('                brew install node');
      else log('                See https://nodejs.org/en/download/package-manager');
    } else if (dep === 'uv') {
      log('  uv (Python):  https://docs.astral.sh/uv/');
      if (isWindows) log('                winget install astral-sh.uv');
      else if (isMac) log('                brew install uv');
      else log('                curl -LsSf https://astral.sh/uv/install.sh | sh');
    }
  }
  log('');
}
