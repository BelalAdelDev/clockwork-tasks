// Everything a TaskFile heading can say: SCHEDULES (the heading word) and MODIFIERS ([flags]).
// To add a new one: append an object to the matching array below. Nothing else changes.

const { createRegistry, parseDayList, dayName, toTagName } = require("./utils");

// ── schedules ────────────────────────────────────────────────────────────────
//   name              stored as schedule.type
//   parse(text)       -> spec | null (not mine) | throws (mine, but invalid)
//   matches(spec, m)  -> boolean for moment m
//   tagSegment(spec)  -> piece of the default tag
const schedules = [
  {
    name: "daily",
    parse: (text) => (/^daily$/i.test(text) ? {} : null),
    matches: () => true,
    tagSegment: () => "daily",
  },
  {
    // "saturday", "sat, sun", "monday and friday"
    name: "days",
    parse(text) {
      const { days, invalid } = parseDayList(text);
      if (!days.length) return null;
      if (invalid.length) throw new Error(`Unknown day "${invalid[0]}"`);
      return { days };
    },
    matches: (spec, date) => spec.days.includes(date.day()),
    tagSegment: (spec) => spec.days.map(dayName).join("-"),
  },
];

// ── modifiers (every hook except name/parse is optional) ─────────────────────
//   parse(valueString)        -> args (plain JSON) | throws on bad input
//   isEligible(args, ctx)     -> false hides the whole list on ctx.date
//   select(tasks, args, ctx)  -> subset / reordering of the list's tasks
//   tagSegment(args)          -> piece appended to the default tag
//   tagOverride(args)         -> replaces the whole tag
// ctx = { date, taskFile, list, config, anchor, occurrenceIndex() }
const modifiers = [
  {
    // [cyclic] / [cyclic: 2] — N tasks per day, rotating through the list.
    // Stateless: position = (eligible days since anchor) * N, so re-running the same
    // day always yields the same tasks and every device agrees.
    name: "cyclic",
    parse(value) {
      if (value === "") return { count: 1 };
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(`expects a positive whole number, got "${value}"`);
      }
      return { count };
    },
    select(tasks, { count }, ctx) {
      if (!tasks.length) return [];
      const start = (ctx.occurrenceIndex() * count) % tasks.length;
      const take = Math.min(count, tasks.length);
      return Array.from({ length: take }, (_, i) => tasks[(start + i) % tasks.length]);
    },
    tagSegment: () => "cyclic",
  },
  {
    // [days-off: fri, sat]
    name: "days-off",
    aliases: ["daysoff", "off"],
    parse(value) {
      const { days, invalid } = parseDayList(value);
      if (invalid.length) throw new Error(`unknown day "${invalid[0]}"`);
      if (!days.length) throw new Error("needs at least one day, e.g. [days-off: fri, sat]");
      return { days };
    },
    isEligible: ({ days }, ctx) => !days.includes(ctx.date.day()),
  },
  {
    // [disabled]
    name: "disabled",
    parse: () => ({}),
    isEligible: () => false,
  },
  {
    // [custom-name: deep-work] -> #deep-work
    name: "custom-name",
    aliases: ["name", "tag"],
    parse(value) {
      const tag = toTagName(value);
      if (!tag) throw new Error("needs a tag name, e.g. [custom-name: deep-work]");
      return { tag };
    },
    tagOverride: ({ tag }) => tag,
  },
];

const createScheduleRegistry = (extra = []) => createRegistry("schedule", [...schedules, ...extra]);
const createModifierRegistry = (extra = []) => createRegistry("modifier", [...modifiers, ...extra]);

module.exports = { createScheduleRegistry, createModifierRegistry };
