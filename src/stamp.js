// Completion-date stamping, Tasks-plugin compatible:  done "✅ YYYY-MM-DD"  ·  cancelled "❌ YYYY-MM-DD".
// Pure string logic (no Obsidian / CodeMirror). A task line always ends up with exactly the stamp its CURRENT status needs:
//   [x]/[X]  -> one ✅, no ❌        [-] -> one ❌, no ✅        anything else ( [ ] [/] ... ) -> neither
// so done -> cancelled (and back) swaps the stamp directly; nobody has to untick first.

const TASK_LINE = /^(\s*)([-*])\s+\[(.)\]\s?(.*)$/;
const DONE_DATE = /\s*\u2705\s*\d{4}-\d{2}-\d{2}/g;
const CANCEL_DATE = /\s*\u274C\s*\d{4}-\d{2}-\d{2}/g;
const DONE_STATUSES = ["x", "X"];
const CANCEL_STATUSES = ["-"];

const ranges = (text, re) => [...text.matchAll(re)].map((d) => ({ from: d.index, to: d.index + d[0].length }));
const noCR = (s) => (s.endsWith("\r") ? s.slice(0, -1) : s);

// status char of a task line, or null when it is not a task
function statusOf(text) {
  const m = noCR(text).match(TASK_LINE);
  return m ? m[3] : null;
}

// Edits (ch offsets inside the line) that make this line's stamps match its status.
// `done` / `cancel` say which stamps WE manage (the Tasks plugin may own ✅ while we still own ❌). edit = { from, to, text }
function lineEdits(text, today, { skipMarker = "", done: manageDone = true, cancel: manageCancel = true } = {}) {
  const m = text.match(TASK_LINE);
  if (!m || (skipMarker && text.includes(skipMarker))) return [];
  const status = m[3];
  const isDone = DONE_STATUSES.includes(status);
  const isCancel = CANCEL_STATUSES.includes(status);
  const done = ranges(text, DONE_DATE);
  const cancel = ranges(text, CANCEL_DATE);
  const edits = [];
  const drop = (rs) => rs.forEach((r) => edits.push({ from: r.from, to: r.to, text: "" }));
  const append = (emoji) => edits.push({ from: text.length, to: text.length, text: ` ${emoji} ${today}` });

  // ✅  ours when we manage done dates; also when a task we manage as cancelled must lose its done date
  if (manageDone || (manageCancel && isCancel)) {
    if (!isDone) drop(done);
    else if (done.length) drop(done.slice(1));
    else append("\u2705");
  }
  // ❌  ours when we manage cancelled dates; also when a task we manage as done must lose its cancelled date
  if (manageCancel || (manageDone && isDone)) {
    if (!isCancel) drop(cancel);
    else if (cancel.length) drop(cancel.slice(1));
    else append("\u274C");
  }
  return edits;
}

// Right-to-left, bottom-to-top, so earlier offsets stay valid while applying one by one.
const orderForApply = (edits) => [...edits].sort((a, b) => b.line - a.line || b.from - a.from);

function applyEdits(content, edits) {
  const lines = content.split("\n");
  for (const e of orderForApply(edits)) {
    const l = lines[e.line];
    lines[e.line] = l.slice(0, e.from) + e.text + l.slice(e.to);
  }
  return lines.join("\n");
}

// For changes that happen outside the editor (reading-mode checkbox): compare the previous and the new file content
// and stamp only the lines whose STATUS changed (so old, untouched tasks are never stamped).
function transitionEdits(prevContent, nextContent, { today, skipMarker = "", done, cancel } = {}) {
  const a = prevContent.split("\n");
  const b = nextContent.split("\n");
  if (a.length !== b.length) return { edits: [], content: nextContent };

  const edits = [];
  for (let i = 0; i < b.length; i++) {
    if (a[i] === b[i]) continue;
    const before = statusOf(a[i]);
    const after = statusOf(b[i]);
    if (before === null || after === null || before === after) continue;
    for (const e of lineEdits(noCR(b[i]), today, { skipMarker, done, cancel })) edits.push({ line: i, ...e });
  }
  return { edits, content: edits.length ? applyEdits(nextContent, edits) : nextContent };
}

module.exports = { lineEdits, transitionEdits, applyEdits, orderForApply, statusOf };
