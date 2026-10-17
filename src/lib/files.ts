// Turns dropped files and folders into a small, useful upload. Folders become
// a tree listing plus their key files, so we never upload a whole repo.

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache", "target", "vendor", "__pycache__", ".venv", "venv", "coverage", ".wrangler"]);
const KEY_FILES = /^(readme(\.\w+)?|package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|gemfile|composer\.json|wrangler\.(toml|jsonc?)|tsconfig\.json|dockerfile|docker-compose\.ya?ml|makefile|\.env\.example|claude\.md|agents\.md)$/i;
const TEXT_EXT = /\.(md|mdx|txt|json|jsonc|ya?ml|toml|csv|xml|html?|css|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|cs|php|sh|sql|graphql|prisma|vue|svelte|astro)$/i;
const FOLDER_TEXT_BUDGET = 160_000;
const MAX_TREE_LINES = 600;

export const ACCEPT = "image/*,application/pdf,.md,.mdx,.txt,.json,.yaml,.yml,.toml,.csv,.ts,.tsx,.js,.jsx,.py,.go,.rs,.rb,.java,.swift,.sql,.html,.css,.sh";

export function isSupported(f: File) {
  return f.type.startsWith("image/") || f.type === "application/pdf" || f.type.startsWith("text/") || TEXT_EXT.test(f.name) || KEY_FILES.test(f.name);
}

function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((res, rej) => entry.file(res, rej));

async function walkFolder(root: FileSystemDirectoryEntry): Promise<File[]> {
  const tree: string[] = [];
  const keyFiles: { path: string; entry: FileSystemFileEntry; depth: number }[] = [];

  async function walk(dir: FileSystemDirectoryEntry, prefix: string, depth: number) {
    const entries = (await readEntries(dir)).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (tree.length >= MAX_TREE_LINES) return;
      if (e.name.startsWith(".") && !KEY_FILES.test(e.name)) continue;
      const path = `${prefix}${e.name}`;
      if (e.isDirectory) {
        if (SKIP_DIRS.has(e.name)) continue;
        tree.push(`${"  ".repeat(depth)}${e.name}/`);
        await walk(e as FileSystemDirectoryEntry, `${path}/`, depth + 1);
      } else {
        tree.push(`${"  ".repeat(depth)}${e.name}`);
        if (KEY_FILES.test(e.name) || (depth <= 1 && /\.(md|mdx)$/i.test(e.name)) || (depth <= 2 && TEXT_EXT.test(e.name))) {
          keyFiles.push({ path, entry: e as FileSystemFileEntry, depth });
        }
      }
    }
  }
  await walk(root, "", 0);

  // Key files first, then shallow source files, within a text budget.
  keyFiles.sort((a, b) => Number(!KEY_FILES.test(a.entry.name)) - Number(!KEY_FILES.test(b.entry.name)) || a.depth - b.depth);
  const out: File[] = [new File([`Folder: ${root.name}/\n\n${tree.join("\n")}`], `${root.name}-tree.txt`, { type: "text/plain" })];
  // Resolve file handles together (this only reads metadata, not contents), then apply the budget in order.
  const handles = await Promise.all(keyFiles.map((k) => fileOf(k.entry).catch(() => null)));
  let budget = FOLDER_TEXT_BUDGET;
  for (let i = 0; i < keyFiles.length; i++) {
    const k = keyFiles[i];
    const f = handles[i];
    if (!f || f.size > budget || f.size > 60_000) continue;
    budget -= f.size;
    out.push(new File([f], `${root.name}/${k.path}`, { type: f.type || "text/plain" }));
    if (out.length >= 30) break;
  }
  return out;
}

/** Reads a drop event, expanding any folders. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items].filter((i) => i.kind === "file");
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files].filter(isSupported);
  // Each dropped item is independent, so read them concurrently; results keep drop order.
  const groups = await Promise.all(
    entries.map(async (e) => {
      if (e.isDirectory) return walkFolder(e as FileSystemDirectoryEntry);
      const f = await fileOf(e as FileSystemFileEntry);
      return isSupported(f) ? [f] : [];
    }),
  );
  return groups.flat();
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
