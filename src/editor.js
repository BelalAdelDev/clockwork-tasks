// Editor hook for completion stamps. A CodeMirror transaction filter, i.e. the stamp is added INSIDE the very same
// transaction as the checkbox change (this is why it is instantaneous, and why one Ctrl+Z undoes both).

const { EditorState } = require("@codemirror/state");
const { lineEdits } = require("./stamp");

// BEFORE the edit the brackets may be mid-edit ("[]" after a Backspace, "[ -]" after typing next to the space),
// AFTER it they must be a proper one-character status followed by a space / end of line.
const OLD_RE = /^\s*[-*]\s+\[([^\]]*)\](?:\s|$)/;
const NEW_RE = /^\s*[-*]\s+\[(.)\](?:\s|$)/;
const MAX_LINES = 20;

// Specs (in NEW-document coordinates) for every line whose checkbox status changed in this transaction.
function stampChanges(tr, opts) {
  const oldDoc = tr.startState.doc;
  const newDoc = tr.newDoc;
  const touched = new Set();
  let simple = true;

  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (!simple) return;
    const line = oldDoc.lineAt(fromA);
    if (inserted.lines > 1 || toA > line.to) simple = false; // paste / newline / multi-line delete: leave alone
    else touched.add(line.number);
  });
  if (!simple || !touched.size || touched.size > MAX_LINES) return [];

  const specs = [];
  for (const n of touched) {
    const oldLine = oldDoc.line(n);
    const before = oldLine.text.match(OLD_RE);
    if (!before) continue;
    const newLine = newDoc.lineAt(tr.changes.mapPos(oldLine.from, -1));
    const after = newLine.text.match(NEW_RE);
    if (!after || after[1] === before[1]) continue; // text edit, not a status change
    for (const e of lineEdits(newLine.text, opts.today, opts)) {
      specs.push({ from: newLine.from + e.from, to: newLine.from + e.to, insert: e.text });
    }
  }
  return specs;
}

function createStampExtension(plugin) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.isUserEvent("undo") || tr.isUserEvent("redo")) return tr;
    const opts = plugin.stampOptions();
    if (opts.done === false && opts.cancel === false) return tr;
    const specs = stampChanges(tr, opts);
    return specs.length ? [tr, { changes: specs, sequential: true }] : tr;
  });
}

module.exports = { createStampExtension, stampChanges };
