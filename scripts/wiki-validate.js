#!/usr/bin/env node
/**
 * wiki-validate.js — Wikilink integrity + provenance footers for compiled pages.
 *
 * Two guarantees borrowed from mnemo-cortex's WikAI:
 *   1. No hallucinated wikilinks — every [[target]] must resolve to a real page
 *      (or a real heading anchor) in the vault. Broken/invented links are the
 *      #1 way an auto-compiled knowledge base rots silently.
 *   2. Provenance footers — every compiled page carries a footer listing the
 *      source ids that fed it, so any claim is auditable back to its origin.
 *
 * Zero external deps. Works over the memory corpus or a dedicated wiki dir.
 *
 * Usage:
 *   node wiki-validate.js validate [--wiki DIR] [--require-provenance] [--json]
 *   node wiki-validate.js stamp <file> --sources id1,id2,id3 [--date YYYY-MM-DD]
 *
 * Exit code: `validate` exits 1 if any broken link (or missing provenance when
 * --require-provenance) is found — so it can gate a compile step in CI/cron.
 *
 * Env:
 *   MEMSTACK_ROOT   default vault root (workspace, 3 dirs up)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function vaultRoot(flag) {
  return flag || process.env.MEMSTACK_ROOT || path.resolve(__dirname, '..', '..', '..');
}

// --- collect pages --------------------------------------------------------
function listMarkdown(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d, { withFileTypes: true })) {
      if (name.name.startsWith('.') || name.name === 'node_modules') continue;
      const p = path.join(d, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function slug(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build the set of valid link targets: page names (basename w/o ext) and
// "page#heading" anchors, all slugified for tolerant matching.
function buildTargetIndex(files, root) {
  const pages = new Set();
  const anchors = new Set();
  for (const f of files) {
    const base = path.basename(f, '.md');
    pages.add(slug(base));
    const text = fs.readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      const h = line.match(/^#{1,6}\s+(.*)/);
      if (h) {
        anchors.add(`${slug(base)}#${slug(h[1])}`);
        anchors.add(slug(h[1])); // allow bare [[#heading]]-style / cross-page heading refs
      }
    }
  }
  return { pages, anchors };
}

// --- scan wikilinks -------------------------------------------------------
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

// OpenClaw output directives share the [[...]] syntax but are NOT wikilinks;
// they leak into logged transcripts/daily notes. Ignore them to avoid false
// "broken link" positives.
const DIRECTIVE_RE = /^(reply_to_current|audio_as_voice|reply_to:.*)$/i;

function resolveTarget(raw, index) {
  // strip alias:  [[Target|shown text]] -> Target
  const target = raw.split('|')[0].trim();
  if (!target) return { ok: false, target };
  const [page, heading] = target.split('#');
  const pageSlug = slug(page);
  if (heading) {
    const anchor = `${pageSlug}#${slug(heading)}`;
    return { ok: index.anchors.has(anchor) || (index.pages.has(pageSlug) && index.anchors.has(slug(heading))), target };
  }
  return { ok: index.pages.has(pageSlug) || index.anchors.has(pageSlug), target };
}

// --- provenance -----------------------------------------------------------
const PROV_RE = /<!--\s*provenance:\s*([^>]*?)\s*-->/i;

function hasProvenance(text) {
  const m = text.match(PROV_RE);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function stampProvenance(text, sources, date) {
  const idList = sources.join(', ');
  const block = `<!-- provenance: ${idList} -->\n> _Fuentes: ${idList}${date ? ` · compilado ${date}` : ''}_`;
  // replace an existing managed footer, else append
  const existing = new RegExp(`${PROV_RE.source}(\\n>[^\\n]*)?`, 'i');
  if (existing.test(text)) return text.replace(existing, block);
  return text.replace(/\s*$/, '\n\n') + block + '\n';
}

// --- validate -------------------------------------------------------------
function validate(root, { requireProvenance = false } = {}) {
  const files = listMarkdown(root);
  const index = buildTargetIndex(files, root);
  const broken = [];
  const missingProv = [];
  let linkCount = 0;

  for (const f of files) {
    const rel = path.relative(root, f);
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      let m;
      WIKILINK_RE.lastIndex = 0;
      while ((m = WIKILINK_RE.exec(line))) {
        if (DIRECTIVE_RE.test(m[1].split('|')[0].trim())) continue; // skip OpenClaw directives
        linkCount++;
        const r = resolveTarget(m[1], index);
        if (!r.ok) broken.push({ file: rel, line: i + 1, target: r.target, raw: m[0] });
      }
    });
    if (requireProvenance && hasProvenance(text) === null) missingProv.push(rel);
  }
  return { files: files.length, linkCount, broken, missingProv, index };
}

// --- cli ------------------------------------------------------------------
function parse(args) {
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--require-provenance') flags.requireProvenance = true;
    else if (a === '--wiki') flags.wiki = args[++i];
    else if (a === '--sources') flags.sources = args[++i];
    else if (a === '--date') flags.date = args[++i];
    else pos.push(a);
  }
  return { flags, pos };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parse(rest);

  if (cmd === 'validate') {
    const root = vaultRoot(flags.wiki);
    const res = validate(root, { requireProvenance: flags.requireProvenance });
    if (flags.json) {
      console.log(JSON.stringify({ files: res.files, linkCount: res.linkCount, broken: res.broken, missingProvenance: res.missingProv }, null, 2));
    } else {
      console.log(`Scanned ${res.files} pages, ${res.linkCount} wikilinks.`);
      if (!res.broken.length) console.log('✓ No broken/hallucinated wikilinks.');
      else {
        console.log(`✗ ${res.broken.length} broken wikilink(s):`);
        for (const b of res.broken) console.log(`  ${b.file}:${b.line}  ${b.raw} → unresolved "${b.target}"`);
      }
      if (flags.requireProvenance) {
        if (!res.missingProv.length) console.log('✓ All pages carry a provenance footer.');
        else {
          console.log(`✗ ${res.missingProv.length} page(s) missing provenance:`);
          for (const p of res.missingProv) console.log(`  ${p}`);
        }
      }
    }
    const failed = res.broken.length || (flags.requireProvenance && res.missingProv.length);
    process.exitCode = failed ? 1 : 0;
    return;
  }

  if (cmd === 'stamp') {
    const file = pos[0];
    if (!file || !flags.sources) {
      console.log('usage: stamp <file> --sources id1,id2 [--date YYYY-MM-DD]');
      process.exitCode = 1;
      return;
    }
    const sources = flags.sources.split(',').map((s) => s.trim()).filter(Boolean);
    const text = fs.readFileSync(file, 'utf8');
    const stamped = stampProvenance(text, sources, flags.date);
    fs.writeFileSync(file, stamped);
    console.log(`stamped ${sources.length} source(s) into ${path.basename(file)}`);
    return;
  }

  console.log('wiki-validate.js — commands:');
  console.log('  validate [--wiki DIR] [--require-provenance] [--json]');
  console.log('  stamp <file> --sources id1,id2 [--date YYYY-MM-DD]');
  process.exitCode = cmd ? 1 : 0;
}

if (require.main === module) main();

module.exports = { validate, buildTargetIndex, resolveTarget, hasProvenance, stampProvenance, slug };
