// Builds site/data/quests.js from the Russian EFT wiki.
// Usage: node scripts/build.mjs   (delete .cache/ to force a fresh download)
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { WIKI, categoryMembers, wikitexts, parsedHtml, redirects, pool } from './wiki.mjs';

const OUT = path.resolve(import.meta.dirname, '..', 'site', 'data', 'quests.js');
const TRADER_ORDER = ['Прапор', 'Терапевт', 'Скупщик', 'Лыжник', 'Миротворец', 'Механик', 'Барахольщик', 'Егерь', 'Реф', 'Смотритель', 'Водитель БТР'];
const KEY_RE = /(^|[\s«"(])(ключ|ключ-карта|ключи)([\s,.)»"-]|$)|карта доступа|keycard/i;

// ---------- wikitext infobox ----------

function infobox(text) {
  const start = text.search(/\{\{\s*(Инфобокс квест|Infobox quest)/i);
  if (start < 0) return {};
  const parts = [];
  let depth = 0, cur = '';
  for (let i = start; i < text.length; i++) {
    const two = text.substr(i, 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if (two === '}}' || two === ']]') {
      depth--; i++;
      if (depth === 0) break;
      cur += two; continue;
    }
    if (text[i] === '|' && depth === 1) { parts.push(cur); cur = ''; continue; }
    cur += text[i];
  }
  parts.push(cur);
  const box = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    box[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).replace(/<!--[\s\S]*?-->/g, '').trim();
  }
  return box;
}

const pick = (box, ...keys) => keys.map((k) => box[k]).find((v) => v) ?? '';

function linkTargets(value) {
  const links = [...value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim());
  if (links.length) return links;
  return value.split(/<br\s*\/?>|\n/).map((s) => s.replace(/[[\]']/g, '').trim()).filter(Boolean);
}

// ---------- rendered HTML ----------

function cleanDom($, questTitles, redirectMap) {
  $('script, style, iframe, object, embed, form, input, link, meta, noscript').remove();
  $('.navbar, .mw-editsection, .toc, [class*="navbox"], .va-infobox, .mw-empty-elt').remove();
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs ?? {})) {
      if (/^on/i.test(name) || /^data-(?!src$)/.test(name)) $(el).removeAttr(name);
    }
  });
  $('img').each((_, el) => {
    const img = $(el);
    const lazy = img.attr('data-src');
    if (lazy) img.attr('src', lazy);
    img.removeAttr('data-src').removeAttr('srcset').removeClass('lazyload').attr('loading', 'lazy');
  });
  $('a').each((_, el) => {
    const a = $(el);
    let href = a.attr('href') ?? '';
    if (/^\s*javascript:/i.test(href)) { a.removeAttr('href'); return; }
    if (href.startsWith('/ru/wiki/')) {
      const title = decodeURIComponent(href.slice('/ru/wiki/'.length).split('#')[0]).replace(/_/g, ' ');
      const quest = questTitles.has(title) ? title : redirectMap.get(title);
      if (quest && questTitles.has(quest)) a.attr('data-quest', quest);
      href = 'https://escapefromtarkov.fandom.com' + href;
    } else if (href.startsWith('/')) {
      href = 'https://escapefromtarkov.fandom.com' + href;
    }
    a.attr('href', href).attr('target', '_blank').attr('rel', 'noopener noreferrer');
  });
}

const imgSrc = (img) => img.attr('data-src') ?? img.attr('src') ?? '';

function extractItems($, table) {
  const rows = [];
  let header = null;
  $(table).find('tr').each((_, tr) => {
    const cells = $(tr).children('th, td');
    const texts = cells.map((_, c) => $(c).text().trim()).get();
    if (texts.some((t) => /^иконка$/i.test(t))) { header = texts.map((t) => t.toLowerCase()); return; }
    if (!header || cells.length < 3) return;
    const col = (re) => { const i = header.findIndex((h) => re.test(h)); return i >= 0 ? cells.eq(i) : null; };
    const nameCell = col(/назван/);
    if (!nameCell) return;
    const link = nameCell.find('a').first();
    rows.push({
      name: nameCell.text().trim().replace(/\s+/g, ' '),
      url: link.attr('href') ?? '',
      icon: col(/иконка/)?.find('img').first().attr('src') ?? '',
      count: col(/кол/)?.text().trim() ?? '',
      condition: col(/услов|требован/)?.text().trim() ?? '',
      fir: col(/рейд/)?.text().trim() ?? '',
      note: col(/примеч/)?.text().trim().replace(/\s+/g, ' ') ?? '',
    });
  });
  return rows;
}

function parsePage(html, questTitles, redirectMap) {
  const $ = cheerio.load(html);
  const root = $('.mw-parser-output').first();
  const image = imgSrc(root.find('.va-infobox img').first());
  cleanDom($, questTitles, redirectMap);

  const out = { image, description: '', requirements: '', goals: '', rewards: '', guide: '', items: [] };
  let section = null;
  root.children().each((_, el) => {
    const node = $(el);
    if (el.tagName === 'h2') {
      const heading = node.text().trim();
      const h = heading.toLowerCase();
      if (/^диалог/.test(h)) section = 'description';
      else if (/^(важно|требования)/.test(h)) section = 'requirements';
      else if (/^цел/.test(h)) section = 'goals';
      else if (/^наград/.test(h)) section = 'rewards';
      else if (/факты|пасхалк|смотрите|мелочи/.test(h)) section = null;
      else {
        section = 'guide';
        if (!/^выполнение$/.test(h)) out.guide += `<h3>${cheerio.load('')('<i>').text(heading).html()}</h3>`;
      }
      return;
    }
    if (!section) return;
    if (section === 'description') {
      if (!out.description) out.description = node.find('cite').first().text().replace(/\\n/g, '\n').trim();
      return;
    }
    // Trader quotes inside reward sections are flavour text, not guidance.
    if (section === 'rewards' && node.find('cite').length) return;
    if (section === 'guide') node.find('table').addBack('table').each((_, t) => out.items.push(...extractItems($, t)));
    out[section] += $.html(el);
  });

  for (const k of ['requirements', 'goals', 'rewards', 'guide']) {
    const probe = cheerio.load(out[k]);
    if (!probe.text().trim() && !probe('img').length) out[k] = '';
  }
  const goalsDom = cheerio.load(out.goals + out.guide);
  const keys = new Map();
  for (const it of out.items) if (KEY_RE.test(it.name)) keys.set(it.name, it);
  goalsDom('a[title]').each((_, a) => {
    const title = goalsDom(a).attr('title');
    if (KEY_RE.test(title) && !/^Ключи$/.test(title) && !keys.has(title)) {
      keys.set(title, { name: title, url: goalsDom(a).attr('href'), icon: '', note: '' });
    }
  });
  out.keys = [...keys.values()].map(({ name, url, icon, note, condition }) => ({ name, url, icon, note, condition: condition ?? '' }));
  return out;
}

// ---------- main ----------

console.log('Listing quests…');
const titles = await categoryMembers('Квесты');
const flagSets = {
  event: new Set(await categoryMembers('Ивент квест')),
  arena: new Set(await categoryMembers('Квесты Arena')),
  seasonal: new Set(await categoryMembers('Сезонный квест')),
  story: new Set(await categoryMembers('Глава истории')),
};
console.log(`  ${titles.length} pages. Fetching wikitext…`);
const texts = await wikitexts(titles);
const questTitles = new Set(titles);

const meta = new Map();
const unknownLinks = new Set();
for (const title of titles) {
  const text = texts.get(title) ?? '';
  const box = infobox(text);
  const m = {
    box,
    trader: linkTargets(pick(box, 'выдает', 'выдаёт', 'given by'))[0] ?? '',
    maps: linkTargets(pick(box, 'локация', 'location')),
    prev: linkTargets(pick(box, 'предыдущий_квест', 'previous')),
    next: linkTargets(pick(box, 'следующий_квест', 'leads to')),
    kappa: /^нужен/i.test(pick(box, 'для_каппы', 'reqkappa')),
    type: pick(box, 'тип_квеста').replace(/[[\]]/g, ''),
    level: parseInt(pick(box, 'уровень'), 10) || 0,
    historical: /\{\{\s*Historical content/i.test(text.replace(/<!--[\s\S]*?-->/g, '')),
    eventTpl: /\{\{\s*Ивент квест плашка/i.test(text),
  };
  for (const l of [...m.prev, ...m.next]) if (!questTitles.has(l)) unknownLinks.add(l);
  meta.set(title, m);
}

const redirectMap = await redirects([...unknownLinks]);
const resolve = (l) => (questTitles.has(l) ? l : questTitles.has(redirectMap.get(l)) ? redirectMap.get(l) : null);
const unresolved = [...unknownLinks].filter((l) => !resolve(l));
console.log(`  Unresolved quest links (${unresolved.length}): ${unresolved.slice(0, 40).join(' | ')}`);

const prereqs = new Map(titles.map((t) => [t, new Set()]));
for (const [title, m] of meta) {
  for (const p of m.prev.map(resolve)) if (p && p !== title) prereqs.get(title).add(p);
  for (const n of m.next.map(resolve)) if (n && n !== title) prereqs.get(n).add(title);
}
const unlocks = new Map(titles.map((t) => [t, []]));
for (const [title, set] of prereqs) for (const p of set) unlocks.get(p).push(title);

console.log('Fetching rendered pages…');
const quests = [];
await pool(titles, 4, async (title) => {
  const m = meta.get(title);
  const page = parsePage(await parsedHtml(title), questTitles, redirectMap);
  const levelText = cheerio.load(page.requirements).text().match(/(\d+)[\s-]*(?:го\s+)?уров/i);
  quests.push({
    id: title,
    trader: m.trader || 'Прочее',
    maps: m.maps.filter((x) => x && !/^(любая|нет|-)$/i.test(x)),
    type: m.type,
    level: m.level || (levelText ? parseInt(levelText[1], 10) : 0),
    kappa: m.kappa,
    flags: [
      (flagSets.event.has(title) || m.eventTpl) && 'event',
      flagSets.arena.has(title) && 'arena',
      flagSets.seasonal.has(title) && 'seasonal',
      flagSets.story.has(title) && 'story',
      m.historical && 'historical',
    ].filter(Boolean),
    prev: [...prereqs.get(title)].sort(),
    next: unlocks.get(title).sort(),
    wiki: `${WIKI}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    ...page,
    items: undefined,
  });
});
quests.sort((a, b) => a.id.localeCompare(b.id, 'ru'));

const traderNames = [...new Set(quests.map((q) => q.trader))].sort((a, b) => {
  const ia = TRADER_ORDER.indexOf(a), ib = TRADER_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'ru');
});
console.log('Fetching trader portraits…');
const traders = [];
for (const name of traderNames) {
  let image = '';
  try {
    const $ = cheerio.load(await parsedHtml(name));
    image = imgSrc($('.va-infobox img').first());
  } catch (e) {
    console.log(`  no portrait for ${name}: ${e.message}`);
  }
  traders.push({ name, image, count: quests.filter((q) => q.trader === name).length });
}

const data = { built: new Date().toISOString(), source: WIKI, traders, quests };
await writeFile(OUT, `window.TQ_DATA = ${JSON.stringify(data)};\n`);

const stat = (f) => quests.filter(f).length;
console.log(`Done: ${quests.length} quests, ${(JSON.stringify(data).length / 1e6).toFixed(1)} MB`);
console.log(`  with guide: ${stat((q) => q.guide)}, with goals: ${stat((q) => q.goals)}, with keys: ${stat((q) => q.keys.length)}, with level: ${stat((q) => q.level)}`);
console.log(`  roots (no prereqs): ${stat((q) => !q.prev.length)}, event: ${stat((q) => q.flags.includes('event'))}, historical: ${stat((q) => q.flags.includes('historical'))}, arena: ${stat((q) => q.flags.includes('arena'))}`);
console.log('  traders:', traders.map((t) => `${t.name} ${t.count}${t.image ? '' : ' (no image)'}`).join(', '));
