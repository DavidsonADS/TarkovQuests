// Thin client for the Russian EFT wiki MediaWiki API with an on-disk cache.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const WIKI = 'https://escapefromtarkov.fandom.com/ru';
const API = `${WIKI}/api.php`;
const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');
const UA = 'TarkovQuestsHelper/1.0 (personal quest tracker)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(params, { cache = true } = {}) {
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
  const file = path.join(CACHE_DIR, createHash('sha1').update(qs).digest('hex') + '.json');
  if (cache) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {}
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': UA } });
      if (res.status === 429) {
        // Fandom rate limit: back off for as long as it asks.
        await sleep((Number(res.headers.get('retry-after')) || 20 * attempt) * 1000);
        throw new Error('HTTP 429');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.info);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify(json));
      return json;
    } catch (e) {
      if (attempt >= 6) throw e;
      await sleep(1000 * attempt);
    }
  }
}

export async function categoryMembers(category, type = 'page') {
  const out = [];
  let cmcontinue;
  do {
    const r = await api({
      action: 'query', list: 'categorymembers', cmtitle: `Категория:${category}`,
      cmtype: type, cmlimit: '500', ...(cmcontinue ? { cmcontinue } : {}),
    });
    out.push(...r.query.categorymembers.map((m) => m.title));
    cmcontinue = r.continue?.cmcontinue;
  } while (cmcontinue);
  return out;
}

export async function wikitexts(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const r = await api({
      action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
      titles: titles.slice(i, i + 50).join('|'),
    });
    for (const p of r.query.pages) out.set(p.title, p.revisions?.[0]?.slots?.main?.content ?? '');
  }
  return out;
}

export async function parsedHtml(title) {
  const r = await api({
    action: 'parse', page: title, prop: 'text', disableeditsection: '1', disablelimitreport: '1',
  });
  return r.parse.text;
}

// Resolves redirects; returns Map(from -> to) for titles that are redirects.
export async function redirects(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const r = await api({ action: 'query', redirects: '1', titles: titles.slice(i, i + 50).join('|') });
    const norm = new Map((r.query.normalized ?? []).map((n) => [n.to, n.from]));
    for (const rd of r.query.redirects ?? []) out.set(norm.get(rd.from) ?? rd.from, rd.to);
  }
  return out;
}

export async function pool(items, size, fn) {
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
      if (++done % 50 === 0) console.log(`  ${done}/${items.length}`);
    }
  }));
}
