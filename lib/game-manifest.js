const fs = require("fs");
const path = require("path");

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function toTempleSummary(temple) {
  const levels = Array.isArray(temple.levels)
    ? temple.levels.map((level, index) => ({
        id: String(level.id),
        index: Number(level.index != null ? level.index : index),
        filename: level.filename ? String(level.filename) : null,
      }))
    : [];

  return {
    id: String(temple.id),
    index: Number(temple.index != null ? temple.index : 0),
    title: temple.title || temple.id || "",
    levels,
  };
}

function createLevelLookup(temples) {
  const byTemple = new Map();
  const byKey = new Map();
  const completedLevels = [];

  temples.forEach((temple) => {
    const levelsById = new Map();
    const levelsByFilename = new Map();

    temple.levels.forEach((level) => {
      const levelId = String(level.id);
      const key = `${temple.id}:${levelId}`;
      levelsById.set(levelId, level);
      if (level.filename) {
        levelsByFilename.set(String(level.filename), level);
      }
      byKey.set(key, {
        templeId: temple.id,
        levelId,
        filename: level.filename || null,
      });
      completedLevels.push(key);
    });

    byTemple.set(temple.id, {
      temple,
      levelsById,
      levelsByFilename,
    });
  });

  return {
    byTemple,
    byKey,
    completedLevels,
  };
}

function loadGameManifest(rootDir) {
  const gameConfig = readJsonFile(path.join(rootDir, "game.json"));
  const templePaths = Array.isArray(gameConfig.temples) ? gameConfig.temples : [];
  const templeData = templePaths.map((templePath) =>
    readJsonFile(path.join(rootDir, "data", templePath, "temple.json")),
  );

  const temples = templeData
    .slice()
    .sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
  const templeSummaries = temples.map(toTempleSummary);
  const lookup = createLevelLookup(templeSummaries);

  return {
    gameConfig,
    temples,
    templeSummaries,
    byTemple: lookup.byTemple,
    byKey: lookup.byKey,
    completedLevels: lookup.completedLevels,
  };
}

function createManifestResponse(manifest) {
  return {
    ok: true,
    gameConfig: manifest.gameConfig,
    temples: manifest.temples,
  };
}

function resolveLevelKey(manifest, templeId, levelId, filename) {
  const templeEntry = manifest.byTemple.get(String(templeId || ""));
  if (!templeEntry) {
    return null;
  }

  if (levelId != null && levelId !== "") {
    const directLevelId = String(levelId);
    if (templeEntry.levelsById.has(directLevelId)) {
      return `${templeEntry.temple.id}:${directLevelId}`;
    }
  }

  if (filename) {
    const byFilename = templeEntry.levelsByFilename.get(String(filename));
    if (byFilename) {
      return `${templeEntry.temple.id}:${String(byFilename.id)}`;
    }
  }

  return null;
}

function listAllLevelKeys(manifest) {
  return manifest.completedLevels.slice();
}

module.exports = {
  createManifestResponse,
  listAllLevelKeys,
  loadGameManifest,
  resolveLevelKey,
};
