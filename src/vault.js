// The ONLY place (besides the localStorage store in triggers.js) that touches the Obsidian API.
// A future plugin can ship its own `io` with the same four methods (exists, read, update, findByCodeBlock).

function createVaultIO(app) {
  const getFile = (path) => {
    const f = app.vault.getAbstractFileByPath(path);
    return f && !f.children ? f : null;
  };
  const need = (path) => {
    const f = getFile(path);
    if (!f) throw new Error(`File not found: ${path}`);
    return f;
  };

  return {
    exists: (path) => !!getFile(path),

    read: (path) => app.vault.read(need(path)),

    // transform: (currentContent) => newContent (pure, sync). Atomic via vault.process when available.
    // Returns true if the file changed.
    async update(path, transform) {
      const file = need(path);
      const current = await app.vault.read(file);
      const next = transform(current);
      if (next === current) return false;
      if (typeof app.vault.process === "function") await app.vault.process(file, transform);
      else await app.vault.modify(file, next);
      return true;
    },

    // Files containing a ```<lang> block. Uses the metadata cache to skip notes with no code blocks at all.
    // Yields to the UI every few files so a big vault can't freeze Obsidian.
    async findByCodeBlock(lang) {
      const re = new RegExp("^```" + String(lang).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "im");
      const found = [];
      let scanned = 0;
      for (const f of app.vault.getMarkdownFiles()) {
        const sections = app.metadataCache.getFileCache(f)?.sections;
        if (sections && !sections.some((s) => s.type === "code")) continue;
        if (re.test(await app.vault.cachedRead(f))) found.push(f.path);
        if (++scanned % 20 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      return found;
    },
  };
}

module.exports = { createVaultIO };
