#!/usr/bin/env node
/**
 * build-bootstrap.js
 * Compila un BOOTSTRAP.md compacto a partir de los archivos de memoria dispersos.
 * Se ejecuta via cron nocturno. El agente lo lee en lugar de múltiples ficheros.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const OUT = path.join(WORKSPACE, 'BOOTSTRAP.md');
const TG = path.join(WORKSPACE, 'scripts/tg-send.js');
const CHAT_LOGS = '-1003751740090';

function tgLog(msg) {
  try { execSync(`node ${TG} ${CHAT_LOGS} ${JSON.stringify(msg)}`, { encoding: 'utf8' }); } catch {}
}

function readFile(filePath, maxLines = 9999) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(0, maxLines).join('\n').trim();
  } catch { return null; }
}

function getDateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}

function truncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  return text.substring(0, maxChars) + '\n…[truncado]';
}

// --- Build sections ---

const today = getDateStr(0);
const yesterday = getDateStr(-1);
const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });

const sections = [];

sections.push(`# BOOTSTRAP.md — Compilado ${now}`);
sections.push(`> Generado automáticamente. No editar manualmente.`);
sections.push(``);

// 1. MEMORY.md (hechos curados)
const memory = readFile(path.join(WORKSPACE, 'MEMORY.md'));
if (memory) {
  sections.push(`## Memoria curada (MEMORY.md)`);
  sections.push(truncate(memory, 2000));
  sections.push(``);
}

// 2. Daily notes (hoy + ayer)
for (const [label, dateStr] of [['Hoy', today], ['Ayer', yesterday]]) {
  const daily = readFile(path.join(WORKSPACE, 'memory', `${dateStr}.md`));
  if (daily) {
    sections.push(`## Daily note — ${label} (${dateStr})`);
    sections.push(truncate(daily, 1500));
    sections.push(``);
  }
}

// 3. Memoria temática (viajes, salud, técnico)
for (const [label, file] of [
  ['Viajes', 'memory/viajes.md'],
  ['Salud', 'memory/salud.md'],
  ['Técnico', 'memory/tecnico.md'],
]) {
  const content = readFile(path.join(WORKSPACE, file));
  if (content) {
    sections.push(`## ${label}`);
    sections.push(truncate(content, 800));
    sections.push(``);
  }
}

// 4. Próximos viajes (extracto de viajes-kayak.md)
const kayak = readFile(path.join(WORKSPACE, 'reference/viajes-kayak.md'));
if (kayak) {
  // Extract just the upcoming trips section (first 50 lines)
  const lines = kayak.split('\n').slice(0, 60).join('\n');
  sections.push(`## Próximos viajes (resumen)`);
  sections.push(truncate(lines, 1200));
  sections.push(``);
}

// 5. Salud — últimas entradas
const saludDatos = readFile(path.join(WORKSPACE, 'reference/salud-datos.md'));
if (saludDatos) {
  const lines = saludDatos.split('\n');
  const lastLines = lines.slice(-15).join('\n'); // last 15 lines = ~15 days
  sections.push(`## Salud — últimos registros`);
  sections.push(lastLines);
  sections.push(``);
}

// Write output
const output = sections.join('\n');
fs.writeFileSync(OUT, output, 'utf8');

const sizeKB = (output.length / 1024).toFixed(1);
console.log(`OK: ${sizeKB}KB`);
tgLog(`📄 BOOTSTRAP.md compilado — ${sizeKB}KB`);
