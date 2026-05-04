#!/usr/bin/env node
/**
 * memory-compact-promoted.js
 *
 * Compacts "Promoted From Short-Term Memory" blocks in MEMORY.md.
 *
 * Dreaming (OpenClaw 2026.4.8+) promotes full blocks from memory/archive/*.md
 * into MEMORY.md with provenance markers like:
 *   <!-- openclaw-memory-promotion:memory:memory/archive/2026-04-01.md:36:50 -->
 *
 * These blocks can be large (500-1500+ chars each) and accumulate over time,
 * inflating MEMORY.md beyond the bootstrap injection limit (~12KB default) —
 * defeating the point of L1 staying compact.
 *
 * This script:
 *   1. Parses MEMORY.md for <!-- openclaw-memory-promotion:... --> markers
 *   2. For each promoted block older than --min-age-days (default 2):
 *      - Verifies the source archive file still exists (no data loss risk)
 *      - Replaces the full block with a compact reference stub
 *   3. Writes a backup (.bak-<timestamp>) before mutating
 *   4. Idempotent: already-compacted blocks (marked with <!-- compacted:YYYY-MM-DD -->)
 *      are skipped.
 *
 * The original content remains in memory/archive/<file>.md and is still
 * discoverable via memory_search — only the duplicate in MEMORY.md is pruned.
 *
 * Usage:
 *   node scripts/memory-compact-promoted.js                   # compact with defaults
 *   node scripts/memory-compact-promoted.js --dry             # preview only
 *   node scripts/memory-compact-promoted.js --min-age-days=0  # compact all ages
 *   node scripts/memory-compact-promoted.js --workspace=/path # override workspace root
 *
 * Designed to run daily shortly after Dreaming.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry') || args.includes('--dry-run');
const minAgeDays = (() => {
  const arg = args.find(a => a.startsWith('--min-age-days='));
  return arg ? parseInt(arg.split('=')[1], 10) : 2;
})();
const WORKSPACE = (() => {
  const arg = args.find(a => a.startsWith('--workspace='));
  if (arg) return path.resolve(arg.split('=')[1]);
  // Default: parent of this script's directory
  return path.resolve(__dirname, '..');
})();
const MEMORY_PATH = path.join(WORKSPACE, 'MEMORY.md');

const PROMOTION_RE = /<!--\s*openclaw-memory-promotion:([^:]+):([^:]+):(\d+):(\d+)\s*-->/;
const COMPACTED_MARKER = 'compacted:';

function log(...msg) {
  if (!process.env.SILENT) console.log(...msg);
}

function backup(content) {
  const stamp = Math.floor(Date.now() / 1000);
  const bakPath = `${MEMORY_PATH}.bak-${stamp}`;
  fs.writeFileSync(bakPath, content, 'utf8');
  return bakPath;
}

function daysBetween(dateStr, now = new Date()) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((now - d) / 86400000);
}

function compactPromotedBlocks(content) {
  const lines = content.split('\n');
  const out = [];
  const stats = { changed: 0, skippedRecent: 0, skippedMissing: 0, skippedCompacted: 0 };

  // Track current "Promoted From Short-Term Memory (YYYY-MM-DD)" section date
  let currentSectionDate = null;
  const headerRe = /^##\s+Promoted From Short-Term Memory \((\d{4}-\d{2}-\d{2})\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const headerMatch = line.match(headerRe);
    if (headerMatch) {
      currentSectionDate = headerMatch[1];
      out.push(line);
      continue;
    }

    const promoMatch = line.match(PROMOTION_RE);
    if (!promoMatch) {
      out.push(line);
      continue;
    }

    // Already compacted? skip.
    if (line.includes(COMPACTED_MARKER)) {
      stats.skippedCompacted++;
      out.push(line);
      continue;
    }

    const [, kind, relPath, startLine, endLine] = promoMatch;
    const archivePath = path.join(WORKSPACE, relPath);

    // Safety: don't compact if source archive is missing
    if (!fs.existsSync(archivePath)) {
      stats.skippedMissing++;
      out.push(line);
      continue;
    }

    // Age check based on section date header (promotion date)
    const age = currentSectionDate ? daysBetween(currentSectionDate) : minAgeDays;
    if (age !== null && age < minAgeDays) {
      stats.skippedRecent++;
      out.push(line);
      // Keep the full following content too
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.match(PROMOTION_RE) || next.match(headerRe) || next.startsWith('## ')) break;
        out.push(next);
        i++;
      }
      continue;
    }

    // Compact: replace marker + following content block with a stub line.
    const today = new Date().toISOString().slice(0, 10);
    const stub = `<!-- openclaw-memory-promotion:${kind}:${relPath}:${startLine}:${endLine} --> <!-- ${COMPACTED_MARKER}${today} -->\n- \`${relPath}\` lines ${startLine}-${endLine} (compacted ${today}; search with memory_search or read archive)`;
    out.push(stub);

    // Skip the following content lines (until next marker / section / EOF)
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.match(PROMOTION_RE) || next.match(headerRe) || next.startsWith('## ')) break;
      i++; // consume
    }
    stats.changed++;
  }

  return { content: out.join('\n'), stats };
}

function main() {
  if (!fs.existsSync(MEMORY_PATH)) {
    console.error(`MEMORY.md not found at ${MEMORY_PATH}`);
    process.exit(1);
  }

  const original = fs.readFileSync(MEMORY_PATH, 'utf8');
  const before = Buffer.byteLength(original, 'utf8');

  const { content: compacted, stats } = compactPromotedBlocks(original);
  const after = Buffer.byteLength(compacted, 'utf8');

  if (compacted === original) {
    log(`MEMORY.md already clean (${before} bytes). Stats: ${JSON.stringify(stats)}`);
    process.exit(0);
  }

  log(`MEMORY.md: ${before} → ${after} bytes (${before - after} freed, ${stats.changed} blocks compacted)`);
  log(`Skipped: ${stats.skippedRecent} recent, ${stats.skippedMissing} missing archive, ${stats.skippedCompacted} already compacted`);

  if (dryRun) {
    log('[dry-run] not writing.');
    process.exit(0);
  }

  const bakPath = backup(original);
  fs.writeFileSync(MEMORY_PATH, compacted, 'utf8');
  log(`Backup: ${bakPath}`);
  log('Done.');
}

if (require.main === module) main();
