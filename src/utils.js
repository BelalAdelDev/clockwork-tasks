// Shared, dependency-free helpers. Sections: text · dates · config block · registry · task lines · output doc · logger

// ── text ─────────────────────────────────────────────────────────────────────
const splitLines = (text) => text.split(/\r?\n/);

const compactBlankLines = (text) =>
  text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/g, "\n");

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

// Obsidian tag body: letters, digits, _ - /  (no spaces, no leading #)
const toTagName = (s) =>
  String(s)
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_\/-]/gu, "")
    .replace(/-{2,}/g, "-");

// ── dates ────────────────────────────────────────────────────────────────────
const moment = (typeof window !== "undefined" && window.moment) || require("moment");
const DATE_FORMAT = "YYYY-MM-DD";

// index = moment().day()  (0 = Sunday)
const DAYS = [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"],
];
const DAY_LOOKUP = new Map();
DAYS.forEach((names, index) => names.forEach((n) => DAY_LOOKUP.set(n, index)));

const dayName = (index) => DAYS[index][0];
const formatDate = (m) => m.format(DATE_FORMAT);
const parseDate = (str) => {
  const m = moment(String(str), DATE_FORMAT, true);
  return m.isValid() ? m.startOf("day") : null;
};

// "Sat, sunday and Mon" -> { days: [6, 0, 1], invalid: [] }
function parseDayList(text) {
  const days = [];
  const invalid = [];
  for (const token of String(text).split(/[\s,/&+]+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === "and") continue;
    const index = DAY_LOOKUP.get(lower);
    if (index === undefined) invalid.push(token);
    else if (!days.includes(index)) days.push(index);
  }
  return { days, invalid };
}

// ── config block: a ```clockwork-tasks fenced code block of flat `key: value` lines ──
// `end` = offset just after the closing fence; `body` = content with the block removed.
const coerce = (raw) => {
  const v = raw.trim();
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  const quoted = v.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : v;
};

function parseConfigBlock(content, lang) {
  const re = new RegExp("^```" + escapeRegExp(lang) + "[ \\t]*\\r?\\n(?:([\\s\\S]*?)\\r?\\n)?```[ \\t]*(?:\\r?\\n|$)", "im");
  const m = content.match(re);
  if (!m) return { found: false, data: {}, body: content, end: 0 };

  const data = {};
  for (const line of (m[1] || "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (kv) data[kv[1].toLowerCase()] = coerce(kv[2]);
  }
  const end = m.index + m[0].length;
  return { found: true, data, body: content.slice(0, m.index) + content.slice(end), end };
}

// ── registry (schedules, modifiers and triggers all use it) ──────────────────
function createRegistry(label, defs = []) {
  const items = new Map();
  const norm = (name) => String(name).trim().toLowerCase().replace(/[\s_]+/g, "-");
  const registry = {
    register(def) {
      for (const key of [def.name, ...(def.aliases || [])].map(norm)) {
        if (items.has(key)) throw new Error(`${label} "${key}" is already registered`);
        items.set(key, def);
      }
      return registry;
    },
    get: (name) => items.get(norm(name)) || null,
    all: () => [...new Set(items.values())],
  };
  defs.forEach((d) => registry.register(d));
  return registry;
}

// ── task lines (Tasks-plugin emoji format; change here to support other formats) ──
const DUE = "\u{1F4C5}"; // 📅
const DONE = "\u2705"; //  ✅
const CANCEL = "\u274C"; // ❌
const dateAfter = (marker) => new RegExp(`${marker}\\s*(\\d{4}-\\d{2}-\\d{2})`, "gu");
const DUE_RE = dateAfter(DUE);
const DONE_RE = dateAfter(DONE);
const CANCEL_RE = dateAfter(CANCEL);
const TASK_RE = /^(\s*)([-*])\s+\[(.)\]\s?(.*)$/;

const lastDate = (text, re) => {
  let out = "";
  for (const m of text.matchAll(re)) out = m[1];
  return out;
};

function parseTask(line) {
  const m = line.match(TASK_RE);
  if (!m) return null;
  return { indent: m[1], status: m[3], body: m[4], due: lastDate(m[4], DUE_RE), done: lastDate(m[4], DONE_RE), cancelled: lastDate(m[4], CANCEL_RE) };
}

const formatTask = ({ text, due = "", tags = [], status = " " }) =>
  [`- [${status}] ${text}`, due && `${DUE} ${due}`, ...tags].filter(Boolean).join(" ");

// Identity for de-duplication: due date + text + tags (ignores checkbox state, ✅ date, ignored tags)
function taskSignature(line, ignoreTags = []) {
  const task = parseTask(line);
  if (!task) return null;
  const tokens = task.body
    .replace(DUE_RE, " ")
    .replace(DONE_RE, " ")
    .replace(CANCEL_RE, " ")
    .split(/\s+/)
    .filter((t) => t && !ignoreTags.includes(t));
  return `${task.due}|${tokens.join(" ")}`;
}

const hasTag = (line, tag) => new RegExp(`(^|\\s)${escapeRegExp(tag)}(?=\\s|$)`).test(line);
const stripTag = (line, tag) => line.replace(new RegExp(`\\s+${escapeRegExp(tag)}(?=\\s|$)`, "g"), "");

// ── output document ──────────────────────────────────────────────────────────
// Mutates `lines`: appends the Done heading if missing. Returns its index.
function ensureDoneSection(lines, heading) {
  let index = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (index === -1) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", heading);
    index = lines.length - 1;
  }
  return index;
}

// ── logger ───────────────────────────────────────────────────────────────────
function createLogger({ prefix = "[Clockwork Tasks]", debug = false } = {}) {
  const wrap = (fn) => (...args) => fn(prefix, ...args);
  return {
    debug: debug ? wrap(console.log) : () => {},
    info: wrap(console.log),
    warn: wrap(console.warn),
    error: wrap(console.error),
  };
}

module.exports = {
  splitLines, compactBlankLines, escapeRegExp, slugify, toTagName,
  moment, formatDate, parseDate, parseDayList, dayName,
  parseConfigBlock, createRegistry,
  parseTask, formatTask, taskSignature, hasTag, stripTag,
  ensureDoneSection, createLogger,
};
