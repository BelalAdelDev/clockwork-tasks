// Generator component: TaskFile model + date -> today's task lines, and inserting them into the output file.
// Pure: no Obsidian API.

const { formatTask, parseTask, taskSignature, splitLines, formatDate, parseDate, ensureDoneSection } = require("./utils");

function createTasksGenerator({ config, schedules, modifiers }) {
  // Is this list active on ctx.date? (schedule AND every modifier agrees)
  function isEligible(list, ctx) {
    if (!schedules.get(list.schedule.type).matches(list.schedule, ctx.date)) return false;
    return list.modifiers.every(({ name, args }) => {
      const def = modifiers.get(name);
      return !def.isEligible || def.isEligible(args, ctx);
    });
  }

  function makeContext(taskFile, list, date, anchor) {
    const ctx = { taskFile, list, date, anchor, config };
    // How many times this list was eligible between anchor and date (exclusive).
    ctx.occurrenceIndex = () => {
      let count = 0;
      const cursor = anchor.clone();
      while (cursor.isBefore(date, "day")) {
        if (isEligible(list, { ...ctx, date: cursor.clone() })) count++;
        cursor.add(1, "day");
      }
      return count;
    };
    return ctx;
  }

  function generate(taskFile, date) {
    const anchor = parseDate(taskFile.settings.anchor) || parseDate(config.defaultAnchor);
    const dateStr = formatDate(date);
    const entries = [];
    const skipped = [];

    for (const list of taskFile.lists) {
      if (list.errors.length) {
        skipped.push({ listId: list.id, reason: "invalid" });
        continue;
      }
      const ctx = makeContext(taskFile, list, date, anchor);
      if (!isEligible(list, ctx)) {
        skipped.push({ listId: list.id, reason: "not-scheduled" });
        continue;
      }

      let tasks = list.tasks;
      for (const { name, args } of list.modifiers) {
        const def = modifiers.get(name);
        if (def.select) tasks = def.select(tasks, args, ctx);
      }
      for (const text of tasks) {
        entries.push({
          listId: list.id,
          tag: list.tag,
          text,
          line: formatTask({ text, due: dateStr, tags: [config.activeTag, list.tag] }),
        });
      }
    }
    return { date: dateStr, entries, skipped };
  }

  return { generate };
}

// Inserts entries just above the Done section, skipping any task already present anywhere
// in the file (pending OR done) -> re-running / forcing never duplicates.
function insertTasks(content, entries, { doneHeading, activeTag }) {
  const lines = splitLines(content);
  const seen = new Set();
  for (const line of lines) {
    const sig = taskSignature(line, [activeTag]);
    if (sig) seen.add(sig);
  }

  const inserted = [];
  const skipped = [];
  for (const entry of entries) {
    const sig = taskSignature(entry.line, [activeTag]);
    if (seen.has(sig)) skipped.push(entry);
    else {
      seen.add(sig);
      inserted.push(entry);
    }
  }
  if (!inserted.length) return { content, inserted, skipped };

  const doneIndex = ensureDoneSection(lines, doneHeading);
  let at = doneIndex;
  while (at > 0 && lines[at - 1].trim() === "") at--;
  const pad = at > 0 && !parseTask(lines[at - 1]) ? [""] : [];
  lines.splice(at, doneIndex - at, ...pad, ...inserted.map((e) => e.line), "");

  return { content: lines.join("\n"), inserted, skipped };
}

module.exports = { createTasksGenerator, insertTasks };
