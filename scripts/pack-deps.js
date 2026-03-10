#!/usr/bin/env node
/**
 * scripts/pack-deps.js
 *
 * Packs apps/web/node_modules into a single compressed archive
 * (node_modules.tar.gz) for fast Windows NSIS installation.
 *
 * WHY:
 *   NSIS writes files to disk one-by-one. node_modules has ~50 000 small files
 *   → 3-5 minute install. With ONE archive file, NSIS writes it in <10 seconds.
 *   electron/main.js then extracts the archive on first launch (~15-20 seconds),
 *   showing "First-time setup…" in the splash screen.
 *
 * PREREQUISITES:
 *   `tar` — built into Windows 10+ (bsdtar), macOS, and Linux. No install needed.
 *
 * OUTPUT:
 *   apps/web/node_modules.tar.gz  (shipped as extraResource in Windows build)
 *
 * Run automatically as part of `npm run build:win` (see package.json).
 * Safe to run multiple times — always overwrites previous output.
 */

'use strict';

const path      = require('path');
const fs        = require('fs');
const { spawnSync } = require('child_process');

const WEB_DIR     = path.join(__dirname, '..', 'apps', 'web');
const NODE_MODS   = path.join(WEB_DIR, 'node_modules');
const OUTPUT_FILE = path.join(WEB_DIR, 'node_modules.tar.gz');

// ── Guard: node_modules must exist ───────────────────────────────────────────
if (!fs.existsSync(NODE_MODS)) {
    console.error('\n❌  apps/web/node_modules not found.');
    console.error('    Run first: cd apps/web && npm install --legacy-peer-deps\n');
    process.exit(1);
}

// ── Remove stale archive if present ──────────────────────────────────────────
if (fs.existsSync(OUTPUT_FILE)) {
    fs.rmSync(OUTPUT_FILE);
    console.log('  ↺  Removed stale node_modules.tar.gz');
}

console.log('\n📦  Packing node_modules into a single archive…');
console.log('    (Takes 30–90 s on first run — saves 3+ min from every Windows install)\n');

// ── Run tar ───────────────────────────────────────────────────────────────────
// `tar` is available on Windows 10+ (bsdtar), macOS, and Linux.
// We change into WEB_DIR first (-C) so the archive contains paths like
//   node_modules/lodash/…   (relative, not absolute)
// which is what the extraction step in main.js expects.
const result = spawnSync(
    'tar',
    [
        '-czf', OUTPUT_FILE,       // create compressed archive at OUTPUT_FILE
        '--exclude=.cache',        // skip npm/babel cache (safe to rebuild)
        '--exclude=.package-lock.json',
        '-C', WEB_DIR,             // change to web dir before archiving
        'node_modules',            // archive the node_modules folder
    ],
    {
        stdio:  'inherit',         // show progress / errors in the terminal
        shell:  false,             // don't route through cmd.exe on Windows
    }
);

if (result.status !== 0) {
    console.error('\n❌  tar failed (exit code ' + result.status + ').');
    console.error('    Windows 10+: tar.exe is built in. Check your PATH or try running as Administrator.');
    if (result.error) console.error('   ', result.error.message);
    process.exit(1);
}

// ── Report ────────────────────────────────────────────────────────────────────
const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1);
console.log(`\n✅  node_modules.tar.gz → ${sizeMB} MB  (one file for NSIS to write)\n`);
