(() => {
  'use strict';

  const DATA = window.TQ_DATA;
  const STORE_KEY = 'tq-state-v1';
  const ACTIVE_TAB = '__active__';
  const HIDDEN_BY_DEFAULT = ['event', 'arena', 'seasonal', 'historical'];
  const FLAG_LABELS = { event: 'ивент', arena: 'Arena', seasonal: 'сезонный', story: 'сюжет', historical: 'устарел' };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  if (!DATA) {
    $('#detail').innerHTML = '<div class="empty">Нет данных. Запустите <code>npm run build</code>, чтобы скачать квесты с вики.</div>';
    return;
  }

  const byId = new Map(DATA.quests.map((q) => [q.id, q]));

  // ---------- state ----------

  const defaults = { status: {}, level: 0, filters: {}, v: 2, autosave: true, trader: DATA.traders[0].name, map: '', selected: null, showDone: false, showLocked: false };
  let state = load();

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
      // v1 showed event quests by default; keep progress, drop that default.
      if (!saved.v && saved.filters) delete saved.filters.event;
      return { ...defaults, ...saved, v: 2 };
    } catch {
      return { ...defaults };
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {}
  }

  const isDone = (id) => state.status[id] === 'done';

  function statusOf(q) {
    const s = state.status[q.id];
    if (s) return s;
    if (!q.prev.every(isDone)) return 'locked';
    if (state.level && q.level > state.level) return 'locked';
    return 'available';
  }

  const visible = (q) => q.flags.every((f) => (HIDDEN_BY_DEFAULT.includes(f) ? state.filters[f] : true));

  function ancestors(id, acc = new Set()) {
    for (const p of byId.get(id).prev) {
      if (!acc.has(p)) {
        acc.add(p);
        ancestors(p, acc);
      }
    }
    return acc;
  }

  // Quests the player has in progress keep their status: the wiki chain is not
  // always strict, so a "previous" quest can still be active in the game.
  function finishAncestors(id) {
    const anc = [...ancestors(id)].filter((a) => !state.status[a]);
    anc.forEach((a) => { state.status[a] = 'done'; });
    return anc;
  }

  function finishedToast(ids) {
    if (!ids.length) return;
    const shown = ids.slice(0, 12).join(', ');
    toast(`Отмечены выполненными (${ids.length}): ${shown}${ids.length > 12 ? ` и ещё ${ids.length - 12}` : ''}`);
  }

  // ---------- actions ----------

  function complete(id) {
    const before = new Set(DATA.quests.filter((q) => statusOf(q) === 'available').map((q) => q.id));
    state.status[id] = 'done';
    const opened = byId.get(id).next.filter((n) => !before.has(n) && statusOf(byId.get(n)) === 'available');
    toast(opened.length ? `Открыты новые квесты: ${opened.join(', ')}` : 'Квест завершён');
  }

  const actions = {
    accept: (id) => { state.status[id] = 'active'; },
    complete,
    reopen: (id) => { delete state.status[id]; },
    cancel: (id) => { delete state.status[id]; },
    'jump-active': (id) => {
      const anc = finishAncestors(id);
      state.status[id] = 'active';
      finishedToast(anc);
    },
    'jump-done': (id) => {
      const anc = finishAncestors(id);
      state.status[id] = 'done';
      finishedToast([...anc, id]);
    },
  };

  // ---------- rendering ----------

  function renderTraders() {
    const active = DATA.quests.filter((q) => state.status[q.id] === 'active').length;
    const tiles = [`
      <button class="trader ${state.trader === ACTIVE_TAB ? 'current' : ''}" data-trader="${ACTIVE_TAB}">
        <span class="portrait all">★</span><span class="tname">Активные</span>
        <span class="tcount">${active || '—'}</span>
      </button>`];
    for (const t of DATA.traders) {
      const qs = DATA.quests.filter((q) => q.trader === t.name && visible(q));
      if (!qs.length) continue;
      const act = qs.filter((q) => statusOf(q) === 'active').length;
      const avail = qs.filter((q) => statusOf(q) === 'available').length;
      const done = qs.filter((q) => statusOf(q) === 'done').length;
      tiles.push(`
        <button class="trader ${state.trader === t.name ? 'current' : ''}" data-trader="${esc(t.name)}" title="Выполнено ${done} из ${qs.length}">
          ${t.image ? `<img class="portrait" src="${esc(t.image)}" alt="">` : `<span class="portrait all">${esc(t.name[0])}</span>`}
          <span class="tname">${esc(t.name)}</span>
          <span class="tcount">${act ? `<b class="act">${act}</b>` : ''}${avail ? `<b class="avail">${avail}</b>` : ''}${!act && !avail ? '—' : ''}</span>
        </button>`);
    }
    $('#traders').innerHTML = tiles.join('');
  }

  function listRow(q, showTrader) {
    const st = statusOf(q);
    const sub = [showTrader ? q.trader : '', q.maps.join(', '), q.level ? `ур. ${q.level}` : ''].filter(Boolean).join(' · ');
    return `
      <button class="row ${st} ${state.selected === q.id ? 'current' : ''}" data-quest="${esc(q.id)}">
        <span class="rname">${esc(q.id)}${q.keys.length ? ' <span class="keymark" title="Нужен ключ">🔑</span>' : ''}</span>
        <span class="rsub">${esc(sub)}${q.flags.map((f) => ` <i class="flag ${f}">${FLAG_LABELS[f]}</i>`).join('')}</span>
      </button>`;
  }

  const onMap = (q) => !state.map || q.maps.includes(state.map);

  function renderMaps() {
    const counts = new Map();
    for (const q of DATA.quests.filter(visible)) {
      for (const m of q.maps) counts.set(m, (counts.get(m) ?? 0) + (state.status[q.id] === 'active' ? 1 : 0));
    }
    if (!counts.has(state.map)) state.map = '';
    const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
    const sel = $('#map');
    sel.innerHTML = '<option value="">Все локации</option>'
      + names.map((m) => `<option value="${esc(m)}">${esc(m)}${counts.get(m) ? ` — активных: ${counts.get(m)}` : ''}</option>`).join('');
    sel.value = state.map;
    sel.classList.toggle('on', !!state.map);
  }

  function renderList() {
    const query = $('#search').value.trim().toLowerCase();
    let pool = DATA.quests.filter(visible);
    let showTrader = false;
    if (query) {
      // Search ignores the category filters so hidden event quests are still findable.
      pool = DATA.quests.filter((q) => q.id.toLowerCase().includes(query));
      showTrader = true;
    } else if (state.trader === ACTIVE_TAB) {
      pool = pool.filter((q) => statusOf(q) === 'active');
      showTrader = true;
    } else {
      pool = pool.filter((q) => q.trader === state.trader);
    }
    // Quests with no location can be done on any map, so they stay in sight.
    const mapped = !!state.map && !query;
    const anywhere = mapped ? pool.filter((q) => !q.maps.length && ['active', 'available'].includes(statusOf(q))) : [];
    if (mapped) pool = pool.filter(onMap);
    const groups = [
      ['active', 'Активные', true],
      ['available', 'Доступные', true],
      ['locked', 'Заблокированные', state.showLocked || !!query],
      ['done', 'Завершённые', state.showDone || !!query],
    ];
    let html = '';
    for (const [key, label, shown] of groups) {
      const items = pool.filter((q) => statusOf(q) === key);
      if (!items.length || !shown) continue;
      if (key === 'locked') items.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id, 'ru'));
      html += `<h3 class="group ${key}">${label} <span>${items.length}</span></h3>${items.map((q) => listRow(q, showTrader)).join('')}`;
    }
    if (!html && mapped) {
      html = `<div class="empty">На локации «${esc(state.map)}» здесь ничего нет.</div>`;
    } else if (!html) {
      html = state.trader === ACTIVE_TAB && !query
        ? '<div class="empty">Нет активных квестов. Выберите торговца и нажмите «Принять» на квесте.</div>'
        : '<div class="empty">Здесь пусто. Включите «Заблокированные» или «Завершённые» выше.</div>';
    }
    if (anywhere.length) {
      html += `<h3 class="group">Без привязки к локации <span>${anywhere.length}</span></h3>${anywhere.map((q) => listRow(q, showTrader)).join('')}`;
    }
    $('#list').innerHTML = html;
  }

  const chip = (id) => {
    const q = byId.get(id);
    return `<button class="chip ${statusOf(q)}" data-quest="${esc(id)}">${esc(id)} <small>${esc(q.trader)}</small></button>`;
  };

  function keysBlock(q) {
    if (!q.keys.length) return '';
    return `
      <section class="block keys">
        <h2>Нужные ключи</h2>
        ${q.keys.map((k) => `
          <div class="key">
            ${k.icon ? `<img src="${esc(k.icon)}" alt="">` : '<span class="key-ph">🔑</span>'}
            <div>
              <a href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">${esc(k.name)}</a>
              ${k.condition ? `<span class="cond">${esc(k.condition)}</span>` : ''}
              ${k.note ? `<p>${esc(k.note)}</p>` : ''}
            </div>
          </div>`).join('')}
      </section>`;
  }

  function buttons(q, st) {
    const b = (action, label, cls = '') => `<button class="act-btn ${cls}" data-action="${action}">${label}</button>`;
    if (st === 'available') return b('accept', 'Принять', 'primary') + b('jump-done', 'Уже выполнен');
    if (st === 'active') return b('complete', 'Завершить', 'primary') + b('cancel', 'Отменить');
    if (st === 'done') return b('accept', 'Он у меня активен', 'primary') + b('reopen', 'Вернуть в невыполненные');
    return b('jump-active', 'Я сейчас на этом квесте', 'primary') + b('jump-done', 'Уже выполнен');
  }

  function lockReason(q) {
    const missing = q.prev.filter((p) => !isDone(p));
    const parts = [];
    if (missing.length) parts.push(`сначала выполните: ${missing.map(chip).join(' ')}`);
    if (state.level && q.level > state.level) parts.push(`нужен ${q.level} уровень (у вас ${state.level})`);
    return parts.length ? `<div class="lock-reason">Заблокирован — ${parts.join('; ')}</div>` : '';
  }

  function renderDetail() {
    const q = byId.get(state.selected);
    const el = $('#detail');
    if (!q) {
      el.innerHTML = '<div class="empty big">Выберите торговца сверху и квест слева.<br>Нажмите «Принять», как в игре, — и увидите, что делать и какой ключ взять.</div>';
      return;
    }
    const st = statusOf(q);
    const stLabel = { active: 'активно!', available: 'доступно', locked: 'заблокировано', done: 'завершено' }[st];
    const block = (title, html, cls = '') => (html ? `<section class="block ${cls}"><h2>${title}</h2><div class="wiki">${html}</div></section>` : '');
    el.innerHTML = `
      <div class="qhead">
        <div class="qtitle">
          <h1>${esc(q.id)}</h1>
          <div class="qmeta">
            <span>${esc(q.trader)}</span>
            ${q.maps.length ? `<span>${esc(q.maps.join(', '))}</span>` : ''}
            ${q.level ? `<span>с ${q.level} уровня</span>` : ''}
            ${q.type ? `<span>${esc(q.type)}</span>` : ''}
            ${q.kappa ? '<span class="kappa">нужен для Каппы</span>' : ''}
            ${q.flags.map((f) => `<i class="flag ${f}">${FLAG_LABELS[f]}</i>`).join('')}
          </div>
        </div>
        <span class="qstatus ${st}">${stLabel}</span>
      </div>
      <div class="qactions">${buttons(q, st)}</div>
      ${st === 'locked' ? lockReason(q) : ''}
      ${keysBlock(q)}
      ${block('Цели', q.goals, 'goals')}
      ${block('Важно', q.requirements, 'req')}
      ${q.guide
        ? block('Как выполнить', q.guide, 'guide')
        : `<section class="block guide"><h2>Как выполнить</h2><p class="muted">На вики пока нет описания прохождения этого квеста. <a href="${esc(q.wiki)}" target="_blank" rel="noopener">Открыть страницу квеста</a></p></section>`}
      ${block('Награда', q.rewards, 'rewards')}
      ${q.prev.length ? `<section class="block"><h2>Предыдущие квесты</h2><div class="chips">${q.prev.map(chip).join('')}</div></section>` : ''}
      ${q.next.length ? `<section class="block"><h2>Открывает квесты</h2><div class="chips">${q.next.map(chip).join('')}</div></section>` : ''}
      ${q.description || q.image ? `
        <details class="block story">
          <summary>Что говорит торговец</summary>
          ${q.image ? `<img class="banner" src="${esc(q.image)}" alt="">` : ''}
          <p>${esc(q.description).replace(/\n+/g, '</p><p>')}</p>
        </details>` : ''}
      <p class="source">Источник: <a href="${esc(q.wiki)}" target="_blank" rel="noopener">${esc(q.id)} на Escape from Tarkov Wiki</a></p>`;
    el.scrollTop = 0;
  }

  // ---------- what to bring ----------
  // Built from the goal lines of active quests; the wiki has no per-goal
  // progress, so goals the player already finished are listed too.

  const KIT_GROUPS = [
    ['plant', 'Заложить и установить', /^(установить|заложить|оставить|спрятать|положить)/i],
    ['use', 'Использовать на месте', /^(пометить|засветить|подать|починить|отремонтировать|перепрошить|воспользоваться)/i],
    ['gear', 'Оружие и снаряжение', /^(убить|устранить|ликвидировать|уничтожить).*(использ|надев|надет|экипиров|одевшись|\sиз\s|\sбез\s|глушител|прицел)/i],
  ];
  const KIT_KEY_RE = /^ключ|карта доступа|keycard/i;
  const KIT_FOUND_RE = /подбираем|для передачи/i;
  const OPTIONAL_RE = /^\(опционально\)\s*/i;
  // Goals name maps in any grammatical case ("на Развязке", "в Лесу"), often
  // without a link, so each map is matched by its stem.
  const MAP_RES = [...new Set(DATA.quests.flatMap((q) => q.maps))].map((name) => {
    const [first, ...rest] = name.split(' ');
    const stem = first.length > 4 ? first.replace(/[аяыйе]$/, '') : first;
    return [name, new RegExp(`(?<![а-яёА-ЯЁ])${stem}[а-яё]{0,3}${rest.map((w) => ` ${w}`).join('')}(?![а-яё])`)];
  });

  function lineMaps(text) {
    // "на локации X" is the place of the goal; other map names may be landmarks.
    const explicit = text.split(/на локаци(?:и|ях)\s+/)[1];
    return MAP_RES.filter(([, re]) => re.test(explicit ?? text)).map(([name]) => name);
  }

  function goalLines(q) {
    const doc = new DOMParser().parseFromString(q.goals, 'text/html');
    return [...doc.querySelectorAll('li')].map((li) => {
      const own = li.cloneNode(true);
      own.querySelectorAll('ul, ol').forEach((n) => n.remove());
      const text = own.textContent.replace(/\s+/g, ' ').trim();
      return { text, body: text.replace(OPTIONAL_RE, ''), maps: lineMaps(text), optional: OPTIONAL_RE.test(text) };
    });
  }

  function collectKit() {
    const quests = DATA.quests.filter((q) => state.status[q.id] === 'active' && (onMap(q) || !q.maps.length));
    const kit = { quests, keys: new Map(), plant: [], use: [], gear: [] };
    for (const q of quests) {
      for (const k of q.keys) {
        if (!KIT_KEY_RE.test(k.name) || KIT_FOUND_RE.test(k.condition)) continue;
        const entry = kit.keys.get(k.name) ?? { ...k, quests: [] };
        entry.quests.push(q.id);
        kit.keys.set(k.name, entry);
      }
      for (const line of goalLines(q)) {
        // A goal that names another map belongs to a different raid.
        if (state.map && line.maps.length && !line.maps.includes(state.map)) continue;
        const group = KIT_GROUPS.find(([, , re]) => re.test(line.body));
        if (group) kit[group[0]].push({ ...line, quest: q.id });
      }
    }
    return kit;
  }

  function openKit() {
    const kit = collectKit();
    const questBtn = (id) => `<button class="kit-quest" data-quest="${esc(id)}">${esc(id)}</button>`;
    const keys = [...kit.keys.values()];
    let body = '';
    if (keys.length) {
      body += `<section class="block keys"><h2>Ключи <span>${keys.length}</span></h2>${keys.map((k) => `
        <div class="key">
          ${k.icon ? `<img src="${esc(k.icon)}" alt="">` : '<span class="key-ph">🔑</span>'}
          <div>
            <a href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">${esc(k.name)}</a>
            ${k.condition ? `<span class="cond">${esc(k.condition)}</span>` : ''}
            ${k.note ? `<p>${esc(k.note)}</p>` : ''}
            ${k.quests.map(questBtn).join('')}
          </div>
        </div>`).join('')}</section>`;
    }
    for (const [key, label] of KIT_GROUPS) {
      if (!kit[key].length) continue;
      body += `<section class="block"><h2>${label} <span>${kit[key].length}</span></h2>${kit[key].map((l) => `
        <div class="kit-line ${l.optional ? 'optional' : ''}">${esc(l.text)}${questBtn(l.quest)}</div>`).join('')}</section>`;
    }
    if (!kit.quests.length) {
      body = `<div class="empty">Нет активных квестов${state.map ? ` на локации «${esc(state.map)}»` : ''}. Примите квест у торговца — и здесь появится, что под него взять.</div>`;
    } else if (!body) {
      body = '<div class="empty">Для этих квестов ничего особенного брать не нужно: ни ключей, ни предметов для закладки.</div>';
    } else {
      body += '<p class="kit-note">Список собран по целям активных квестов с вики. Выполненные цели внутри квеста сайт не отслеживает — уже заложенное просто пропустите. Нажмите на название квеста, чтобы открыть его.</p>';
    }
    $('#kit').innerHTML = `
      <div class="kit-head">
        <h1>Что взять с собой<small>${esc(state.map || 'Все локации')} · активных квестов: ${kit.quests.length}</small></h1>
        <button class="act-btn" data-close>Закрыть</button>
      </div>
      <div class="kit-body">${body}</div>`;
    $('#kit').showModal();
    $('#kit').scrollTop = 0;
  }

  function render() {
    renderTraders();
    renderMaps();
    renderList();
    renderDetail();
    save();
  }

  function select(id, { switchTrader = true } = {}) {
    const q = byId.get(id);
    if (!q) return;
    state.selected = id;
    if (switchTrader && state.trader !== ACTIVE_TAB && !$('#search').value) state.trader = q.trader;
    const hash = '#' + encodeURIComponent(id);
    if (location.hash !== hash) history.pushState(null, '', hash);
    render();
  }

  // ---------- toast & lightbox ----------

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  function openLightbox(src) {
    const box = $('#lightbox');
    box.querySelector('img').src = src.replace(/\/scale-to-(width|height)(-down)?\/\d+/, '');
    box.hidden = false;
  }

  // ---------- events ----------

  $('#traders').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-trader]');
    if (!btn) return;
    state.trader = btn.dataset.trader;
    $('#search').value = '';
    render();
  });

  $('#list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-quest]');
    if (row) select(row.dataset.quest, { switchTrader: false });
  });

  $('#detail').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]');
    if (action) {
      actions[action.dataset.action](state.selected);
      render();
      autosave();
      return;
    }
    const quest = e.target.closest('[data-quest]');
    if (quest) {
      e.preventDefault();
      select(quest.dataset.quest);
      return;
    }
    const img = e.target.closest('.wiki img, .banner');
    if (img && img.naturalWidth > 80) {
      e.preventDefault();
      openLightbox(img.closest('a.image')?.href || img.src);
    }
  });

  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });

  $('#search').addEventListener('input', renderList);
  $('#map').addEventListener('change', (e) => { state.map = e.target.value; render(); });
  $('#kit-open').addEventListener('click', openKit);
  $('#kit').addEventListener('click', (e) => {
    const quest = e.target.closest('[data-quest]');
    if (quest) select(quest.dataset.quest);
    if (quest || e.target.closest('[data-close]') || e.target === e.currentTarget) $('#kit').close();
  });
  $('#level').addEventListener('change', (e) => {
    state.level = Math.max(0, Math.min(79, parseInt(e.target.value, 10) || 0));
    render();
    autosave();
  });
  const listToggles = [['#show-done', 'showDone'], ['#show-locked', 'showLocked']];
  function showToggles() {
    for (const [sel, key] of listToggles) {
      $(sel).classList.toggle('primary', state[key]);
      $(sel).setAttribute('aria-pressed', state[key]);
    }
  }
  for (const [sel, key] of listToggles) {
    $(sel).addEventListener('click', () => { state[key] = !state[key]; showToggles(); render(); });
  }
  document.querySelectorAll('[data-filter]').forEach((cb) => {
    cb.checked = !!state.filters[cb.dataset.filter];
    cb.addEventListener('change', () => { state.filters[cb.dataset.filter] = cb.checked; render(); });
  });

  // ---------- progress file ----------
  // Chromium browsers can remember the chosen file, so after the first pick
  // saving and loading take one click. Others fall back to download/upload.

  const FILE_NAME = 'tarkov-quests-progress.json';
  const FILE_TYPES = [{ description: 'Прогресс квестов', accept: { 'application/json': ['.json'] } }];
  const canPickFiles = 'showSaveFilePicker' in window;
  let fileHandle = null;

  function handleStore(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('tq', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  async function rememberFile(handle) {
    fileHandle = handle;
    try {
      await handleStore('readwrite', (s) => (handle ? s.put(handle, 'progressFile') : s.delete('progressFile')));
    } catch {}
    showFileName();
  }

  function showFileName() {
    const name = fileHandle?.name;
    $('#save').title = name ? `Сохранить прогресс в файл ${name}` : 'Сохранить прогресс в файл';
    $('#load').title = name ? `Загрузить прогресс из файла ${name}` : 'Загрузить прогресс из файла';
    $('#forget-file').hidden = !name;
  }

  async function allowed(mode) {
    if ((await fileHandle.queryPermission({ mode })) === 'granted') return true;
    return (await fileHandle.requestPermission({ mode })) === 'granted';
  }

  const progressJson = () => JSON.stringify({ status: state.status, level: state.level }, null, 1);

  function applyProgress(text) {
    const data = JSON.parse(text);
    state.status = Object.fromEntries(Object.entries(data.status ?? {}).filter(([id, s]) => byId.has(id) && (s === 'active' || s === 'done')));
    state.level = parseInt(data.level, 10) || 0;
    $('#level').value = state.level || '';
    render();
    toast(`Прогресс загружен: отмечено квестов — ${Object.keys(state.status).length}`);
  }

  async function writeProgress() {
    if (!(await allowed('readwrite'))) return false;
    const out = await fileHandle.createWritable();
    await out.write(progressJson());
    await out.close();
    return true;
  }

  // Writes are chained so quick successive clicks never overlap on the file.
  let writeQueue = Promise.resolve();
  function autosave() {
    if (!state.autosave || !fileHandle) return;
    writeQueue = writeQueue.then(async () => {
      try {
        if (!(await writeProgress())) throw new Error('denied');
        $('#save').classList.add('saved');
        setTimeout(() => $('#save').classList.remove('saved'), 1200);
      } catch {
        toast('Автосохранение не удалось. Нажмите «Сохранить», чтобы записать прогресс вручную.');
      }
    });
  }

  async function saveProgress() {
    if (!canPickFiles) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([progressJson()], { type: 'application/json' }));
      a.download = FILE_NAME;
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    try {
      if (!fileHandle) await rememberFile(await window.showSaveFilePicker({ suggestedName: FILE_NAME, types: FILE_TYPES }));
      if (!(await writeProgress())) return toast('Нет разрешения на запись в файл');
      toast(`Сохранено в ${fileHandle.name}`);
    } catch (e) {
      if (e.name === 'AbortError') return;
      await rememberFile(null);
      toast('Не удалось сохранить. Нажмите ещё раз и выберите файл заново.');
    }
  }

  async function loadProgress() {
    if (!canPickFiles) return $('#import-file').click();
    try {
      if (!fileHandle) await rememberFile((await window.showOpenFilePicker({ types: FILE_TYPES }))[0]);
      if (!(await allowed('read'))) return toast('Нет разрешения на чтение файла');
      applyProgress(await (await fileHandle.getFile()).text());
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (e.name === 'NotFoundError') await rememberFile(null);
      toast(e.name === 'NotFoundError' ? 'Файл не найден. Нажмите ещё раз и выберите его заново.' : 'Не удалось прочитать файл');
    }
  }

  $('#save').addEventListener('click', saveProgress);
  $('#load').addEventListener('click', loadProgress);
  $('#forget-file').addEventListener('click', async () => {
    await rememberFile(null);
    toast('Файл забыт. При следующем сохранении или загрузке выберите новый.');
  });
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      applyProgress(await file.text());
    } catch {
      toast('Не удалось прочитать файл');
    }
    e.target.value = '';
  });
  $('#autosave').checked = state.autosave;
  $('#autosave').addEventListener('change', (e) => {
    state.autosave = e.target.checked;
    save();
    if (state.autosave && !fileHandle) toast('Автосохранение включится после выбора файла: нажмите «Сохранить».');
    autosave();
  });
  $('#autosave-label').hidden = !canPickFiles;
  if (canPickFiles) {
    handleStore('readonly', (s) => s.get('progressFile')).then((h) => { fileHandle = h ?? null; showFileName(); }).catch(() => {});
  }
  showFileName();

  $('#reset').addEventListener('click', () => {
    if (!confirm('Сбросить весь прогресс по квестам?')) return;
    state.status = {};
    render();
    autosave();
  });

  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (byId.has(id)) {
      state.selected = id;
      if (state.trader !== ACTIVE_TAB) state.trader = byId.get(id).trader;
    }
    render();
  }
  window.addEventListener('popstate', fromHash);

  // ---------- init ----------

  const donateUrl = window.TQ_CONFIG?.donateUrl;
  if (donateUrl?.startsWith('https://')) {
    $('#donate').href = donateUrl;
    $('#donate').hidden = false;
  }
  $('#level').value = state.level || '';
  showToggles();
  $('#built').textContent = `Данные от ${new Date(DATA.built).toLocaleDateString('ru-RU')}.`;
  if (state.trader !== ACTIVE_TAB && !DATA.traders.some((t) => t.name === state.trader)) state.trader = DATA.traders[0].name;
  fromHash();
})();
