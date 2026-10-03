/** Ring-buffer log service for the P2P console. */
import { state, emit } from '../core/store.js';

let seq = 0;

export function log(level, exchange, message, meta = null) {
  const entry = { id: ++seq, ts: Date.now(), level, exchange: exchange || 'sys', message, meta };
  state.logs.push(entry);
  const max = state.settings.maxLogs || 400;
  if (state.logs.length > max) state.logs.splice(0, state.logs.length - max);
  emit('logs', entry);
  return entry;
}

export function clearLogs() {
  state.logs.length = 0;
  emit('logs', null);
}

export function exportLogs() {
  return JSON.stringify(state.logs, null, 2);
}
