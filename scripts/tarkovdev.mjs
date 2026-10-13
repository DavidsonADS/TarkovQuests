// Unlock conditions from tarkov.dev, which reads them from the game files.
// The wiki chains lag behind the game, so explicit data from here wins.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Game modes as tarkov.dev names them.
export const MODES = { pvp: 'regular', pve: 'pve' };
const BASE = 'https://json.tarkov.dev';
const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');

async function json(mode, name) {
  const file = path.join(CACHE_DIR, `tarkovdev-${mode}-${name}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  const res = await fetch(`${BASE}/${MODES[mode]}/${name}`);
  if (!res.ok) throw new Error(`tarkov.dev ${mode}/${name}: HTTP ${res.status}`);
  const data = await res.json();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

const TRADERS = {
  '54cb50c76803fa8b248b4571': 'Прапор',
  '54cb57776803fa99248b456e': 'Терапевт',
  '579dc571d53a0658a154fbec': 'Скупщик',
  '58330581ace78e27b8b10cee': 'Лыжник',
  '5935c25fb3acc3127c3d8cd9': 'Миротворец',
  '5a7c2eca46aef81a7ca2145d': 'Механик',
  '5ac3b934156ae10c4430e83c': 'Барахольщик',
  '5c0647fdd443bc2504c2d371': 'Егерь',
  '6617beeaa9cfa777ca915b7c': 'Реф',
  '638f541a29ffd1183d187f57': 'Смотритель',
  '656f0f98d80a697f855d34b1': 'Водитель БТР',
};

// Conditions the site cannot follow: the game hides such a quest until they
// are met, and tarkov.dev does not say what moves the counters.
function gates(t, nameOf) {
  const out = [];
  for (const r of t.otherRequirements ?? []) {
    if (r.type === 'globalVariable') out.push(`счётчик торговца должен дойти до ${r.value}`);
  }
  for (const r of t.traderRequirements) {
    if (r.requirementType === 'reputation') out.push(`репутация у торговца «${TRADERS[r.trader] ?? '?'}» ${r.compareMethod} ${r.value}`);
  }
  for (const r of t.taskRequirements) {
    if (r.status.every((s) => s === 'failed')) out.push(`нужно провалить квест «${nameOf(r.task)}»`);
  }
  if (t.factionName && t.factionName !== 'Any') out.push(`только для ${t.factionName}`);
  return out;
}

// Wiki titles and game names differ in ё, quotes, dashes and suffixes.
export const taskKey = (name) => name
  .replace(/\s*\[PV[PE] ZONE\]$/i, '')
  .replace(/\s*\(квест\)$/i, '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[^а-яa-z0-9]/g, '');

// Map(taskKey -> { level, trader, requires: [{ key, done }], loyalty, gates }).
// Names shared by several tasks (faction variants, prestige) are left out.
export async function gameTasks(mode) {
  const [tasks, ru] = await Promise.all([json(mode, 'tasks'), json(mode, 'tasks_ru')]);
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
      trader: TRADERS[t.trader] ?? '',
      // done: the earlier quest must be completed; otherwise taking it is enough.
      requires: t.taskRequirements
        .filter((r) => r.status.some((s) => s !== 'failed'))
        .map((r) => ({ key: keyOf.get(r.task), done: !r.status.includes('active') })),
      loyalty: t.traderRequirements
        .filter((r) => r.requirementType === 'level' && TRADERS[r.trader])
        .map((r) => [TRADERS[r.trader], r.value]),
      gates: gates(t, (id) => ru.data[tasks.data.tasks[id]?.name] ?? '?'),
    });
  }
  return out;
}
