// macOS and Windows checkouts are case-insensitive by default, so two paths
// that differ only in case (e.g. `qwen/` and `Qwen/`) collapse into one there
// while staying separate on Linux. Every file and every directory leading to
// it must stay unique once lowercased.
export function pathCollisions(files: string[]): string[] {
  const seen = new Map<string, Set<string>>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const key = prefix.toLowerCase();
      const variants = seen.get(key) ?? new Set<string>();
      variants.add(prefix);
      seen.set(key, variants);
    }
  }
  return [...seen.values()]
    .filter((variants) => variants.size > 1)
    .map((variants) => [...variants].sort().join(" and "))
    .sort();
}
