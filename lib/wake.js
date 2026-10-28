'use strict';

// Wake-up on background-process exit.
//
// The model starts a long job (gradle build, npm install, ...) with bash background=true and ENDS ITS TURN.
// When the process finishes, the studio itself (no model, no polling) notices and — if the agent is idle —
// starts a new turn whose first message is a short notification with the exit code and the end of the output.
// The model then reports the result (or fixes the error). That costs one short turn instead of dozens of
// polling calls that fill the context window.
//
// Rules:
//  - killed processes (Stop button / process kill) never wake anything: whoever killed it already knows;
//  - a process whose final state the model already read itself (`process output/list`) is not announced again;
//  - while the agent is busy, notices wait and are delivered when the run ends;
//  - several processes ending together produce ONE turn;
//  - at most `maxStreak` automatic turns in a row without a user message (protects against build -> fail -> build loops).

const log = require('./log');

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** The message the model sees, plus a short label for the chat UI. */
function noticeFor(infos) {
  const blocks = infos.map((i) => {
    const ok = i.exitCode === 0;
    return [
      `Background process ${i.id} ${ok ? 'finished successfully' : 'FAILED'} (exit code ${i.exitCode}) after ${fmtDuration(i.durationMs)}.`,
      `Command: ${String(i.command).slice(0, 300)}`,
      i.logFile ? `Full log: ${i.logFile}` : '',
      'Last output:',
      '```',
      String(i.tail || '(no output)').slice(-3000),
      '```',
    ].filter(Boolean).join('\n');
  });
  const text = [
    '[Studio notification — sent automatically by the studio, the user did not type this]',
    blocks.join('\n\n'),
    'Tell the user the outcome in one or two sentences. If it failed, read the error above and fix it. If more steps of the task remain, continue with them. Do not poll processes.',
  ].join('\n\n');
  const display = infos.map((i) => `🔔 ${i.id} ${i.exitCode === 0 ? 'finished' : 'failed'} · exit ${i.exitCode} · ${fmtDuration(i.durationMs)}`).join('\n');
  return { text, display };
}

/**
 * @param {object} d
 * @param {import('node:events').EventEmitter} d.events  emits 'exit' with the info object from procs.js
 * @param {(sessionId:string)=>boolean} d.isRunning      is an agent run active for this session?
 * @param {(procId:string)=>boolean} d.isSeen            did the model already read this process's final state?
 * @param {()=>boolean} d.enabled                        config switch (wakeOnProcessExit)
 * @param {(sessionId:string, notice:{text:string,display:string})=>Promise<boolean>} d.start  start the wake-up turn; false = could not (busy)
 */
function createWaker({ events, isRunning, isSeen, enabled, start, maxStreak = 8, delayMs = 400 }) {
  const pending = new Map();   // sessionId -> [info]
  const timers = new Map();
  const streak = new Map();

  function schedule(sid, ms = delayMs) {
    clearTimeout(timers.get(sid));
    timers.set(sid, setTimeout(() => { timers.delete(sid); flush(sid).catch((e) => log.warn('wake', 'wake-up failed', e)); }, ms));
    if (timers.get(sid).unref) timers.get(sid).unref();
  }

  async function flush(sid) {
    const infos = (pending.get(sid) || []).filter((i) => !isSeen(i.id));
    pending.delete(sid);
    if (!infos.length) return false;
    if (isRunning(sid)) { pending.set(sid, infos); return false; }      // delivered by onRunEnd
    const n = streak.get(sid) || 0;
    if (n >= maxStreak) { log.info('wake', `not waking ${sid}: ${n} automatic turns in a row without a user message`); return false; }
    streak.set(sid, n + 1);
    let started = false;
    try { started = await start(sid, noticeFor(infos)); } catch (e) { log.warn('wake', `could not start the wake-up turn for ${sid}`, e); started = null; }
    if (started === false) pending.set(sid, infos);                       // lost a race with a user message: try again after that run
    return started === true;
  }

  function onExit(info) {
    if (!info || !info.sessionId || info.killed) return;
    if (!enabled()) return;
    pending.set(info.sessionId, [...(pending.get(info.sessionId) || []), info]);
    if (!isRunning(info.sessionId)) schedule(info.sessionId);
  }

  if (events) events.on('exit', onExit);

  return {
    onExit,
    flush,
    /** call when an agent run ends: deliver notices that arrived meanwhile */
    onRunEnd(sid) { if (pending.has(sid)) schedule(sid, 300); },
    /** call when the USER sent a message: the automatic-turn counter starts over */
    onUserMessage(sid) { streak.delete(sid); },
    hasPending: (sid) => (pending.get(sid) || []).length > 0,
  };
}

module.exports = { createWaker, noticeFor, fmtDuration };
