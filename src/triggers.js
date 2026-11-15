// Trigger component: trigger definitions, the handler that reads/writes trigger state, and the state store.

const { createRegistry } = require("./utils");

// ── trigger definitions ──────────────────────────────────────────────────────
//   name
//   resolve(now: moment, options) -> { periodKey, date }
//     periodKey = identity of the current period (fires once per distinct key)
//     date      = the logical day the generated tasks belong to
const triggers = [
  {
    // With at = "00:00" the day rolls over at midnight; "04:00" keeps 00:00-03:59 as the previous day.
    name: "daily",
    resolve(now, { at = "00:00" } = {}) {
      const [h = 0, m = 0] = String(at).split(":").map(Number);
      const logical = now.clone().subtract(h, "hours").subtract(m, "minutes").startOf("day");
      return { periodKey: logical.format("YYYY-MM-DD"), date: logical };
    },
    // Real-clock moment at which the NEXT period begins (e.g. the coming midnight, or 04:00 with at = "04:00").
    nextChange(now, { at = "00:00" } = {}) {
      const [h = 0, m = 0] = String(at).split(":").map(Number);
      const logical = now.clone().subtract(h, "hours").subtract(m, "minutes").startOf("day");
      return logical.add(1, "day").hour(h).minute(m).second(0).millisecond(0);
    },
  },
];

// Earliest moment any trigger starts a new period, so the plugin can wake up exactly then instead of waiting for a poll.
// Returns null when no trigger can name a next period. (A non-numeric rollover time behaves like 00:00, as in resolve().)
function nextPeriodStart(now, config) {
  let next = null;
  for (const def of triggers) {
    if (!def.nextChange) continue;
    const at = def.nextChange(now, (config.triggers && config.triggers[def.name]) || {});
    if (at && at.isValid() && (!next || at.isBefore(next))) next = at;
  }
  return next;
}

const createTriggerRegistry = (extra = []) => createRegistry("trigger", [...triggers, ...extra]);

// ── handler ──────────────────────────────────────────────────────────────────
// Two-phase on purpose:
//   evaluate() -> decision (reads state)
//   commit()   -> persists state; called ONLY after tasks were written, so a failed run retries.
function createTriggerHandler({ store, registry, config, clock }) {
  const key = (taskFile) => `trigger:${taskFile.path}`;

  return {
    async evaluate(taskFile, { force = false } = {}) {
      const def = registry.get(taskFile.settings.trigger);
      if (!def) return { fired: false, error: `Unknown trigger "${taskFile.settings.trigger}"` };

      const { periodKey, date } = def.resolve(clock(), config.triggers[def.name] || {});
      const base = { trigger: def.name, periodKey, date };

      if (force) return { ...base, fired: true, reason: "forced" };

      const state = await store.get(key(taskFile));
      if (state && state.periodKey === periodKey) return { ...base, fired: false, reason: "already-fired" };
      return { ...base, fired: true, reason: "period-elapsed" };
    },

    commit: (taskFile, decision) =>
      store.set(key(taskFile), {
        trigger: decision.trigger,
        periodKey: decision.periodKey,
        firedAt: clock().toISOString(),
      }),

    reset: (taskFile) => store.remove(key(taskFile)),
  };
}

// ── state stores (async interface: get / set / remove) ───────────────────────
// Swap in a plugin data.json store later without touching the handler.
function createLocalStorageStore(app, namespace = "clockwork-tasks") {
  const vault = app?.vault?.getName?.() || "vault";
  const full = (key) => `${namespace}:${vault}:${key}`;
  return {
    async get(key) {
      try {
        const raw = window.localStorage.getItem(full(key));
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    async set(key, value) {
      window.localStorage.setItem(full(key), JSON.stringify(value));
    },
    async remove(key) {
      window.localStorage.removeItem(full(key));
    },
  };
}

function createMemoryStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? JSON.parse(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

// Persists trigger state in the plugin's data.json (syncs with the vault, so all devices agree).
// `host` = { get(): object, save(): Promise }  (the plugin owns the object + the write)
function createPluginStore(host) {
  return {
    async get(key) {
      return host.get()[key] || null;
    },
    async set(key, value) {
      host.get()[key] = value;
      await host.save();
    },
    async remove(key) {
      delete host.get()[key];
      await host.save();
    },
  };
}

module.exports = { createTriggerRegistry, createTriggerHandler, createLocalStorageStore, createMemoryStore, createPluginStore, nextPeriodStart };
