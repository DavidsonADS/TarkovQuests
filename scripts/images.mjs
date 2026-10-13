// Copies the wiki's pictures into site/img. The wiki's image host cannot be
// reached from Russia without a VPN, so the site serves its own copies.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { WIKI, UA, pool } from './wiki.mjs';

const DIR = path.resolve(import.meta.dirname, '..', 'site', 'img');
const HOST_RE = /^https:\/\/static\.wikia\.nocookie\.net\//;
const SCALE_RE = /\/scale-to-(width|height)(-down)?\/\d+/;
// A picture that opens in the lightbox is stored once, wide enough to read a map.
const FULL_WIDTH = 800;
const HTML_FIELDS = ['requirements', 'goals', 'rewards', 'guide'];
const EXT = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, name) {
  for (let attempt = 1; ; attempt++) {
    try {
      // The image host turns away requests that name no page they come from.
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: `${WIKI}/`, Accept: 'image/webp,image/*' } });
      if (res.status === 429) await sleep((Number(res.headers.get('retry-after')) || 20 * attempt) * 1000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ext = EXT[res.headers.get('content-type')?.split(';')[0]];
      if (!ext) throw new Error(`not an image: ${res.headers.get('content-type')}`);
      const file = `${name}.${ext}`;
      await writeFile(path.join(DIR, file), Buffer.from(await res.arrayBuffer()));
      return file;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1000 * attempt);
    }
  }
}

// Calls fn(url) for every picture in the data and puts back what it returns.
function eachImage(data, fn) {
  for (const t of data.traders) t.image = fn(t.image);
  for (const q of data.quests) {
    q.image = fn(q.image);
    for (const k of q.keys) k.icon = fn(k.icon);
    for (const field of HTML_FIELDS) {
      if (!q[field].includes('<img')) continue;
      const $ = cheerio.load(q[field], null, false);
      $('img').each((_, el) => {
        const img = $(el);
        const src = img.attr('src') ?? '';
        const wide = img.closest('a.image').length ? src.replace(SCALE_RE, `/scale-to-width-down/${FULL_WIDTH}`) : src;
        img.attr('src', fn(wide));
      });
      q[field] = $.html();
    }
  }
}

// Replaces picture addresses in the data with paths inside the site.
export async function mirrorImages(data) {
  await mkdir(DIR, { recursive: true });
  // A file is named after its address, so a picture changed on the wiki is fetched again.
  const have = new Map((await readdir(DIR)).map((f) => [f.split('.')[0], f]));
  const nameOf = (url) => createHash('sha1').update(url).digest('hex').slice(0, 16);
  const urls = new Set();
  eachImage(data, (url) => { if (HOST_RE.test(url)) urls.add(url); return url; });

  const missing = [...urls].filter((url) => !have.has(nameOf(url)));
  let failed = 0;
  await pool(missing, 8, async (url) => {
    try {
      have.set(nameOf(url), await download(url, nameOf(url)));
    } catch (e) {
      failed++;
      console.log(`  no copy of ${url}: ${e.message}`);
    }
  });

  // A picture that could not be copied keeps its wiki address.
  eachImage(data, (url) => (have.has(nameOf(url)) ? `img/${have.get(nameOf(url))}` : url));
  const used = new Set([...urls].map(nameOf));
  const stale = [...have].filter(([name]) => !used.has(name));
  for (const [, file] of stale) await rm(path.join(DIR, file));
  console.log(`  ${urls.size} images: ${missing.length - failed} downloaded, ${failed} failed, ${stale.length} old removed`);
}
