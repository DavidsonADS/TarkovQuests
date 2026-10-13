// Unlock conditions from tarkov.dev, which reads them from the game files.
// The wiki chains lag behind the game, so explicit data from here wins.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loyaltyFields } from './enwiki.mjs';

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

const counterReqs = (t) => (t.otherRequirements ?? []).filter((r) => r.type === 'globalVariable');

// Conditions the site cannot follow: the game hides such a quest until they
// are met. A counter lands here only while its loyalty level is unknown.
function gates(t, nameOf, tierOf) {
  const out = [];
  for (const r of counterReqs(t)) {
    if (!tierOf.has(r.variableId)) out.push(`счётчик торговца должен дойти до ${r.value}`);
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

// Which loyalty level each counter belongs to. A counter is the number of
// quests done for one trader at one loyalty level; tarkov.dev gives only its
// id, the English wiki gives the level of the quests that wait for it.
function counterTiers(list, wiki) {
  const votes = new Map();
  for (const t of list) {
    const tier = wiki.get(t.id)?.tier;
    if (!tier) continue;
    for (const r of counterReqs(t)) {
      const v = votes.get(r.variableId) ?? votes.set(r.variableId, new Map()).get(r.variableId);
      v.set(tier, (v.get(tier) ?? 0) + 1);
    }
  }
  return new Map([...votes].map(([id, v]) => [id, [...v].sort((a, b) => b[1] - a[1])[0][0]]));
}

// Map(taskKey -> { level, trader, requires: [{ key, done }], loyalty, tier, feeds, counters, gates }).
// Names shared by several tasks (faction variants, prestige) are left out.
export async function gameTasks(mode) {
  const [tasks, ru, en] = await Promise.all([json(mode, 'tasks'), json(mode, 'tasks_ru'), json(mode, 'tasks_en')]);
  const list = Object.values(tasks.data.tasks);
  const enName = (t) => en.data[t.name] ?? '';
  const byTitle = await loyaltyFields([...new Set(list.map(enName).filter(Boolean))]);
  const wiki = new Map(list.map((t) => [t.id, byTitle.get(enName(t))]));
  const tierOf = counterTiers(list, wiki);
  let agree = 0, differ = 0;
  for (const t of list) for (const r of counterReqs(t)) if (wiki.get(t.id)?.count) (wiki.get(t.id).count === r.value ? agree++ : differ++);
  const all = new Set(list.flatMap((t) => counterReqs(t).map((r) => r.variableId)));
  console.log(`  ${mode} — counters tied to a loyalty level: ${tierOf.size} of ${all.size}; values checked against the EN wiki: ${agree} match, ${differ} differ`);
  const keyOf = new Map(list.map((t) => [t.id, taskKey(ru.data[t.name] ?? t.name)]));
  const seen = new Map();
  for (const key of keyOf.values()) seen.set(key, (seen.get(key) ?? 0) + 1);
  const out = new Map();
  for (const t of list) {
    const key = keyOf.get(t.id);
    if (seen.get(key) > 1) continue;
    const loyalty = t.traderRequirements
      .filter((r) => r.requirementType === 'level' && TRADERS[r.trader])
      .map((r) => [TRADERS[r.trader], r.value]);
    const trader = TRADERS[t.trader] ?? '';
    const counters = counterReqs(t).filter((r) => tierOf.has(r.variableId)).map((r) => [tierOf.get(r.variableId), r.value]);
    // The loyalty level the quest belongs to: its counter's, else the wiki's, else the game's own.
    const tier = counters[0]?.[0] || wiki.get(t.id)?.tier || Math.max(1, ...loyalty.filter(([name]) => name === trader).map(([, n]) => n));
    if (tier > 1 && !loyalty.some(([name, n]) => name === trader && n >= tier)) loyalty.push([trader, tier]);
    out.set(key, {
      level: t.minPlayerLevel || 0,
      // The game files name no unlock condition at all.
      bare: !t.minPlayerLevel && !t.taskRequirements.length && !t.traderRequirements.length && !(t.otherRequirements ?? []).length,
      trader,
      // done: the earlier quest must be completed; otherwise taking it is enough.
      requires: t.taskRequirements
        .filter((r) => r.status.some((s) => s !== 'failed'))
        .map((r) => ({ key: keyOf.get(r.task), done: !r.status.includes('active') })),
      loyalty,
      tier,
      // Whether finishing the quest moves the counter of its loyalty level.
      // No source says which quests do; this rule is fitted to a real PvE
      // profile, where quests started by a talk with the trader did not count,
      // except the trader's very first one (the only such quest with a level).
      // It errs towards counting too few: a quest then shows up late, not early.
      feeds: !(t.otherRequirements ?? []).some((r) => r.type === 'dialogue') || t.minPlayerLevel > 0,
      // [loyalty level, how many quests of that level must be done for this trader]
      counters,
      gates: gates(t, (id) => ru.data[tasks.data.tasks[id]?.name] ?? '?', tierOf),
    });
  }
  return out;
}
