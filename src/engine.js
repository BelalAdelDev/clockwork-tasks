// Config + wiring + orchestration. Contains no parsing / generating / date logic itself.
//
//   1. discover + parse TaskFiles          parser.js
//   2. evaluate triggers (or restart)      triggers.js
//   3. generate today's tasks              generator.js
//   4. write + move done tasks             generator.js (insert) · checker.js (sweep)
//   5. commit trigger state, reset restart checkbox

const { createScheduleRegistry, createModifierRegistry } = require("./rules");
const { createTaskFileParser, discoverTaskFiles, restartControl } = require("./parser");
const { createTriggerRegistry, createTriggerHandler, createLocalStorageStore } = require("./triggers");
const { createTasksGenerator, insertTasks } = require("./generator");
const { createTasksChecker } = require("./checker");
const { createVaultIO } = require("./vault");
const { createLogger, compactBlankLines, formatDate, moment } = require("./utils");

// ── config (override per run with options.config) ────────────────────────────
const DEFAULTS = {
  configBlock: "clockwork-tasks", // language of the ```clockwork-tasks code block that marks a TaskFile
  defaultTrigger: "daily",
  defaultAnchor: "2026-11-15", // rotation start for [cyclic]; override per file with `anchor:` in the block
  triggers: { daily: { at: "00:00" } }, // per-trigger options
  activeTag: "#active",
  doneHeading: "###### Done",
  doneStatuses: ["x", "X", "-"], // checkbox states that count as done
  deactivateStale: true, // strip #active from unfinished Clockwork Tasks tasks due before today
  stateNamespace: "clockwork-tasks",
  debug: false,
};

function mergeConfig(overrides = {}) {
  const triggers = { ...DEFAULTS.triggers };
  for (const [key, value] of Object.entries(overrides.triggers || {})) {
    triggers[key] = { ...(triggers[key] || {}), ...value };
  }
  return {
    ...DEFAULTS,
    ...overrides,
    triggers,
  };
}

// ── engine ───────────────────────────────────────────────────────────────────
function createEngine({ io, store, config, clock, log, notify = () => {}, extensions = {} }) {
  const schedules = createScheduleRegistry(extensions.schedules);
  const modifiers = createModifierRegistry(extensions.modifiers);
  const triggerRegistry = createTriggerRegistry(extensions.triggers);

  const parser = createTaskFileParser({ config, schedules, modifiers });
  const triggers = createTriggerHandler({ store, registry: triggerRegistry, config, clock });
  const generator = createTasksGenerator({ config, schedules, modifiers });
  const checker = createTasksChecker({ config });

  async function loadTaskFiles(paths, report) {
    const models = [];
    for (const path of paths) {
      try {
        const model = parser.parse(path, await io.read(path));
        report.warnings.push(...model.warnings);
        if (model.errors.length) {
          report.errors.push(...model.errors.map((e) => `${path}: ${e}`));
          continue;
        }
        if (!model.restart.present) await io.update(path, (c) => restartControl.ensure(c, config.configBlock));
        models.push(model);
      } catch (err) {
        report.errors.push(`${path}: ${err.message}`);
      }
    }
    return models;
  }

  async function run(options = {}) {
    const report = { status: "idle", taskFiles: 0, fired: 0, created: 0, duplicates: 0, warnings: [], errors: [], notes: [], outputs: [] };

    // 1. identify + read
    const models = await loadTaskFiles(await discoverTaskFiles(io, config, options.paths), report);
    report.taskFiles = models.length;

    // 2 + 3. trigger decision + generation, grouped by output file
    const groups = new Map();
    for (const model of models) {
      const output = model.settings.output;
      if (!groups.has(output)) groups.set(output, { output, tags: new Set(), fired: [] });
      const group = groups.get(output);
      model.lists.forEach((l) => l.tag && !l.errors.length && group.tags.add(l.tag));

      const decision = await triggers.evaluate(model, { force: Boolean(options.force || model.restart.checked) });
      if (decision.error) {
        report.errors.push(`${model.path}: ${decision.error}`);
        continue;
      }
      log.debug(`${model.path}: fired=${decision.fired} (${decision.reason}) period=${decision.periodKey}`);
      if (!decision.fired) {
        report.notes.push(`${model.path}: already ran for ${decision.periodKey} (tick "Restart" or use "Force regenerate")`);
        continue;
      }

      const generated = generator.generate(model, decision.date);
      if (!model.lists.length) report.notes.push(`${model.path}: no ###### (level-6) headings found`);
      const skippedLists = generated.skipped.map((s) => `${s.listId} (${s.reason})`);
      report.notes.push(
        `${model.path}: ${generated.entries.length} task(s) scheduled for ${generated.date}` +
          (skippedLists.length ? `; skipped lists: ${skippedLists.join(", ")}` : "")
      );
      group.fired.push({ model, decision, generated });
    }

    report.outputs = [...groups.keys()];

    // 4 + 5. write, sweep, commit
    for (const group of groups.values()) {
      if (!group.fired.length) continue;
      try {
        if (!io.exists(group.output)) throw new Error(`Output file not found: ${group.output}`);

        const entries = group.fired.flatMap((f) => f.generated.entries);
        const today = group.fired.map((f) => formatDate(f.decision.date)).sort().pop();

        let result = { inserted: [], skipped: [] };
        await io.update(group.output, (content) => {
          result = insertTasks(content, entries, config);
          return compactBlankLines(checker.sweep(result.content, { today, managedTags: [...group.tags] }));
        });

        for (const { model, decision } of group.fired) {
          await triggers.commit(model, decision);
          if (model.restart.checked) await io.update(model.path, restartControl.reset);
        }
        report.fired += group.fired.length;
        report.created += result.inserted.length;
        report.duplicates += result.skipped.length;
        report.notes.push(`${group.output}: inserted ${result.inserted.length}, already present ${result.skipped.length}`);
      } catch (err) {
        report.errors.push(`${group.output}: ${err.message}`);
      }
    }

    report.status = report.errors.length ? "error" : report.created ? "created" : report.fired ? "no-new-tasks" : "idle";
    if (report.created) notify(`Clockwork Tasks: created ${report.created} task(s)`);
    if (report.warnings.length) notify(`Clockwork Tasks: ${report.warnings.length} warning(s) - see console`, 6000);
    if (report.errors.length) notify(`Clockwork Tasks: ${report.errors.length} error(s) - see console`, 8000);
    report.notes.forEach((n) => log.debug(n));
    report.warnings.forEach((w) => log.warn(w));
    report.errors.forEach((e) => log.error(e));
    return report;
  }

  return { run };
}

// ── composition root: real implementations. A future plugin passes its own io / store / notify. ──
function createClockworkTasks(app, options = {}) {
  const config = mergeConfig(options.config);
  return createEngine({
    io: options.io || createVaultIO(app),
    store: options.store || createLocalStorageStore(app, config.stateNamespace),
    clock: options.now ? () => moment(options.now) : () => moment(),
    log: createLogger({ debug: config.debug }),
    notify: options.notify,
    config,
    extensions: options.extensions,
  });
}

module.exports = { createClockworkTasks, createEngine, mergeConfig, DEFAULTS };
