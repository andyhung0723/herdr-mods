// Scratchpad Data Persistence Service
import { appHome, readTextFile, writeTextFile, exec } from "herdr";

const REL_PATH = "data/scratchpad/store.json";

export function createDefaultTab(id = "tab-1", title = "Quick Scratch") {
  return {
    id,
    title,
    content: "",
    language: "markdown",
    updatedAt: Date.now(),
  };
}

export function getDefaultStore() {
  const tab = createDefaultTab();
  return {
    activeTabId: tab.id,
    tabs: [tab],
  };
}

export async function loadStore() {
  try {
    const fullPath = `${appHome()}/${REL_PATH}`;
    const raw = await readTextFile(fullPath);
    if (!raw) return getDefaultStore();

    const data = JSON.parse(raw);
    if (!Array.isArray(data.tabs) || data.tabs.length === 0) {
      return getDefaultStore();
    }

    // Ensure activeTabId is valid
    const hasActive = data.tabs.some((t) => t.id === data.activeTabId);
    if (!hasActive) {
      data.activeTabId = data.tabs[0].id;
    }

    return data;
  } catch {
    return getDefaultStore();
  }
}

export async function saveStore(store) {
  if (!store || !Array.isArray(store.tabs) || store.tabs.length === 0) return false;

  const fullPath = `${appHome()}/${REL_PATH}`;
  const serialized = JSON.stringify(store, null, 2);

  try {
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    // Ensure data directory exists
    await exec("mkdir", ["-p", dir], { on: null }).catch(() => {});

    const existing = await readTextFile(fullPath);
    await writeTextFile(fullPath, serialized, existing);
    return true;
  } catch (err) {
    // If optimistic concurrency mismatch or writeTextFile error, fallback to shell write
    try {
      await exec("sh", ["-c", `cat > "$1"`, "save", fullPath], { on: null });
      return true;
    } catch {
      return false;
    }
  }
}
