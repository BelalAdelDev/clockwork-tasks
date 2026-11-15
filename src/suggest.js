// Due-date menu. Two steps, driven by a small CodeMirror popup (so Enter / Esc / arrows are fully under our control):
//   1. while you type on an open task line:   [📅 Due date] [⏎ New line]
//      Enter on "Due date" inserts the 📅 for you and the menu turns into step 2.  Esc hides it until you type again.
//   2. after a 📅:                            Today (…) · Tomorrow (…) · Monday (…) … · Next week (…)   (type to filter)

const { ViewPlugin, keymap } = require("@codemirror/view");
const { Prec } = require("@codemirror/state");
const { moment, dayName, formatDate } = require("./utils");

const DUE = "\u{1F4C5}"; // 📅 (2 UTF-16 units)
const TASK_RE = /^(\s*[-*]\s+\[(.)\]\s?)(.*)$/;
const AFTER_DUE_RE = /\u{1F4C5}([ \p{L}\p{N}-]*)$/u; // 📅 plus optional filter text, up to the cursor
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const REL_RE = /^(?:in\s+)?(\d{1,3})\s*(d|day|days|w|wk|wks|week|weeks|m|mo|month|months)?$/;
const UNITS = { d: "days", w: "weeks", m: "months" };
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ── pure: which menu (if any) belongs at this cursor position ────────────────
// -> null | { level: 1 } | { level: 2, query, from, to }   (from/to = replaceable range, ch offsets in the line)
function computeContext(line, ch, { menu = true } = {}) {
  const t = line.match(TASK_RE);
  if (!t || ["x", "X", "-"].includes(t[2])) return null; // not a task, or already done / cancelled

  const after = line.slice(0, ch).match(AFTER_DUE_RE);
  if (after) {
    const query = after[1].trim();
    if (query.length > 24 || ISO_RE.test(query)) return null; // a complete date needs no menu
    return { level: 2, query, from: after.index + DUE.length, to: ch };
  }

  const atEnd = line.slice(ch).trim() === "";
  if (menu && atEnd && t[3].trim() !== "" && !line.includes(DUE)) return { level: 1 };
  return null;
}

// ── pure: date options -> [{ label, text: "YYYY-MM-DD" }] ────────────────────
function suggestDates(query, now = moment()) {
  const q = String(query || "").trim().toLowerCase();
  const today = now.clone().startOf("day");
  const out = [];
  const add = (label, date) => {
    const text = formatDate(date);
    if (!out.some((o) => o.text === text)) out.push({ label, text });
  };
  const weekday = (offset) => {
    const d = today.clone().add(offset, "days");
    return [cap(dayName(d.day())), d];
  };

  if (!q) {
    add("Today", today);
    add("Tomorrow", today.clone().add(1, "day"));
    for (let i = 2; i <= 6; i++) add(...weekday(i));
    add("Next week", today.clone().add(7, "days"));
    return out;
  }

  const named = [
    ["Today", today],
    ["Tomorrow", today.clone().add(1, "day")],
    ["Next week", today.clone().add(7, "days")],
    ["Next month", today.clone().add(1, "month")],
    ["Yesterday", today.clone().subtract(1, "day")],
  ];
  for (const [label, date] of named) if (label.toLowerCase().startsWith(q)) add(label, date);

  const wd = q.replace(/^next\s+/, "");
  for (let i = 0; i < 7; i++) {
    if (dayName(i).startsWith(wd)) add(cap(dayName(i)), today.clone().add(((i - today.day() + 6) % 7) + 1, "days"));
  }

  const rel = q.match(REL_RE);
  if (rel) {
    const n = Number(rel[1]);
    const unit = UNITS[(rel[2] || "d")[0]];
    add(`In ${n} ${n === 1 ? unit.slice(0, -1) : unit}`, today.clone().add(n, unit));
  }
  if (ISO_RE.test(q)) {
    const d = moment(q, "YYYY-MM-DD", true);
    if (d.isValid()) add("Date", d);
  }
  return out.slice(0, 8);
}

const STEP1 = [
  { type: "due", label: `${DUE} Due date` },
  { type: "newline", label: "\u23CE New line" },
];

// ── popup controller (one per editor view) ───────────────────────────────────
class DatePopup {
  constructor(view, plugin) {
    DatePopup.instances.add(this); // lets the "Diagnose" command prove the editor hook is attached
    this.view = view;
    this.plugin = plugin;
    this.el = null;
    this.ctx = null;
    this.items = [];
    this.index = 0;
    this.dismissed = false;
    this.onBlur = () => this.hide();
    this.onScroll = () => this.position();
    view.contentDOM.addEventListener("blur", this.onBlur);
    if (view.scrollDOM) view.scrollDOM.addEventListener("scroll", this.onScroll);
  }

  update(u) {
    try {
      if (!this.plugin.suggestActive()) return this.hide();
      const typed = u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"));
      if (typed) this.dismissed = false; // typing wakes the menu up again after Esc
      // only typing opens it; any other change/cursor move can only update or close an already-open menu
      if (!typed && !((u.docChanged || u.selectionSet) && this.ctx)) return;
      if (this.dismissed) return;
      this.refresh();
    } catch (err) {
      console.error("[Clockwork Tasks] date menu", err);
    }
  }

  // for the "Show due-date menu at cursor" command: open it without needing a keystroke
  show() {
    this.dismissed = false;
    this.refresh();
    return !!this.ctx;
  }

  refresh() {
    const { state } = this.view;
    const sel = state.selection.main;
    if (!sel.empty) return this.hide();
    const line = state.doc.lineAt(sel.head);
    const ctx = computeContext(line.text, sel.head - line.from, { menu: this.plugin.settings.dateMenu !== false });
    const items = !ctx ? [] : ctx.level === 1 ? STEP1 : suggestDates(ctx.query).map((o) => ({ ...o, label: `${o.label} (${o.text})` }));
    if (this.plugin.settings.debug) console.log("[Clockwork Tasks] menu:", { line: line.text, ctx, items: items.length });
    if (!ctx || !items.length) return this.hide();
    this.ctx = { ...ctx, lineFrom: line.from };
    this.items = items;
    this.index = 0;
    this.render();
    this.position();
  }

  render() {
    if (!this.el) {
      const doc = this.view.dom.ownerDocument || document; // also works in pop-out windows
      this.el = doc.createElement("div");
      this.el.className = "suggestion-container clockwork-suggest";
      // inline styles so it is visible whatever the theme / CSS snippets do to .suggestion-container
      Object.assign(this.el.style, {
        position: "fixed", zIndex: "10000", minWidth: "220px", maxHeight: "60vh", overflowY: "auto", display: "block",
        visibility: "hidden", background: "var(--background-primary)", border: "1px solid var(--background-modifier-border)",
        borderRadius: "var(--radius-m, 8px)", boxShadow: "var(--shadow-s, 0 2px 8px rgba(0,0,0,.3))", padding: "4px", left: "8px", top: "8px",
      });
      doc.body.appendChild(this.el);
    }
    this.el.textContent = "";
    const box = document.createElement("div");
    box.className = "suggestion";
    this.items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "suggestion-item mod-complex" + (i === this.index ? " is-selected" : "");
      row.textContent = item.label;
      Object.assign(row.style, { padding: "4px 10px", borderRadius: "var(--radius-s, 4px)", cursor: "pointer", color: "var(--text-normal)",
        background: i === this.index ? "var(--background-modifier-hover)" : "transparent" });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep the editor focused
        this.index = i;
        this.choose();
      });
      box.appendChild(row);
    });
    this.el.appendChild(box);
  }

  // CodeMirror forbids reading layout during an update, so ask it to measure afterwards (requestMeasure).
  position() {
    if (!this.el || !this.ctx) return;
    const head = this.view.state.selection.main.head;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        try {
          return view.coordsAtPos(head);
        } catch (e) {
          return null;
        }
      },
      write: (c) => {
        if (!this.el) return;
        if (c) {
          const win = this.el.ownerDocument.defaultView || window;
          const h = this.el.offsetHeight || 0;
          const below = c.bottom + 4;
          this.el.style.left = `${Math.max(4, c.left)}px`;
          this.el.style.top = `${below + h > win.innerHeight ? Math.max(4, c.top - h - 4) : below}px`;
        }
        this.el.style.visibility = "visible"; // hidden until placed, so it never flashes in a corner
      },
    });
  }

  hide() {
    this.ctx = null;
    this.items = [];
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }

  // returns true when the key was consumed
  handleKey(key) {
    if (!this.ctx) return false;
    if (key === "Escape") {
      this.dismissed = true;
      this.hide();
      return true;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      const n = this.items.length;
      this.index = (this.index + (key === "ArrowDown" ? 1 : n - 1)) % n;
      this.render();
      return true;
    }
    return key === "Enter" ? this.choose() : false;
  }

  choose() {
    const item = this.items[this.index];
    const ctx = this.ctx;
    if (!item || !ctx) return false;

    if (ctx.level === 1) {
      if (item.type === "newline") {
        this.dismissed = true;
        this.hide();
        return false; // let Enter do its normal job (new list item)
      }
      const head = this.view.state.selection.main.head;
      const prev = head > 0 ? this.view.state.doc.sliceString(head - 1, head) : "";
      const insert = `${prev && !/\s/.test(prev) ? " " : ""}${DUE} `;
      // "input.*" => counts as typing, so update() immediately swaps the menu for the date list
      this.view.dispatch({ changes: { from: head, insert }, selection: { anchor: head + insert.length }, userEvent: "input.clockwork" });
      return true;
    }

    const from = ctx.lineFrom + ctx.from;
    const to = ctx.lineFrom + ctx.to;
    const insert = ` ${item.text}`;
    this.hide();
    this.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.clockwork" });
    return true;
  }

  destroy() {
    DatePopup.instances.delete(this);
    this.hide();
    this.view.contentDOM.removeEventListener("blur", this.onBlur);
    if (this.view.scrollDOM) this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
  }
}

DatePopup.instances = new Set();

function createSuggestExtension(plugin) {
  const popup = ViewPlugin.fromClass(
    class extends DatePopup {
      constructor(view) {
        super(view, plugin);
      }
    }
  );
  plugin.menuPlugin = popup; // so commands can find the popup of an editor
  const run = (key) => (view) => {
    const p = view.plugin(popup);
    return !!p && p.handleKey(key);
  };
  return [
    popup,
    Prec.highest(
      keymap.of(["ArrowDown", "ArrowUp", "Enter", "Escape"].map((key) => ({ key, run: run(key) })))
    ),
  ];
}

module.exports = { computeContext, suggestDates, DatePopup, createSuggestExtension };
