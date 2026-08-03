#!/usr/bin/env node
/**
 * memory-check-pointers.js — deterministic broken-pointer detector for LIVE memory.
 *
 * Why this exists: a layered memory system is held together by pointers. L1 points to
 * L2, L2 points to L3, INDEX.md points at everything. When a file is renamed, archived
 * or compressed, the pointers to it silently rot — and a rotten pointer is worse than a
 * missing note, because recall surfaces a breadcrumb that leads nowhere and the agent
 * confidently reports "detail in reference/foo.md" for a file that no longer exists.
 *
 * An LLM audit pass will not reliably catch this. Real case (2026-08-03): a weekly
 * memory-audit cron reported OK while two dead pointers sat in a topic file, because it
 * only checked the opposite direction (files without a pointer) instead of pointers
 * without a file. That direction is the one that hurts. This script checks it
 * deterministically, in ~50 ms, with an exit code a cron can branch on.
 *
 * SCOPE — deliberately LIVE memory only (what recall serves today):
 *   - root: MEMORY.md, USER.md, AGENTS.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md, INDEX.md
 *   - memory/*.md   (top level: recent dailies + topic files)
 *   - reference/*.md (top level)
 * EXCLUDED on purpose: memory/archive/, reference/archive/, memory/dreaming/ and other
 * nested history. Archived notes legitimately point at files that were later moved or
 * compressed; flagging those produces noise, not real debt.
 *
 * Ignore a specific line by appending:  <!-- pointer-check:ignore -->
 * (Useful for docs that quote example paths, including audit reports themselves.)
 *
 * Usage:
 *   node scripts/memory-check-pointers.js           # human report, exit 1 if broken
 *   node scripts/memory-check-pointers.js --quiet   # one line per break (for crons)
 *   node scripts/memory-check-pointers.js --json    # machine-readable
 *
 * Workspace root defaults to the parent of this script; override with
 * MEMSTACK_WORKSPACE=/path/to/workspace.
 *
 * Exit codes: 0 = all pointers resolve | 1 = at least one broken pointer
 */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(process.env.MEMSTACK_WORKSPACE || path.join(__dirname, '..'));
const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const JSON_OUT = args.includes('--json');

const ROOT_FILES = [
  'MEMORY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'INDEX.md',
];

// Directories whose *top level* is scanned as live memory.
const LIVE_DIRS = ['memory', 'reference'];

function collectSourceFiles() {
  const files = [];
  for (const r of ROOT_FILES) {
    const p = path.join(WS, r);
    if (fs.existsSync(p)) files.push(p);
  }
  // Top level only — no recursion, so archive/ and dreaming/ stay out.
  for (const dir of LIVE_DIRS) {
    const base = path.join(WS, dir);
    if (!fs.existsSync(base)) continue;
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push(path.join(base, e.name));
    }
  }
  return files;
}

// Matches workspace-relative paths written in prose, links or code spans.
const POINTER_RE =
  /\b((?:memory|reference|data|scripts|projects|skills|tmp)\/[A-Za-z0-9_@./-]+\.(?:md|csv|json|js|py|xlsx|sh|yaml|yml))/g;

// Templates and placeholders are not real paths.
function isPlaceholder(target) {
  return (
    target.includes('*') ||
    target.includes('<') ||
    /YYYY|MM-DD|HH|NNNN/.test(target) ||
    /\/(topic|name|file|slug|id|foo|bar|example)\./i.test(target)
  );
}

const broken = [];
const seen = new Set();
let pointerCount = 0;

for (const file of collectSourceFiles()) {
  const rel = path.relative(WS, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('pointer-check:ignore')) return;
    let m;
    POINTER_RE.lastIndex = 0;
    while ((m = POINTER_RE.exec(line)) !== null) {
      const target = m[1].replace(/[.,;:)\]}]+$/, '');
      if (isPlaceholder(target)) continue;
      pointerCount++;
      if (fs.existsSync(path.join(WS, target))) continue;
      const key = `${rel}:${i + 1}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      broken.push({ source: rel, line: i + 1, target, context: line.trim().slice(0, 130) });
    }
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ workspace: WS, pointerCount, brokenCount: broken.length, broken }, null, 2));
} else if (QUIET) {
  for (const b of broken) console.log(`${b.source}:${b.line} -> ${b.target}`);
} else {
  console.log(`🔗 Pointers checked (live memory): ${pointerCount}`);
  if (!broken.length) {
    console.log('✅ No broken pointers.');
  } else {
    console.log(`❌ BROKEN pointers: ${broken.length}\n`);
    for (const b of broken) {
      console.log(`  ${b.source}:${b.line}`);
      console.log(`    → missing: ${b.target}`);
      console.log(`    ctx: ${b.context}`);
    }
    console.log('\nFix by repointing to the real path (often memory/archive/… or reference/archive/…),');
    console.log('removing the dead breadcrumb, or marking the line <!-- pointer-check:ignore --> if it is an example.');
  }
}

process.exit(broken.length ? 1 : 0);
