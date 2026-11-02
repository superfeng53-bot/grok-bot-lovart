#!/usr/bin/env node
/** Prefer generator_task_id — API create returns this, not task_id. */
function parseWanTaskId(body) {
  let j = body;
  if (typeof body === 'string') {
    try { j = JSON.parse(body); } catch {
      // last resort: regex on raw string
      const m = String(body).match(/"generator_task_id"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    }
  }
  if (!j || typeof j !== 'object') return null;
  const d = j.data != null ? j.data : j;
  const direct =
    d.generator_task_id ||
    d.generatorTaskId ||
    d.task_id ||
    d.taskId ||
    d.id ||
    null;
  if (direct) return direct;
  // deep scan one level of nested objects
  for (const v of Object.values(d)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = v.generator_task_id || v.generatorTaskId;
      if (nested) return nested;
    }
  }
  return null;
}
function createSucceeded(status, body) {
  if (status !== 200 && status !== 201) return false;
  let j;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return !!parseWanTaskId(body); }
  // If generator_task_id exists, treat as success even when code field is odd —
  // that is exactly the double-charge trap (HTTP 200 + id, script thought fail).
  if (parseWanTaskId(j)) return true;
  const codeOk = j && (j.code === 0 || j.code === '0' || j.message === 'success' || j.msg === 'success');
  return !!codeOk;
}
module.exports = { parseWanTaskId, createSucceeded };
if (require.main === module) {
  const fs = require('fs');
  const p = process.argv[2];
  const raw = p ? fs.readFileSync(p, 'utf8') : fs.readFileSync(0, 'utf8');
  const id = parseWanTaskId(raw);
  if (!id) { console.error('NO_TASK_ID'); process.exit(2); }
  console.log(id);
}
