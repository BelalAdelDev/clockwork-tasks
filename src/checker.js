// Checker component. Output-file housekeeping, pure string -> string.
//   1. moveDone: completed tasks (+ indented sub-lines) go under "###### Done", newest completion first, #active stripped.
//   2. deactivateStale: unfinished Clockwork Tasks tasks due before today lose #active.

const { splitLines, parseTask, hasTag, stripTag, ensureDoneSection } = require("./utils");

function createTasksChecker({ config }) {
  const doneStatuses = new Set(config.doneStatuses);
  const isDone = (t) => t && t.indent === "" && doneStatuses.has(t.status);
  const isChild = (line) => /^\s+\S/.test(line);

  function moveDone(content) {
    const lines = splitLines(content);
    const doneIndex = ensureDoneSection(lines, config.doneHeading);

    const kept = [];
    const moved = [];
    let i = 0;
    while (i < doneIndex) {
      const task = parseTask(lines[i]);
      if (isDone(task)) {
        const block = [stripTag(lines[i], config.activeTag)];
        let j = i + 1;
        while (j < doneIndex && isChild(lines[j])) block.push(lines[j++]);
        moved.push({ block, index: moved.length, done: task.done || task.cancelled, due: task.due });
        i = j;
      } else {
        kept.push(lines[i++]);
      }
    }
    if (!moved.length) return content;

    moved.sort((a, b) => {
      if (a.done && b.done) return b.done.localeCompare(a.done) || b.due.localeCompare(a.due) || b.index - a.index;
      if (a.done) return -1;
      if (b.done) return 1;
      return b.index - a.index;
    });

    return [...kept, lines[doneIndex], ...moved.flatMap((m) => m.block), ...lines.slice(doneIndex + 1)].join("\n");
  }

  function deactivateStale(content, { today, managedTags }) {
    if (!config.deactivateStale) return content;
    return splitLines(content)
      .map((line) => {
        const task = parseTask(line);
        if (!task || task.indent !== "" || task.status !== " ") return line;
        if (task.due === today || !hasTag(line, config.activeTag)) return line;
        if (!managedTags.some((tag) => hasTag(line, tag))) return line;
        return stripTag(line, config.activeTag);
      })
      .join("\n");
  }

  const sweep = (content, { today, managedTags = [] }) =>
    deactivateStale(moveDone(content), { today, managedTags });

  return { sweep };
}

module.exports = { createTasksChecker };
