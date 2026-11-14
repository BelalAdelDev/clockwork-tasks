// Clockwork Tasks — standalone Obsidian plugin entry. No Templater needed.
const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
const { createClockworkTasks, DEFAULTS } = require("./engine");
const { createPluginStore } = require("./triggers");

const DEFAULT_SETTINGS = {
  configBlock: DEFAULTS.configBlock,
  defaultAnchor: DEFAULTS.defaultAnchor,
  rolloverTime: DEFAULTS.triggers.daily.at,
  activeTag: DEFAULTS.activeTag,
  doneHeading: DEFAULTS.doneHeading,
  deactivateStale: DEFAULTS.deactivateStale,
  checkIntervalMinutes: 5,
  runOnStartup: true,
  debug: false,
};

const RESTART_CHECKED = /\[[xX]\][^\n]*%%clockworks-tasks:restart%%/;

module.exports = class ClockworkTasksPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    this.state = data.state || {};
    this.running = false;
    this.queued = false;
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

    // event-based: react as soon as a restart checkbox is checked
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (file.extension !== "md") return;
        if (RESTART_CHECKED.test(await this.app.vault.read(file))) this.requestRun({ manual: true });
      })
    );

    // tick-based: catches the midnight rollover
    this.startTimer();

    // on startup: wait until the vault index is ready
    // (delayed so Obsidian finishes loading the workspace and indexing notes first)
    if (this.settings.runOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        this.startupTimer = window.setTimeout(() => this.run(), 8000);
      });
    }
  }

  onunload() {
    clearTimeout(this.debounce);
    window.clearTimeout(this.startupTimer);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────
  persist() {
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(() => this.saveData({ settings: this.settings, state: this.state }));
    return this.saveChain;
  }

  startTimer() {
    if (this.timer) window.clearInterval(this.timer);
    const ms = Math.max(1, Number(this.settings.checkIntervalMinutes) || 5) * 60 * 1000;
    this.timer = window.setInterval(() => this.run(), ms);
    this.registerInterval(this.timer);
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

    text("Config block language", "Code-block language that marks a TaskFile (```clockworks-tasks).", "configBlock");
    text("Rollover time", "HH:MM. \"04:00\" keeps 00:00–03:59 as the previous day.", "rolloverTime");
    text("Default anchor date", "YYYY-MM-DD start for [cyclic] rotation. Override per file with `anchor:`.", "defaultAnchor");
    text("Active tag", "Tag added to today's generated tasks.", "activeTag");
    text("Done heading", "Heading under which completed tasks are moved.", "doneHeading");

    new Setting(containerEl)
      .setName("Deactivate stale tasks")
      .setDesc("Strip the active tag from unfinished Clockwork Tasks tasks due before today.")
      .addToggle((t) =>
        t.setValue(p.settings.deactivateStale).onChange(async (v) => {
          p.settings.deactivateStale = v;
          await p.persist();
        })
      );

    new Setting(containerEl)
      .setName("Check interval (minutes)")
      .setDesc("How often to check for a new day.")
      .addText((t) =>
        t.setValue(String(p.settings.checkIntervalMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 1) return;
          p.settings.checkIntervalMinutes = n;
          await p.persist();
          p.startTimer();
        })
      );

    new Setting(containerEl)
      .setName("Run on startup")
      .addToggle((t) =>
        t.setValue(p.settings.runOnStartup).onChange(async (v) => {
          p.settings.runOnStartup = v;
          await p.persist();
        })
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .addToggle((t) =>
        t.setValue(p.settings.debug).onChange(async (v) => {
          p.settings.debug = v;
          await p.persist();
        })
      );
  }
}
