/* ══════════════════════════════════════════════════════════
   Kasymov ERP — подключение к базе Supabase

   Подключается в kasymov-main.html ПОСЛЕ kasymov-data.js:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="kasymov-data.js"></script>
     <script src="kasymov-supabase.js"></script>

   Разделы трогать не нужно: они как и раньше получают данные
   через K.connect и отдают через K.commit. Меняется только то,
   откуда оболочка берёт состояние и куда его сохраняет.
   ══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Ключи сохраняются при настройке через НАСТРОЙКА.html —
     руками файл править не нужно. */
  /* ▼▼▼ ВПИШИТЕ СЮДА СВОИ КЛЮЧИ ПЕРЕД ВЫКЛАДКОЙ ▼▼▼
     Берутся в Supabase: Settings → API.
     Без них сайт не подключится к базе у сотрудников. */
  let URL = 'https://cuaanednzeznzwigzqpd.supabase.co';
  let KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1YWFuZWRuemV6bnp3aWd6cXBkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MjgzMTEsImV4cCI6MjEwMjIwNDMxMX0.hImRy-9_8Nlp_7N5rKsf_yca39ETWesMiX1dxGajXi0';
  /* ▲▲▲ ────────────────────────────────────── ▲▲▲ */

  /* если ключи не вписаны — пробуем взять из настройки на этом компьютере */
  if(URL.includes('ВАШ-')){
    try{
      const saved = JSON.parse(localStorage.getItem('kasymov-db') || '{}');
      URL = saved.url || ''; KEY = saved.key || '';
    }catch(_){ URL = ''; KEY = ''; }
  }
  if(!URL || !KEY){
    console.warn('База не настроена. Откройте НАСТРОЙКА.html — это делается один раз.');
    return;
  }

  const K = window.KASYMOV;
  if (!K) { console.error('kasymov-data.js должен подключаться первым'); return; }
  if (!window.supabase) { console.error('Не подключена библиотека supabase-js'); return; }

  const db = window.supabase.createClient(URL, KEY);

  /* ── СПРАВОЧНИКИ ИЗ БАЗЫ ──
     Переопределяем файловые константы (счета, категории, роли, сотрудники),
     чтобы админка реально управляла данными. Логины и права ДОБАВЛЯЮТСЯ поверх
     файловых — существующие входы сотрудников не ломаются. */
  let dirsApplied = false;
  async function applyDirectories(){
    try{
      const { data: acc } = await db.from('accounts').select('*').order('id',{ascending:true});
      if(acc && acc.length) K.ACCOUNTS = acc.map(a=>({ id:a.id, name:a.name,
        short:a.short||a.name, start:Number(a.start_balance)||0 }));
    }catch(_){}
    try{
      const { data: cats } = await db.from('categories').select('*').order('sort',{ascending:true});
      if(cats && cats.length) K.CATS = cats.map(c=>c.name);
    }catch(_){}
    try{
      const { data: rs } = await db.from('roles').select('*').order('sort',{ascending:true});
      if(rs && rs.length){ const R={}; rs.forEach(x=>{ R[x.id]={ label:x.name, cls:x.cls||'bl' }; }); K.ROLES=R; }
    }catch(_){}
    try{
      const { data: stf } = await db.from('staff').select('*').order('name',{ascending:true});
      if(stf && stf.length){
        K.STAFF = stf.map(s=>({ id:s.id, name:s.name, role:s.role, branch:s.branch, salary:s.salary||0 }));
        /* логины/пароли из базы поверх файловых.
           ВАЖНО: дополняем ИСХОДНЫЙ объект K.LOGINS на месте (не заменяем новым),
           потому что функция входа из kasymov-data.js держит ссылку именно на него —
           иначе новые логины, добавленные в админке, не проходят вход. */
        if(K.LOGINS){
          stf.forEach(s=>{ const p=(s.data&&s.data.pass); if(s.login && p){ K.LOGINS[s.id]={ login:s.login, pass:p }; } });
        }
      }
    }catch(_){}
    try{
      const { data: ra } = await db.from('role_access').select('*');
      /* права доступа — тоже мутируем исходный объект на месте */
      if(ra && ra.length && K.ACCESS){
        ra.forEach(r=>{ if(Array.isArray(r.sections)) K.ACCESS[r.role]=r.sections; });
      }
    }catch(_){}
    /* Переопределяем K.auth: форма входа вызывает именно K.auth, а исходная
       функция перебирает СВОЙ внутренний объект логинов, куда логины из админки
       (новые сотрудники) не попадают. Наша версия проверяет актуальный K.LOGINS. */
    try{
      if(typeof K.auth === 'function'){
        K.auth = function(login, pass){
          const L = K.LOGINS || {};
          const q = String(login==null?'':login).trim().toLowerCase();
          const p = String(pass==null?'':pass);
          const id = Object.keys(L).find(function(k){
            const e = L[k] || {};
            return String(e.login==null?'':e.login).trim().toLowerCase() === q
                && String(e.pass==null?'':e.pass) === p;
          });
          return id ? ((K.STAFF||[]).find(function(s){ return s.id === id; }) || null) : null;
        };
      }
    }catch(_){}
    dirsApplied = true;
  }
  /* запускаем сразу при загрузке — чтобы логины/права были готовы к моменту входа */
  const dirsPromise = applyDirectories();

  /* какая коллекция в какой таблице лежит и как раскладывается по колонкам */
  const MAP = {
    goods:     { table:'goods',     key:'id',
                 cols:g => ({ id:g.id, name:g.name, sku:g.sku, cat:g.cat, unit:g.unit,
                              cost:g.cost, opt:g.opt, min_qty:g.min }) },
    suppliers: { table:'suppliers', key:'id', cols:s => ({ id:s.id, name:s.name, debt:s.debt }) },
    partners:  { table:'partners',  key:'id',
                 cols:p => ({ id:p.id, name:p.name, type:p.type, city:p.city,
                              phone:p.phone, disc:p.disc }) },
    buyers:    { table:'buyers',    key:'id',
                 cols:b => ({ id:b.id, name:b.name, balance:b.balance, limit_sum:b.limit }) },
    orders:    { table:'orders',    key:'id',
                 cols:o => ({ id:o.id, num:o.num, branch:o.branch, status:o.status,
                              manager:o.manager, measurer:o.measurer, installer:o.installer,
                              client:o.client, phone:o.phone, addr:o.addr, source:o.source,
                              measure_at:o.measureAt || null, deadline:o.deadline || null,
                              due_date:o.dueDate || null, sum:o.sum, final:o.final }) },
    porders:   { table:'porders',   key:'id',
                 cols:o => ({ id:o.id, num:o.num, partner:o.partner, status:o.status,
                              client:o.client, addr:o.addr, order_date:o.date || null,
                              deadline:o.deadline || null, disc:o.disc, retail:o.retail,
                              sum:o.sum, paid:o.paid }) },
    docs:      { table:'docs',      key:'id',
                 cols:d => ({ id:d.id, type:d.type, num:d.num, doc_date:d.date || null,
                              status:d.status, party:d.party, from_loc:d.from, to_loc:d.to,
                              sum:d.sum || 0, paid:d.paid || 0 }) },
    invoices:  { table:'invoices',  key:'id',
                 cols:i => ({ id:i.id, num:i.num, inv_date:i.date || null, order_id:i.order || null,
                              status:i.status, company:i.company, requested_by:i.requestedBy,
                              issued_by:i.issuedBy, sum:K.invSum(i) }) },
    expenses:  { table:'expenses',  key:'id', flat:true,
                 cols:e => ({ id:e.id, exp_date:e.date, cat:e.cat, acc:e.acc, sum:e.sum,
                              who:e.who, party:e.party || null, note:e.note || '' }) },
    transfers: { table:'transfers', key:'id', flat:true,
                 cols:t => ({ id:t.id, tr_date:t.date, from_acc:t.from, to_acc:t.to,
                              sum:t.sum, who:t.who, note:t.note || '' }) },
    bonuses:   { table:'bonuses',   key:'id', flat:true,
                 cols:b => ({ id:b.id, b_date:b.date, staff_id:b.who, sum:b.sum, reason:b.reason || '' }) },
    fines:     { table:'fines',     key:'id', flat:true,
                 cols:f => ({ id:f.id, f_date:f.date, staff_id:f.who, sum:f.sum, reason:f.reason || '' }) },
    payouts:   { table:'payouts',   key:'id', flat:true,
                 cols:p => ({ id:p.id, p_date:p.date, staff_id:p.who, sum:p.sum,
                              period:p.period || '', note:p.note || '' }) },
  };

  /* строка из базы → объект, каким его ждут разделы */
  /* Номер строки хранится отдельной колонкой. Если внутри data его нет —
     подставляем из колонки, иначе запись вернётся в базу без номера. */
  const unpack = (row, flat) => {
    if(flat) return fromFlat(row);
    const o = Object.assign({}, row.data || {});
    if(o.id === undefined || o.id === null) o.id = row.id;
    return o;
  };
  function fromFlat(r){
    const o = Object.assign({}, r);
    if(o.exp_date){ o.date = o.exp_date; delete o.exp_date; }
    if(o.tr_date){ o.date = o.tr_date; delete o.tr_date; }
    if(o.b_date){ o.date = o.b_date; delete o.b_date; }
    if(o.f_date){ o.date = o.f_date; delete o.f_date; }
    if(o.p_date){ o.date = o.p_date; delete o.p_date; }
    if(o.from_acc){ o.from = o.from_acc; delete o.from_acc; }
    if(o.to_acc){ o.to = o.to_acc; delete o.to_acc; }
    if(o.staff_id){ o.who = o.staff_id; delete o.staff_id; }
    return o;
  }

  /* ── ЗАГРУЗКА ── */
  async function load(){
    const state = {};
    for(const [name, m] of Object.entries(MAP)){
      const { data, error } = await db.from(m.table).select('*');
      if(error){ console.error('Не удалось прочитать', m.table, error.message); throw error; }
      state[name] = (data || []).map(r => unpack(r, m.flat));
    }
    const { data: st } = await db.from('settings').select('*');
    (st || []).forEach(row => { state[row.key] = row.value; });
    return state;
  }

  /* ── СОХРАНЕНИЕ ──
     Пишем только то, что изменилось с прошлого раза. */
  let snapshot = {};
  const hash = v => JSON.stringify(v);

  /* показываем результат сохранения прямо на экране */
  function note(text, bad){
    let el = document.getElementById('db-note');
    if(!el){
      el = document.createElement('div');
      el.id = 'db-note';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:420px;'
        + 'padding:11px 15px;border-radius:10px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'
        + "'Segoe UI',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.22);transition:opacity .3s";
      document.body.appendChild(el);
    }
    el.style.background = bad ? '#7d211c' : '#1f4d17';
    el.style.color = '#fff';
    el.innerHTML = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    if(!bad) el._t = setTimeout(() => { el.style.opacity = '0'; }, 2500);
  }

  /* Чиним записи с испорченным номером — такие мог создать старый файл.
     -Infinity, NaN и пустые id база не принимает. */
  function repair(state){
    let fixed = 0;
    for(const [name, m] of Object.entries(MAP)){
      const rows = state[name];
      if(!Array.isArray(rows)) continue;
      const good = rows.map(r => +r[m.key]).filter(Number.isFinite);
      let next = (good.length ? Math.max(...good) : 0) + 1;
      rows.forEach(r => {
        const v = r[m.key];
        const broken = v === undefined || v === null || v === '' ||
                       (typeof v === 'number' && !Number.isFinite(v)) ||
                       String(v) === 'Infinity' || String(v) === '-Infinity' || String(v) === 'NaN';
        if(!broken) return;
        r[m.key] = next;
        if('num' in r) r.num = String(next);
        next++; fixed++;
      });
    }
    if(fixed) note('Исправлено записей без номера: ' + fixed
      + '<div style="font-size:11px;opacity:.8;margin-top:4px">их создала прежняя версия</div>');
    return fixed;
  }

  let saving = false, again = false;
  async function save(state){
    repair(state);
    /* пока идёт запись, следующий вызов ставим в очередь —
       иначе одна и та же строка уходит дважды и база ругается */
    if(saving){ again = true; return; }
    saving = true;
    try{
      let total = 0;
      for(const [name, m] of Object.entries(MAP)){
        const rows = state[name] || [];
        /* отсеиваем повторы по ключу: база не обновляет строку дважды за запрос */
        const seen = new Set();
        const changed = rows.filter(r => {
          const id = r[m.key];
          /* запись без номера база не примет — пропускаем и сообщаем */
          if(id === undefined || id === null || id === '' || (typeof id === 'number' && !Number.isFinite(id))){
            console.warn('Пропущена запись без номера в', name, r);
            return false;
          }
          const k = String(id);
          if(seen.has(k)) return false;
          seen.add(k);
          return hash(r) !== snapshot[name + ':' + k];
        });
        if(!changed.length) continue;
        const payload = changed.map(r => m.flat
          ? m.cols(r)
          /* кладём номер и внутрь data — тогда чтение вернёт полную запись */
          : Object.assign(m.cols(r), { data:Object.assign({}, r, { id:r[m.key] }) }));
        for(let i = 0; i < payload.length; i += 200){
          const { error } = await db.from(m.table).upsert(payload.slice(i, i + 200));
          if(error){
            note('<b>Не сохранилось:</b> ' + m.table + '<br>' + error.message
                 + '<div style="font-size:11px;opacity:.8;margin-top:4px">покажите это сообщение разработчику</div>', true);
            throw error;
          }
        }
        changed.forEach(r => snapshot[name + ':' + String(r[m.key])] = hash(r));
        total += changed.length;
      }
      if(state.finance) await db.from('settings').upsert({ key:'finance', value:state.finance });
      if(total) note('Сохранено в базу: ' + total + (total === 1 ? ' запись' : ' записей'));
    }catch(e){
      console.error('Ошибка сохранения:', e.message || e);
    }finally{
      saving = false;
      if(again){ again = false; save(state); }
    }
  }

  function remember(state){
    snapshot = {};
    for(const [name, m] of Object.entries(MAP))
      (state[name] || []).forEach(r => snapshot[name + ':' + String(r[m.key])] = hash(r));
  }

  /* ── ЗАЛИВКА ДЕМО-ДАННЫХ ──
     Один раз, чтобы не заводить справочники руками.
     В консоли браузера: KasymovDB.seed() */
  async function seed(){
    const s = K.clone(K.seed);
    await db.from('accounts').upsert(K.ACCOUNTS.map(a =>
      ({ id:a.id, name:a.name, start_balance:a.start })));
    await db.from('branches').upsert(K.BRANCHES.map(b => ({ id:b.id, name:b.name })));
    await db.from('staff').upsert(K.STAFF.map(p =>
      ({ id:p.id, name:p.name, role:p.role, branch:p.branch, salary:p.salary || 0,
         login:(K.LOGINS[p.id] || {}).login || null })));
    snapshot = {};
    await save(s);
    await db.from('settings').upsert([
      { key:'price',  value:K.PRICE },
      { key:'pay',    value:K.PAY },
      { key:'company',value:K.COMPANY },
    ]);
    console.log('Демо-данные залиты в базу');
  }

  /* ── публичный интерфейс для оболочки ── */
  window.KasymovDB = {
    ready: false,
    async init(){
      const state = await load();
      /* Справочники есть — значит база настроена, просто операций пока нет.
         Так бывает после очистки: это нормальное начало работы. */
      const setUp = (state.goods && state.goods.length) || (state.partners && state.partners.length);
      if(!setUp){
        this.ready = false;
        note('<b>База не настроена.</b> Откройте setup.html и пройдите настройку.'
           + '<div style="font-size:11px;opacity:.8;margin-top:4px">'
           + 'пока работаем на демонстрационных данных, они не сохраняются</div>', true);
        return null;
      }
      remember(state);
      await dirsPromise;   /* справочники/логины/права из базы применены */
      this.ready = true;
      const n = (state.orders || []).length;
      note(n ? 'Подключено к базе: ' + n + ' заказов'
             : 'Подключено к базе. Заказов пока нет — можно начинать.');
      return state;
    },
    save(state){ return save(state); },
    seed,
    client: db,
  };
})();
