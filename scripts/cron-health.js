#!/usr/bin/env node
/**
 * cron-health.js — deterministic pre-digest of cron state for the audit pass.
 *
 * Why this exists: an agentic "audit your crons" prompt is a trap. Asking the model to run
 * `openclaw cron list --all --json` and reason over the raw output means feeding it the full
 * job objects — prompts, schedules, run history — for every job you own. Measured on a real
 * install (2026-08-03): 51 jobs → 141,563 bytes → runs burning 250–630k tokens, failing
 * ~40% of the time with a generic timeout.
 *
 * That failure mode is self-concealing: the cron watchdog is the thing that reports other
 * crons failing, so when it dies of indigestion, *nothing* reports anything — including a
 * memory audit that had been silently skipping broken pointers for weeks.
 *
 * This script does the mechanical half (read live gateway state, keep only what is
 * actionable) and emits ~1–2 KB. Measured: 141 KB → 1.7 KB (−98.8%); the same audit run
 * went from error/390k tokens to ok/174k tokens in 44 s. The model only interprets and writes
 * the report — it should never list the crons itself.
 *
 * Usage:
 *   node scripts/cron-health.js           # compact text report
 *   node scripts/cron-health.js --json    # compact JSON
 *
 * Exit codes: 0 = nothing wrong | 1 = jobs in error | 2 = could not read gateway state
 */

const { execSync } = require('child_process');

const JSON_OUT = process.argv.includes('--json');
const NOW = Date.now();

function fetchJobs() {
  // The CLI talks straight to the gateway. Do NOT use the in-agent cron tool here: on
  // isolated cron sessions the narrow self-cleanup grant filters the response down to the
  // current job, so the audit would see only itself and report all-clear.
  const raw = execSync('openclaw cron list --all --json', {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60000,
  });
  const data = JSON.parse(raw);
  const jobs = Array.isArray(data) ? data : data.jobs;
  if (!Array.isArray(jobs)) throw new Error('response has no jobs[] field');
  return jobs;
}

function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((NOW - ms) / 60000);
  if (m < 60) return `${m}min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

let jobs;
try {
  jobs = fetchJobs();
} catch (err) {
  const msg = `FAILED reading gateway state: ${err.message}`;
  console.log(JSON_OUT ? JSON.stringify({ error: msg }) : `❌ ${msg}`);
  console.log('Do NOT assume crons were lost: retry, and if it persists report it for manual review.');
  process.exit(2);
}

const enabled = jobs.filter((j) => j.enabled);
const disabled = jobs.filter((j) => !j.enabled);

const pick = (j) => ({
  id: j.id,
  name: j.name,
  lastRunStatus: j.lastRunStatus ?? j.state?.lastRunStatus ?? null,
  lastError: (j.lastRunError ?? j.state?.lastError ?? null)?.toString().slice(0, 200) ?? null,
  consecutiveErrors: j.state?.consecutiveErrors ?? 0,
  lastRun: ago(j.lastRunAtMs ?? j.state?.lastRunAtMs),
  deliveryStatus: j.lastDeliveryStatus ?? null,
  model: j.payload?.model ?? null,
  timeoutSeconds: j.payload?.timeoutSeconds ?? null,
});

const errored = enabled
  .filter((j) => (j.lastRunStatus ?? j.state?.lastRunStatus) === 'error')
  .map(pick);

const notDelivered = enabled
  .filter((j) => j.lastDeliveryStatus === 'not-delivered')
  .map(pick);

// Two or more consecutive failures = structural, not a transient provider hiccup.
const persistent = errored.filter((j) => j.consecutiveErrors >= 2);

// Enabled recurring jobs that never ran at all (one-shot `at` jobs in the future are fine).
const neverRan = enabled
  .filter((j) => !(j.lastRunAtMs ?? j.state?.lastRunAtMs) && j.scheduleKind !== 'at')
  .map(pick);

// agentTurn without timeoutSeconds: candidates for silent runaway/timeout death.
const noTimeout = enabled
  .filter((j) => j.payload?.kind === 'agentTurn' && !j.payload?.timeoutSeconds)
  .map((j) => ({ id: j.id, name: j.name }));

const report = {
  ts: new Date().toISOString(),
  totals: { total: jobs.length, enabled: enabled.length, disabled: disabled.length },
  errored,
  persistent,
  notDelivered,
  neverRan,
  noTimeoutCount: noTimeout.length,
  noTimeout: noTimeout.slice(0, 10),
  disabledNames: disabled.map((j) => j.name),
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 1));
} else {
  const { total, enabled: en, disabled: di } = report.totals;
  console.log(`📊 CRONS: ${total} total | ${en} enabled | ${di} disabled`);
  console.log('');
  if (!errored.length && !notDelivered.length && !neverRan.length) {
    console.log('✅ No jobs in error, no failed deliveries, no dead jobs.');
  }
  const block = (title, list, fmt) => {
    if (!list.length) return;
    console.log(`${title} (${list.length}):`);
    for (const j of list) console.log(`  ${fmt(j)}`);
    console.log('');
  };
  block('❌ IN ERROR', errored, (j) =>
    `${j.name} [${j.id.slice(0, 8)}] errs=${j.consecutiveErrors} ${j.lastRun}\n     → ${j.lastError || 'no detail'}${j.model ? `\n     model: ${j.model} timeout: ${j.timeoutSeconds ?? 'UNLIMITED'}` : ''}`);
  block('🔁 PERSISTENT ERROR (>=2 in a row, needs action)', persistent, (j) =>
    `${j.name} [${j.id.slice(0, 8)}] errs=${j.consecutiveErrors}`);
  block('📵 NOT DELIVERED', notDelivered, (j) => `${j.name} [${j.id.slice(0, 8)}] ${j.lastRun}`);
  block('💀 NEVER RAN', neverRan, (j) => `${j.name} [${j.id.slice(0, 8)}]`);
  if (noTimeout.length) {
    console.log(`⏱️ agentTurn without timeoutSeconds: ${noTimeout.length} (silent-failure risk)`);
    for (const j of noTimeout.slice(0, 10)) console.log(`  ${j.name} [${j.id.slice(0, 8)}]`);
    console.log('');
  }
  if (disabled.length) console.log(`⏸️ Disabled: ${report.disabledNames.join(' · ')}`);
}

process.exit(errored.length ? 1 : 0);
