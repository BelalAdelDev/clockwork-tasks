// TaskFile component: find TaskFiles, parse markdown -> model, manage the restart checkbox.
// Pure: no Obsidian API, no dates, no state.
//
// TaskFile = { path, name, settings:{output,trigger,anchor}, lists:[TaskList],
//              restart:{present,checked}, warnings:[], errors:[] }
// TaskList = { id, heading, schedule:{type,...}, modifiers:[{name,args}],
//              tag, tasks:[string], errors:[] }

const { parseConfigBlock, splitLines, slugify, toTagName } = require("./utils");

// ── discovery (add new strategies here: folder, tag, index note...) ──────────
const withExt = (p) => (p.endsWith(".md") ? p : `${p}.md`);

function discoverTaskFiles(io, config, explicitPaths) {
  if (explicitPaths && explicitPaths.length) return explicitPaths.map(withExt);
  return io.findByCodeBlock(config.configBlock);
}

// ── restart checkbox ─────────────────────────────────────────────────────────
// Checking it forces generation on the next run. %%...%% is an Obsidian comment (invisible when rendered).
const MARKER = "%%clockwork-tasks:restart%%";
const CONTROL_LINE = `- [ ] \u{1F501} Restart Clockwork Tasks (regenerate today's tasks) ${MARKER}`;
const RESTART_RE = /^([ \t]*[-*][ \t]+\[)([ xX])(\][^\n]*%%clockwork-tasks:restart%%[^\n]*)$/m;

const restartControl = {
  read(content) {
    const m = content.match(RESTART_RE);
    return { present: !!m, checked: !!m && m[2] !== " " };
  },
  ensure(content, lang) {
    if (RESTART_RE.test(content)) return content;
    const { end } = parseConfigBlock(content, lang);
    const nl = content.includes("\r\n") ? "\r\n" : "\n";
    return content.slice(0, end) + (end ? nl : "") + CONTROL_LINE + nl + nl + content.slice(end);
  },
  // uncheck the box AND drop the ✅ date that was stamped when it was ticked
  reset: (content) =>
    content.replace(RESTART_RE, (line, pre, _box, rest) =>
      `${pre} ${rest.replace(/\s*\u2705\s*\d{4}-\d{2}-\d{2}/g, "")}`),
};

// ── parser ───────────────────────────────────────────────────────────────────
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const TASK_RE = /^[-*]\s+\[ \]\s+(.+?)\s*$/; // top-level, unchecked only
const FLAG_RE = /\[([^\]]*)\]/g;

function createTaskFileParser({ config, schedules, modifiers }) {
  function buildTag(schedule, mods) {
    for (const { name, args } of mods) {
      const override = modifiers.get(name).tagOverride?.(args);
      if (override) return `#${toTagName(override)}`;
    }
    const parts = [
      schedules.get(schedule.type).tagSegment(schedule),
      ...mods.map(({ name, args }) => modifiers.get(name).tagSegment?.(args)),
    ];
    return `#${toTagName(parts.filter(Boolean).join("-"))}`;
  }

  function parseHeading(heading) {
    const errors = [];
    const flags = [];
    const scheduleText = heading
      .replace(FLAG_RE, (_, inner) => (flags.push(inner), " "))
      .replace(/\s+/g, " ")
      .trim();

    let schedule = null;
    for (const def of schedules.all()) {
      try {
        const spec = def.parse(scheduleText);
        if (spec) {
          schedule = { type: def.name, ...spec };
          break;
        }
      } catch (e) {
        errors.push(e.message);
        break;
      }
    }
    if (!schedule && !errors.length) errors.push(`Unknown schedule "${scheduleText}"`);

    const mods = [];
    const seen = new Set();
    for (const flag of flags) {
      const colon = flag.indexOf(":");
      const rawName = (colon === -1 ? flag : flag.slice(0, colon)).trim();
      const value = colon === -1 ? "" : flag.slice(colon + 1).trim();
      const def = modifiers.get(rawName);
      if (!def) {
        errors.push(`Unknown modifier [${rawName}]`);
        continue;
      }
      if (seen.has(def.name)) {
        errors.push(`Duplicate modifier [${def.name}]`);
        continue;
      }
      seen.add(def.name);
      try {
        mods.push({ name: def.name, args: def.parse(value) });
      } catch (e) {
        errors.push(`[${rawName}] ${e.message}`);
      }
    }

    const tag = !errors.length ? buildTag(schedule, mods) : null;
    return { heading, schedule, modifiers: mods, tag, tasks: [], errors };
  }

  function collectLists(body) {
    const lists = [];
    const ids = new Map();
    let current = null;

    for (const line of splitLines(body)) {
      const h = line.match(HEADING_RE);
      if (h) {
        current = null;
        if (h[1].length === 6) {
          current = parseHeading(h[2]);
          const base = slugify(h[2]) || "list";
          const n = (ids.get(base) || 0) + 1;
          ids.set(base, n);
          current.id = n === 1 ? base : `${base}-${n}`;
          lists.push(current);
        }
        continue;
      }
      if (!current || line.includes(MARKER)) continue;
      const t = line.match(TASK_RE);
      if (t) current.tasks.push(t[1]);
    }
    return lists;
  }

  function parse(path, content) {
    const { data, body } = parseConfigBlock(content, config.configBlock);
    const warnings = [];
    const errors = [];

    const output = data.output ? withExt(String(data.output).trim()) : "";
    if (!output) errors.push(`Missing "output:" line in the \`\`\`${config.configBlock} block`);

    const lists = collectLists(body);
    for (const list of lists) {
      for (const msg of list.errors) warnings.push(`${path} › "${list.heading}": ${msg} (list skipped)`);
    }

    return {
      path,
      name: path.split("/").pop().replace(/\.md$/, ""),
      settings: {
        output,
        trigger: String(data.trigger || config.defaultTrigger).toLowerCase(),
        anchor: String(data.anchor || config.defaultAnchor),
      },
      lists,
      restart: restartControl.read(content),
      warnings,
      errors,
    };
  }

  return { parse };
}

module.exports = { createTaskFileParser, discoverTaskFiles, restartControl, MARKER };
