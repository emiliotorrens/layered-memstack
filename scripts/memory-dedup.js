#!/usr/bin/env node
/**
 * memory-dedup.js — Deduplicación de MEMORY.md
 *
 * Modos:
 *   --check              Lista duplicados sin modificar nada
 *   --fix                Elimina exactos, marca semánticos con <!-- dup? -->
 *   --query "texto"      Comprueba si un texto ya existe (exit 0 = duplicado, 1 = nuevo)
 *   --query-batch file   Lee líneas de un archivo y filtra las que ya existen
 *
 * Opciones:
 *   --file path          Archivo a analizar (default: MEMORY.md)
 *   --threshold 0.75     Umbral de similitud semántica (default: 0.75)
 *   --verbose            Muestra detalles de cada comparación
 *
 * Como módulo:
 *   const { isDuplicate, findDuplicates, dedup } = require('./memory-dedup');
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(WORKSPACE, 'MEMORY.md');
const DEFAULT_THRESHOLD = 0.65;

// ─── Text normalization ────────────────────────────────────────────────────

function normalize(line) {
  return line
    .replace(/<!--.*?-->/g, '')           // strip HTML comments (TTL, dup markers)
    .replace(/\*\*/g, '')                 // strip bold
    .replace(/[`_~]/g, '')               // strip code, italic, strikethrough
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/#{1,6}\s*/g, '')            // strip headings
    .replace(/[-*]\s+/g, '')             // strip list markers
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim()
    .toLowerCase();
}

function tokenize(text) {
  const normalized = normalize(text);
  // Split on non-alphanumeric (keep accented chars), filter short tokens
  return normalized
    .split(/[^a-záéíóúñüà-ÿ0-9]+/i)
    .filter(t => t.length > 1);
}

// ─── Similarity metrics ────────────────────────────────────────────────────

function jaccardSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function containsSimilarity(tokensA, tokensB) {
  // How much of the shorter is contained in the longer
  if (!tokensA.length || !tokensB.length) return 0;
  const [shorter, longer] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB] : [tokensB, tokensA];
  const longerSet = new Set(longer);
  const overlap = shorter.filter(t => longerSet.has(t)).length;
  return overlap / shorter.length;
}

// Key entities: numbers, dates, IDs, names (capitalized words)
function extractEntities(text) {
  const entities = new Set();
  const normalized = text.replace(/<!--.*?-->/g, '').replace(/\*\*/g, '');

  // Dates (YYYY-MM-DD, DD/MM, etc.)
  for (const m of normalized.matchAll(/\d{4}[-/]\d{2}[-/]\d{2}/g)) entities.add(m[0]);
  // Version numbers
  for (const m of normalized.matchAll(/v?\d+\.\d+[\.\d]*/g)) entities.add(m[0].toLowerCase());
  // Hex IDs (cron ids, etc.)
  for (const m of normalized.matchAll(/\b[a-f0-9]{6,}\b/gi)) entities.add(m[0].toLowerCase());
  // Phone numbers
  for (const m of normalized.matchAll(/\+\d[\d\s]{8,}/g)) entities.add(m[0].replace(/\s/g, ''));
  // Euro amounts
  for (const m of normalized.matchAll(/\d+[\.,]?\d*\s*€/g)) entities.add(m[0].replace(/\s/g, ''));
  // Telegram chat IDs
  for (const m of normalized.matchAll(/-\d{10,}/g)) entities.add(m[0]);

  return entities;
}

function entityOverlap(entA, entB) {
  if (!entA.size || !entB.size) return 0;
  const intersection = new Set([...entA].filter(x => entB.has(x)));
  const smaller = Math.min(entA.size, entB.size);
  return intersection.size / smaller;
}

/**
 * Split a line into semantic segments (by | — , and similar separators)
 */
function segmentize(text) {
  const cleaned = text.replace(/<!--.*?-->/g, '').replace(/^[-*]\s+/, '');
  return cleaned
    .split(/\s*[|—–]\s*|\s*,\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
}

/**
 * Combined similarity score between two lines.
 * Uses both whole-line and segment-level comparison.
 * Returns { score, reason }
 */
function similarity(lineA, lineB) {
  const normA = normalize(lineA);
  const normB = normalize(lineB);

  // Exact match after normalization
  if (normA === normB) return { score: 1.0, reason: 'exact' };

  // Skip very short lines (headers, empty)
  if (normA.length < 10 || normB.length < 10) return { score: 0, reason: 'too-short' };

  const tokA = tokenize(lineA);
  const tokB = tokenize(lineB);
  const jaccard = jaccardSimilarity(tokA, tokB);
  const containment = containsSimilarity(tokA, tokB);

  const entA = extractEntities(lineA);
  const entB = extractEntities(lineB);
  const entOverlap = entityOverlap(entA, entB);

  // Segment-level comparison: check if any segment of A is contained in B or vice versa
  const segsA = segmentize(lineA);
  const segsB = segmentize(lineB);
  let maxSegScore = 0;
  for (const sa of segsA) {
    for (const sb of segsB) {
      const tA = tokenize(sa);
      const tB = tokenize(sb);
      if (tA.length < 2 || tB.length < 2) continue;
      const segContain = containsSimilarity(tA, tB);
      const segJaccard = jaccardSimilarity(tA, tB);
      const segScore = segJaccard * 0.4 + segContain * 0.6;
      if (segScore > maxSegScore) maxSegScore = segScore;
    }
  }

  // Whole-line score
  const hasEntities = entA.size > 0 || entB.size > 0;
  const wholeScore = hasEntities
    ? jaccard * 0.3 + containment * 0.4 + entOverlap * 0.3
    : jaccard * 0.4 + containment * 0.6;

  // Final score: best of whole-line or segment-level (with a small bonus if both are high)
  const score = Math.max(wholeScore, maxSegScore * 0.9);

  let reason = 'semantic';
  if (jaccard > 0.9) reason = 'near-exact';
  else if (containment > 0.9 || maxSegScore > 0.85) reason = 'subset';
  else if (entOverlap > 0.8 && jaccard > 0.5) reason = 'same-entities';

  return { score, reason };
}

// ─── Core functions ────────────────────────────────────────────────────────

/**
 * Parse MEMORY.md into sections with their lines
 */
function parseMemory(content) {
  const lines = content.split('\n');
  const sections = [];
  let currentSection = { heading: '(top)', startLine: 0, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) {
      if (currentSection.lines.length) sections.push(currentSection);
      currentSection = { heading: line.trim(), startLine: i, lines: [] };
    } else if (line.trim()) {
      currentSection.lines.push({ text: line, lineNum: i });
    }
  }
  if (currentSection.lines.length) sections.push(currentSection);
  return sections;
}

/**
 * Check if a new text is a duplicate of any existing line.
 * Returns { isDup: bool, match: string|null, score: number, reason: string }
 */
function isDuplicate(newText, existingContent, threshold = DEFAULT_THRESHOLD) {
  const sections = parseMemory(existingContent);
  const allLines = sections.flatMap(s => s.lines);

  let bestMatch = { isDup: false, match: null, score: 0, reason: 'unique' };

  for (const existing of allLines) {
    const sim = similarity(newText, existing.text);
    if (sim.score > bestMatch.score) {
      bestMatch = {
        isDup: sim.score >= threshold,
        match: existing.text,
        score: sim.score,
        reason: sim.reason,
        lineNum: existing.lineNum,
      };
    }
  }

  return bestMatch;
}

/**
 * Find all duplicate pairs within a file
 */
function findDuplicates(content, threshold = DEFAULT_THRESHOLD) {
  const sections = parseMemory(content);
  const duplicates = [];
  const allLines = sections.flatMap(s =>
    s.lines.map(l => ({ ...l, section: s.heading }))
  );

  for (let i = 0; i < allLines.length; i++) {
    for (let j = i + 1; j < allLines.length; j++) {
      const sim = similarity(allLines[i].text, allLines[j].text);
      if (sim.score >= threshold) {
        duplicates.push({
          lineA: allLines[i],
          lineB: allLines[j],
          score: sim.score,
          reason: sim.reason,
        });
      }
    }
  }

  // Sort by score desc
  duplicates.sort((a, b) => b.score - a.score);
  return duplicates;
}

/**
 * Deduplicate: remove exact dups, mark semantic dups
 * Returns { cleaned: string, removed: number, marked: number }
 */
function dedup(content, threshold = DEFAULT_THRESHOLD) {
  const lines = content.split('\n');
  const seen = new Map(); // normalized → first line number
  const toRemove = new Set();
  const toMark = new Set();

  // Pass 1: Find exact duplicates (after normalization)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^#{1,3}\s/.test(line)) continue;
    const norm = normalize(line);
    if (norm.length < 10) continue;

    if (seen.has(norm)) {
      toRemove.add(i);
    } else {
      seen.set(norm, i);
    }
  }

  // Pass 2: Find semantic duplicates (pairwise within content lines)
  const contentLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim() || /^#{1,3}\s/.test(lines[i]) || toRemove.has(i)) continue;
    if (normalize(lines[i]).length < 10) continue;
    contentLines.push({ text: lines[i], idx: i });
  }

  for (let i = 0; i < contentLines.length; i++) {
    for (let j = i + 1; j < contentLines.length; j++) {
      if (toRemove.has(contentLines[j].idx) || toMark.has(contentLines[j].idx)) continue;
      const sim = similarity(contentLines[i].text, contentLines[j].text);
      if (sim.score >= threshold && sim.reason !== 'exact') {
        // Mark the LATER one as possible dup
        toMark.add(contentLines[j].idx);
      }
    }
  }

  // Apply changes
  let removed = 0, marked = 0;
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (toRemove.has(i)) {
      removed++;
      continue; // skip exact duplicates
    }
    if (toMark.has(i) && !lines[i].includes('<!-- dup? -->')) {
      result.push(lines[i] + ' <!-- dup? -->');
      marked++;
    } else {
      result.push(lines[i]);
    }
  }

  return { cleaned: result.join('\n'), removed, marked };
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = { isDuplicate, findDuplicates, dedup, similarity, normalize, tokenize };

// ─── CLI ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const hasFlag = (flag) => args.includes(flag);

  const filePath = getArg('--file') || DEFAULT_FILE;
  const threshold = parseFloat(getArg('--threshold') || DEFAULT_THRESHOLD);
  const verbose = hasFlag('--verbose');

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(2);
  }

  const content = fs.readFileSync(filePath, 'utf8');

  if (hasFlag('--check')) {
    // ─── Check mode ───
    const dups = findDuplicates(content, threshold);
    if (!dups.length) {
      console.log('✅ No duplicates found');
      process.exit(0);
    }

    console.log(`⚠️  Found ${dups.length} potential duplicate(s):\n`);
    for (const d of dups) {
      const scoreStr = (d.score * 100).toFixed(0);
      console.log(`[${scoreStr}% ${d.reason}]`);
      console.log(`  L${d.lineA.lineNum + 1}: ${d.lineA.text.trim().substring(0, 100)}`);
      console.log(`  L${d.lineB.lineNum + 1}: ${d.lineB.text.trim().substring(0, 100)}`);
      console.log();
    }
    process.exit(dups.length > 0 ? 1 : 0);

  } else if (hasFlag('--fix')) {
    // ─── Fix mode ───
    const { cleaned, removed, marked } = dedup(content, threshold);
    if (removed === 0 && marked === 0) {
      console.log('✅ No duplicates to fix');
      process.exit(0);
    }

    fs.writeFileSync(filePath, cleaned);
    console.log(`🧹 Dedup complete: ${removed} removed, ${marked} marked <!-- dup? -->`);
    process.exit(0);

  } else if (hasFlag('--query')) {
    // ─── Query mode: check if a specific text is a duplicate ───
    const query = getArg('--query');
    if (!query) { console.error('--query requires a text argument'); process.exit(2); }

    const result = isDuplicate(query, content, threshold);
    if (result.isDup) {
      console.log(JSON.stringify({ duplicate: true, score: result.score, reason: result.reason, match: result.match?.trim() }));
      process.exit(0); // 0 = is duplicate
    } else {
      if (verbose) console.log(JSON.stringify({ duplicate: false, bestScore: result.score, reason: result.reason }));
      process.exit(1); // 1 = is new
    }

  } else if (hasFlag('--query-batch')) {
    // ─── Batch query: filter lines from a file ───
    const batchFile = getArg('--query-batch');
    if (!batchFile || !fs.existsSync(batchFile)) { console.error('--query-batch requires a valid file path'); process.exit(2); }

    const newLines = fs.readFileSync(batchFile, 'utf8').split('\n').filter(l => l.trim());
    const unique = [];
    const dupes = [];

    for (const line of newLines) {
      const result = isDuplicate(line, content, threshold);
      if (result.isDup) {
        dupes.push({ line: line.trim(), score: result.score, match: result.match?.trim() });
      } else {
        unique.push(line);
      }
    }

    console.log(JSON.stringify({ unique, duplicates: dupes }, null, 2));
    process.exit(0);

  } else {
    console.log(`memory-dedup.js — Deduplicación de MEMORY.md

Modos:
  --check              Lista duplicados sin modificar nada
  --fix                Elimina exactos, marca semánticos con <!-- dup? -->
  --query "texto"      Comprueba si un texto ya existe (exit 0 = dup, 1 = nuevo)
  --query-batch file   Filtra líneas de un archivo que ya existen

Opciones:
  --file path          Archivo (default: MEMORY.md)
  --threshold 0.75     Umbral similitud (default: 0.75)
  --verbose            Más detalle`);
  }
}
