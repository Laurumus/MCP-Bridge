import { redactSecrets, MAX_DIAGNOSTIC_INPUT_LENGTH } from './sanitize.js';

export const TOOL_CALL_ERROR_MAX_LENGTH = 300;
export const TOOL_ERROR_MAX_DEPTH = 3;
const MAX_ENTRIES = 20;
const MARKER = '[TRUNCATED]';

// Read data properties only. Never invoke an error object's getters/toJSON.
function ownValue(object, key) {
  if (object === null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function errorToString(root) {
  const seen = new Set();
  let remaining = MAX_ENTRIES;
  function visit(value, depth) {
    if (remaining-- <= 0 || depth > TOOL_ERROR_MAX_DEPTH) return '';
    if (typeof value === 'string') {
      return value.length > MAX_DIAGNOSTIC_INPUT_LENGTH
        ? '[diagnostic omitted: oversized error]…' : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null || typeof value !== 'object') return '';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    for (const key of ['message', 'name', 'data']) {
      const preferred = ownValue(value, key);
      if (preferred === undefined) continue;
      const text = visit(preferred, depth + 1);
      if (text) return text;
    }
    let keys;
    try { keys = Object.keys(value); } catch { return ''; }
    const parts = [];
    for (const key of keys) {
      if (remaining <= 0) break;
      if (key === 'message' || key === 'name' || key === 'data') continue;
      const text = visit(ownValue(value, key), depth + 1);
      if (text) parts.push(`${key}: ${text}`);
    }
    return parts.join('; ');
  }
  try { return visit(root, 0); } catch { return ''; }
}

export function describeToolError(state) {
  const error = errorToString(ownValue(state, 'error'));
  const detail = errorToString(ownValue(state, 'detail'));
  const raw = [error, detail && !error.includes(detail) ? detail : ''].filter(Boolean).join('; ');
  if (!raw) return null;
  const text = redactSecrets(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return null;
  return text.length > TOOL_CALL_ERROR_MAX_LENGTH
    ? text.slice(0, TOOL_CALL_ERROR_MAX_LENGTH) + '…' : text;
}

export function summarizeToolPart(part) {
  const state = ownValue(part, 'state');
  const entry = { name: ownValue(part, 'name') ?? null, status: ownValue(state, 'status') ?? null };
  if (entry.status !== 'error') return entry;
  const error = describeToolError(state);
  if (error) entry.error = error;
  // Explicit call-id fields win; real OpenCode tool parts expose the id only
  // as the top-level `id`, so it is the last fallback.
  const id = ownValue(part, 'callID') ?? ownValue(part, 'toolCallID')
    ?? ownValue(state, 'callID') ?? ownValue(part, 'id');
  if (typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)) entry.callID = id;
  return entry;
}

// Budget is the combined text length plus JSON.stringify(toolCalls).length,
// not the size of the complete MCP envelope. Inputs are bridge-owned summaries.
export function enforceResultBudget(result, toolCalls, maxLen) {
  if (!Number.isSafeInteger(maxLen) || maxLen < 2) throw new RangeError('result budget must be at least 2');
  const fullSize = JSON.stringify(toolCalls).length;
  if (result.length + fullSize <= maxLen) return { result, toolCalls, truncated: false };
  const marker = MARKER.slice(0, Math.max(0, maxLen - 2));
  const callsBudget = maxLen - marker.length;
  let kept = toolCalls;
  if (fullSize > callsBudget) {
    const selected = [];
    let used = 2;
    // Prefer failed calls when all summaries cannot fit, but emit them in
    // original order. Preserve a shortened explanation rather than drop all.
    for (const failed of [true, false]) {
      for (let index = 0; index < toolCalls.length; index++) {
        const call = toolCalls[index];
        if ((call.status === 'error') !== failed) continue;
        let candidate = call;
        let size = JSON.stringify(candidate).length;
        const room = callsBudget - used - (selected.length ? 1 : 0);
        if (size > room && typeof call.error === 'string') {
          candidate = { name: call.name, status: call.status, error: call.error };
          const base = JSON.stringify({ ...candidate, error: '' }).length;
          if (base + 1 <= room) {
            let lo = 0;
            let hi = call.error.length;
            while (lo < hi) {
              const mid = Math.ceil((lo + hi) / 2);
              const shortened = { ...candidate, error: call.error.slice(0, mid) + '…' };
              if (JSON.stringify(shortened).length <= room) lo = mid;
              else hi = mid - 1;
            }
            candidate.error = call.error.slice(0, lo) + '…';
          }
          size = JSON.stringify(candidate).length;
        }
        if (size <= room) {
          selected.push({ index, call: candidate });
          used += size + (selected.length > 1 ? 1 : 0);
        }
      }
    }
    kept = selected.sort((a, b) => a.index - b.index).map((item) => item.call);
  }
  const textBudget = Math.max(0, maxLen - marker.length - JSON.stringify(kept).length);
  return { result: result.slice(0, textBudget) + marker, toolCalls: kept, truncated: true };
}
