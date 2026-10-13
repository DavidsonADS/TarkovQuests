// Unlock conditions from tarkov.dev, which reads them from the game files.
// The wiki chains lag behind the game, so explicit data from here wins.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://json.tarkov.dev/regular';
const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');

async function json(name) {
  const file = path.join(CACHE_DIR, `tarkovdev-${name}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`tarkov.dev ${name}: HTTP ${res.status}`);
  const data = await res.json();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

// Wiki titles and game names differ in ё, quotes, dashes and suffixes.
export const taskKey = (name) => name
  .replace(/\s*\[PVP ZONE\]$/i, '')
  .replace(/\s*\(квест\)$/i, '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[^а-яa-z0-9]/g, '');

// Map(taskKey -> { level, requires: [{ key, done }], counter }).
// `counter` marks quests the game opens by a progress counter: tarkov.dev does
// not say which quests feed it, so their real prerequisites are unknown here.
// Names shared by several tasks (faction variants, prestige) are left out.
export async function gameTasks() {
  const [tasks, ru] = await Promise.all([json('tasks'), json('tasks_ru')]);
  const list = Object.values(tasks.data.tasks);
  const keyOf = new Map(list.map((t) => [t.id, taskKey(ru.data[t.name] ?? t.name)]));
  const seen = new Map();
  for (const key of keyOf.values()) seen.set(key, (seen.get(key) ?? 0) + 1);
  const out = new Map();
  for (const t of list) {
    const key = keyOf.get(t.id);
    if (seen.get(key) > 1) continue;
    out.set(key, {
      level: t.minPlayerLevel || 0,
      // done: the earlier quest must be completed; otherwise it only has to be
      // taken or failed, which the site does not track.
      requires: t.taskRequirements.map((r) => ({ key: keyOf.get(r.task), done: r.status.includes('complete') })),
      counter: (t.otherRequirements ?? []).some((r) => r.type === 'globalVariable'),
    });
  }
  return out;
}
