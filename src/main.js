// Clockwork Tasks — standalone Obsidian plugin entry. No Templater and no Tasks plugin needed.
const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView } = require("obsidian");
const { createClockworkTasks, DEFAULTS } = require("./engine");
const { createPluginStore, nextPeriodStart } = require("./triggers");
const { transitionEdits } = require("./stamp");
const { createStampExtension } = require("./editor");
const { createSuggestExtension, DatePopup } = require("./suggest");
const { MARKER } = require("./parser");
const { moment, formatDate } = require("./utils");

const DEFAULT_SETTINGS = {
  configBlock: DEFAULTS.configBlock,
  defaultAnchor: DEFAULTS.defaultAnchor,
  rolloverTime: DEFAULTS.triggers.daily.at,
  activeTag: DEFAULTS.activeTag,
  doneHeading: DEFAULTS.doneHeading,
  deactivateStale: DEFAULTS.deactivateStale,
  checkIntervalSeconds: 300, // safety-net poll; the exact rollover is scheduled separately (see scheduleRollover)
  runOnStartup: true,
  doneDates: "auto", // ✅ / ❌ stamps. "auto" = only while the Tasks plugin is NOT enabled · "always" · "off"
  cancelDates: "always", // ❌ stamps. The Tasks plugin does not stamp these, so by default they stay on even when it is enabled
  dateSuggest: "auto", // 📅 menu. same three modes
  dateMenu: true, // step 1 of the menu ("Due date") while typing; off = the menu only appears after you type 📅
  debug: false,
};

const RESTART_CHECKED = /\[[xX]\][^\n]*%%clockwork-tasks:restart%%/;
const SNAPSHOT_LIMIT = 40;

module.exports = class ClockworkTasksPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    const saved = Object.assign({}, data.settings);
    if (saved.checkIntervalSeconds === undefined && saved.checkIntervalMinutes !== undefined) {
      saved.checkIntervalSeconds = Math.max(1, Math.round(Number(saved.checkIntervalMinutes) * 60)) || 300; // old setting was in minutes
    }
    delete saved.checkIntervalMinutes;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.state = data.state || {};
    this.running = false;
    this.queued = false;
    this.snapshots = new Map(); // path -> last known content (to find checkbox changes made outside the editor)
    this.saveChain = Promise.resolve();
    this.store = createPluginStore({ get: () => this.state, save: () => this.persist() });

    this.addSettingTab(new ClockworkTasksSettingTab(this.app, this));

    this.addCommand({ id: "run", name: "Run now", callback: () => this.run({ manual: true }) });
    this.addCommand({
      id: "force-run",
      name: "Force regenerate today's tasks",
      callback: () => this.run({ force: true, manual: true }),
    });
    this.addCommand({
      id: "clear-state",
      name: "Clear trigger state (next run regenerates)",
      callback: async () => {
        this.state = {};
        await this.persist();
        new Notice("Clockwork Tasks: trigger state cleared");
      },
    });

    this.addCommand({
      id: "due-menu",
      name: "Show due-date menu at cursor",
      editorCallback: (editor) => {
        if (!this.suggestActive()) return new Notice("Clockwork Tasks: the due-date menu is off (Tasks plugin enabled, or the setting is Off).");
        const view = editor.cm;
        const popup = view && this.menuPlugin ? view.plugin(this.menuPlugin) : null;
        if (!popup) return new Notice("Clockwork Tasks: the editor hook is not attached to this editor. Run \"Diagnose editor features\".");
        if (!popup.show()) new Notice("Put the cursor at the end of an open task line (- [ ] text) without a 📅, then try again.");
      },
    });
    this.addCommand({ id: "diagnose", name: "Diagnose editor features", callback: () => this.diagnose() });

    // Editor: instant ✅/❌ stamping (inside the checkbox transaction) + the 📅 menu. Works in every note.
    this.registerEditorExtension([createStampExtension(this), createSuggestExtension(this)]);

    // Outside the editor (reading-mode checkbox): compare with the last snapshot of the file.
    this.registerEvent(this.app.workspace.on("file-open", (file) => file && file.extension === "md" && this.snapshot(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultModify(file)));

    // regular check (safety net) + an exact wake-up at the next rollover
    this.startTimer();
    this.scheduleRollover();

    // on startup (delayed so Obsidian finishes loading the workspace and indexing notes first)
    if (this.settings.runOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        this.startupTimer = window.setTimeout(() => this.run(), 8000);
      });
    }
  }

  onunload() {
    clearTimeout(this.debounce);
    window.clearTimeout(this.startupTimer);
    window.clearTimeout(this.rolloverTimer);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────
  persist() {
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(() => this.saveData({ settings: this.settings, state: this.state }));
    return this.saveChain;
  }

  // ── Tasks-plugin coexistence ───────────────────────────────────────────────
  // "auto" = we only do a job while the Tasks plugin is NOT enabled, so the two never double up.
  tasksPluginActive() {
    const plugins = this.app.plugins;
    return !!(plugins && plugins.enabledPlugins && plugins.enabledPlugins.has("obsidian-tasks-plugin"));
  }

  featureOn(mode) {
    return mode === "always" || (mode === "auto" && !this.tasksPluginActive());
  }

  suggestActive() {
    return this.featureOn(this.settings.dateSuggest);
  }

  diagnose() {
    const s = this.settings;
    const info = {
      version: this.manifest && this.manifest.version,
      tasksPluginEnabled: this.tasksPluginActive(),
      doneDates: `${s.doneDates} -> ${this.featureOn(s.doneDates) ? "ACTIVE" : "inactive"}`,
      cancelDates: `${s.cancelDates} -> ${this.featureOn(s.cancelDates) ? "ACTIVE" : "inactive"}`,
      dateMenu: `${s.dateSuggest} -> ${this.suggestActive() ? "ACTIVE" : "inactive"}`,
      menuWhileTyping: s.dateMenu !== false,
      checkEvery: `${Math.floor(s.checkIntervalSeconds / 60)} min ${s.checkIntervalSeconds % 60} s`,
      nextRollover: this.nextRollover ? this.nextRollover.format("YYYY-MM-DD HH:mm:ss") : "not scheduled",
      editorsWithMenuHook: DatePopup.instances.size,
    };
    console.log("[Clockwork Tasks] diagnose", info);
    new Notice(
      "Clockwork Tasks " + info.version + "\n" + Object.entries(info).slice(1).map(([k, v]) => `${k}: ${v}`).join("\n"),
      15000
    );
  }

  stampOptions() {
    return {
      today: formatDate(moment()),
      skipMarker: MARKER,
      done: this.featureOn(this.settings.doneDates),
      cancel: this.featureOn(this.settings.cancelDates),
    };
  }

  // ── changes made outside the editor ────────────────────────────────────────
  remember(path, content) {
    this.snapshots.delete(path);
    if (!content.includes("[")) return; // no checkboxes, nothing to compare later
    this.snapshots.set(path, content);
    if (this.snapshots.size > SNAPSHOT_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value);
  }

  async snapshot(file) {
    try {
      this.remember(file.path, await this.app.vault.cachedRead(file));
    } catch (e) {
      /* file vanished */
    }
  }

  async onVaultModify(file) {
    if (file.extension !== "md") return;
    try {
      const content = await this.app.vault.read(file);
      if (RESTART_CHECKED.test(content)) this.requestRun({ manual: true });
      await this.stampExternal(file, content);
    } catch (err) {
      console.error("[Clockwork Tasks]", err);
    }
  }

  async stampExternal(file, content) {
    const prev = this.snapshots.get(file.path);
    this.remember(file.path, content);
    const opts = this.stampOptions();
    if (prev === undefined || prev === content || (!opts.done && !opts.cancel)) return;

    // the editor hook already handled anything typed/clicked in an editing view of this note
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file && view.file.path === file.path && view.getMode() === "source") return;

    if (!transitionEdits(prev, content, opts).edits.length) return;
    let result = content;
    await this.app.vault.process(file, (c) => (result = transitionEdits(prev, c, opts).content));
    this.remember(file.path, result);
  }

  startTimer() {
    if (this.timer) window.clearInterval(this.timer);
    const ms = Math.max(1, Number(this.settings.checkIntervalSeconds) || 300) * 1000;
    this.timer = window.setInterval(() => this.tick(), ms);
    this.registerInterval(this.timer);
  }

  // every regular check also re-syncs the exact timer (covers sleep, and system-clock changes)
  tick() {
    this.run();
    this.scheduleRollover();
  }

  // Works out how long until the next rollover (e.g. midnight) and wakes up exactly then, so new tasks
  // appear on time instead of at the next regular check.
  scheduleRollover() {
    window.clearTimeout(this.rolloverTimer);
    const next = nextPeriodStart(moment(), this.buildConfig());
    if (!next) return;
    const delay = Math.min(Math.max(0, next.diff(moment())) + 100, 2147483647); // +100 ms: land just after the boundary
    this.nextRollover = next;
    if (this.settings.debug) console.log(`[Clockwork Tasks] next rollover ${next.format("YYYY-MM-DD HH:mm:ss")} (in ${Math.round(delay / 1000)} s)`);
    this.rolloverTimer = window.setTimeout(() => {
      this.run();
      this.scheduleRollover();
    }, delay);
  }

  requestRun(options = {}) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.run(options), 400);
  }

  // Manual / restart runs always say what happened (the engine only notifies when tasks were created).
  showSummary(report) {
    console.log("[Clockwork Tasks] run report", report);
    if (report.created || (report.errors && report.errors.length)) return;
    const head = `Clockwork Tasks: ${report.taskFiles} TaskFile(s) found, ${report.fired} fired, ${report.duplicates} already present, 0 created.`;
    const why = report.taskFiles
      ? (report.notes || []).slice(0, 4).join("\n")
      : "No TaskFiles found. A note needs a ```" + this.buildConfig().configBlock + " block with an `output:` line.";
    new Notice(`${head}\n${why}`, 12000);
  }

  buildConfig() {
    const s = this.settings;
    return {
      configBlock: s.configBlock.trim() || DEFAULT_SETTINGS.configBlock,
      defaultAnchor: s.defaultAnchor,
      triggers: { daily: { at: s.rolloverTime } },
      activeTag: s.activeTag,
      doneHeading: s.doneHeading,
      deactivateStale: s.deactivateStale,
      debug: s.debug,
    };
  }

  async run(options = {}) {
    if (this.running) {
      this.queued = true; // re-run once the current pass finishes
      this.queuedOptions = options;
      return { status: "busy" };
    }
    this.running = true;
    try {
      const engine = createClockworkTasks(this.app, {
        config: this.buildConfig(),
        store: this.store,
        notify: (msg, ms) => new Notice(msg, ms),
      });
      const report = await engine.run(options);
      if (options.manual) this.showSummary(report);
      return report;
    } catch (err) {
      console.error("[Clockwork Tasks]", err);
      new Notice(`Clockwork Tasks failed: ${err.message}`, 8000);
      return { status: "error", errors: [err.message] };
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        this.requestRun(this.queuedOptions || {});
      }
    }
  }
};

// ── settings UI ──────────────────────────────────────────────────────────────
class ClockworkTasksSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    const text = (name, desc, key, after) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(String(p.settings[key])).onChange(async (v) => {
            p.settings[key] = v.trim();
            await p.persist();
            if (after) after();
          })
        );
    const toggle = (name, desc, key) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(p.settings[key]).onChange(async (v) => {
            p.settings[key] = v;
            await p.persist();
          })
        );
    const modes = { auto: "Auto (off while the Tasks plugin is enabled)", always: "Always on", off: "Off" };
    const mode = (name, desc, key) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addDropdown((d) =>
          d.addOptions(modes).setValue(p.settings[key]).onChange(async (v) => {
            p.settings[key] = v;
            await p.persist();
          })
        );

    text("Config block language", "Code-block language that marks a TaskFile (```clockwork-tasks).", "configBlock");
    text("Rollover time", "HH:MM. \"04:00\" keeps 00:00–03:59 as the previous day.", "rolloverTime", () => p.scheduleRollover());
    text("Default anchor date", "YYYY-MM-DD start for [cyclic] rotation. Override per file with `anchor:`.", "defaultAnchor");
    text("Active tag", "Tag added to today's generated tasks.", "activeTag");
    text("Done heading", "Heading under which completed tasks are moved.", "doneHeading");
    toggle("Deactivate stale tasks", "Strip the active tag from unfinished Clockwork Tasks tasks due before today.", "deactivateStale");

    mode("Done dates (✅)", "Stamp the date when a task in ANY note is ticked ([x]); remove it when unticked. Auto steps aside for the Tasks plugin, which does this itself.", "doneDates");
    mode("Cancelled dates (❌)", "Stamp the date when a task is cancelled ([-]). The Tasks plugin doesn't do this, so the default is Always on.", "cancelDates");
    mode("Due-date menu (📅)", "A menu while you type on a task line: Enter on \"Due date\" inserts 📅 and offers dates.", "dateSuggest");
    toggle("Show the menu while typing", "Off = the menu appears only after you type 📅 yourself.", "dateMenu");

    let minField, secField;
    const applyInterval = async () => {
      const total = (Number(minField.getValue()) || 0) * 60 + (Number(secField.getValue()) || 0);
      if (!(total >= 1)) return; // ignore 0 / half-typed values
      p.settings.checkIntervalSeconds = Math.floor(total);
      await p.persist();
      p.startTimer();
    };
    const field = (t, placeholder, value) => {
      t.setPlaceholder(placeholder).setValue(String(value)).onChange(applyInterval);
      t.inputEl.inputMode = "numeric";
      t.inputEl.size = 5;
      t.inputEl.setAttribute("aria-label", placeholder);
      return t;
    };
    const total = Number(p.settings.checkIntervalSeconds) || 300;
    new Setting(containerEl)
      .setName("Check interval")
      .setDesc("Left box: minutes, right box: seconds (e.g. 5 min 21 s). A safety-net check; new days are also caught exactly at the rollover time. Each check rescans the vault, so very short intervals cost performance.")
      .addText((t) => (minField = field(t, "minutes", Math.floor(total / 60))))
      .addText((t) => (secField = field(t, "seconds", total % 60)));
    toggle("Run on startup", "", "runOnStartup");
    toggle("Debug logging", "", "debug");
  }
}
