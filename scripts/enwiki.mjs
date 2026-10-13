// Loyalty requirements from the English EFT wiki. Its quest infobox names the
// loyalty level a quest belongs to and how many quests of that level must be
// done first — the counters tarkov.dev lists without saying what they count.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const API = 'https://escapefromtarkov.fandom.com/api.php';
const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');
const UA = 'TarkovQuestsHelper/1.0 (personal quest tracker)';

async function wikitexts(titles) {
  const qs = new URLSearchParams({
    format: 'json', formatversion: '2', action: 'query', redirects: '1',
    prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.join('|'),
  }).toString();
  const file = path.join(CACHE_DIR, `enwiki-${createHash('sha1').update(qs).digest('hex')}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  const res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`EN wiki: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`EN wiki: ${json.error.info}`);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(json));
  return json;
}

// Map(title -> { tier, count }): the loyalty level of the quest and the number
// of quests of that level it waits for; 0 where the wiki leaves the field empty.
export async function loyaltyFields(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const { query } = await wikitexts(titles.slice(i, i + 50));
    // The answer names pages by their final title; map it back to what was asked.
    const asked = new Map();
    for (const n of query.normalized ?? []) asked.set(n.to, n.from);
    for (const r of query.redirects ?? []) asked.set(r.to, asked.get(r.from) ?? r.from);
    for (const page of query.pages) {
      const text = page.revisions?.[0]?.slots?.main?.content ?? '';
      if (!/\{\{\s*Infobox quest/i.test(text)) continue;
      const field = (name) => parseInt(text.match(new RegExp(`[|][ \\t]*${name}[ \\t]*=[ \\t]*(\\d+)`))?.[1], 10) || 0;
      out.set(asked.get(page.title) ?? page.title, { tier: field('LL requirement'), count: field('LL quests') });
    }
  }
  return out;
}
