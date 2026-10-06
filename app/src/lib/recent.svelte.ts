// Recently opened files (max 20, newest first), persisted in localStorage.
const KEY = "oie.recent";
const MAX = 20;

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function save(list: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: keep in memory only */ }
}

class RecentFiles {
  list = $state<string[]>(load());

  add(path: string) {
    const lower = path.toLowerCase();
    this.list = [path, ...this.list.filter((p) => p.toLowerCase() !== lower)].slice(0, MAX);
    save(this.list);
  }

  remove(path: string) {
    this.list = this.list.filter((p) => p !== path);
    save(this.list);
  }

  clear() {
    this.list = [];
    save(this.list);
  }
}

export const recent = new RecentFiles();
