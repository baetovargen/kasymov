/* ══════════════════════════════════════════════════════════
   Kasymov ERP — единый источник данных
   Подключается всеми модулями: <script src="kasymov-data.js"></script>

   Бизнес: производство жалюзи и рулонных штор под заказ.
   Три канала продаж:
     retail    — розница, заказ клиента, материалы списываются в производство
     partner   — дилеры принимают заказы у своих клиентов, мы шьём под них,
                 расчёты ведутся по дебету/кредиту (партнёр может быть должен нам
                 или мы ему — сальдо накапливается)
     wholesale — оптовая продажа материалов (ткань, профиль, механизмы) как товара

   Склады: Тунгуч, Көк-Жар, Цех. Цех — это тоже место хранения:
   материал сначала перемещается туда, и только потом списывается в изделие.
   ══════════════════════════════════════════════════════════ */

window.KASYMOV = (function () {

  /* ── склады ───────────────────────────────────── */
  const LOC = [
    { id:'tunguch', name:'Склад Тунгуч', short:'Тунгуч' },
    { id:'kokjar',  name:'Склад Көк-Жар', short:'Көк-Жар' },
    { id:'ceh',     name:'Цех',           short:'Цех' },
  ];
  const LOC_IDS = LOC.map(l => l.id);

  /* ── справочники ──────────────────────────────── */
  const CATS = ['Ткань', 'Профиль', 'Механизм', 'Комплектующие', 'Расходники'];

  const UNITS = ['м²', 'п.м', 'шт', 'компл', 'м'];

  /* ── роли и права ────────────────────────────────
     Каждая роль двигает только свой участок воронки. */
  const ROLES = {
    manager:   { label:'Менеджер',            cls:'bl' },
    measurer:  { label:'Замерщик',            cls:'vl' },
    shop:      { label:'Цех',                 cls:'am' },
    senior:    { label:'Старший установщик',  cls:'gn' },
    packer:    { label:'Упаковщик',           cls:'am' },
    installer: { label:'Установщик',          cls:'gn' },
    accountant:{ label:'Бухгалтер',           cls:'vl' },
    director:  { label:'Директор',            cls:'gy' },
  };

  /* статусы заказа. can — какие роли могут перевести заказ В этот статус */
  const STATUS = {
    new:       { label:'Новый замер',            cls:'bl', order:0,  can:['manager','director'] },
    assigned:  { label:'Замер распределён',      cls:'bl', order:1,  can:['manager','director'] },
    measured:  { label:'Замер сделан',           cls:'vl', order:2,  can:['measurer','director'] },
    ordered:   { label:'Заказан',                cls:'gn', order:3,  can:['measurer','manager','director'] },
    thinking:  { label:'Думает',                 cls:'am', order:3,  can:['measurer','manager','director'] },
    rejected:  { label:'Отказ',                  cls:'rd', order:3,  can:['measurer','manager','director'] },
    toShop:    { label:'Заказ отправлен в цех',  cls:'am', order:4,  can:['manager','measurer','director'] },
    ready:     { label:'Готов в цеху',           cls:'gn', order:5,  can:['shop','director'] },
    toSenior:  { label:'Передан старшему установщику', cls:'vl', order:6, can:['senior','shop','director'] },
    toInstall: { label:'Отправлен на установку', cls:'bl', order:7,  can:['senior','director'] },
    installed: { label:'Установлен',             cls:'gn', order:8,  can:['installer','senior','director'] },
    done:      { label:'Выполнен',               cls:'gy', order:9,  can:['installer','senior','director','accountant'] },
    /* legacy: старый статус «Полностью оплачен» — оставлен, чтобы старые заказы не ломались */
    paid:      { label:'Выполнен',               cls:'gy', order:9,  can:[] },
  };
  const FLOW = ['new','assigned','measured','ordered','thinking','rejected',
                'toShop','ready','toSenior','toInstall','installed','done'];
  /* куда можно перейти из текущего статуса */
  const NEXT = {
    new:['assigned'], assigned:['measured','rejected'],
    measured:['ordered','thinking','rejected'],
    thinking:['ordered','rejected'], ordered:['toShop'], rejected:[],
    toShop:['ready'], ready:['toSenior'], toSenior:['toInstall'],
    toInstall:['installed'], installed:['done'], done:[], paid:[],
  };

  const CHANNEL = {
    retail:    { label:'Розница',  cls:'bl' },
    partner:   { label:'Партнёр',  cls:'vl' },
    wholesale: { label:'Опт',      cls:'am' },
  };

  /* ── пять отметок на каждое изделие ──
     Рабочий ставит галочку в своей колонке. rate — сколько
     начисляется за одно изделие. ЦИФРЫ ОРИЕНТИРОВОЧНЫЕ. */
  const OPS = [
    { key:'fabric',  label:'Ткань',          short:'Ткань',    rate:25 },
    { key:'tape',    label:'Лента + кнопка',  short:'Лента',    rate:20 },
    { key:'profile', label:'Профиль',         short:'Профиль',  rate:20 },
    { key:'cord',    label:'Нитка',           short:'Нитка',    rate:20 },
    { key:'pack',    label:'Упаковка',        short:'Упаковка', rate:30 },
  ];

  /* ── ПРАЙС: цена за м² по типу изделия ──
     Взято из вашего заказа №357: 9 600 сом за 2,97 м² плиссе ≈ 3 240 за м².
     Остальные цифры прикидочные — замените на свои. */
  const PRICE = {
    perM2: { 'Рулонная':3200, 'Плиссе':3240, 'День-ночь':4200, 'Вертикальная':2600 },
    minArea: 1,                      /* меньше метра считаем как один квадратный метр */
    extras:  { 'Электропривод':9900, 'Пульт ДУ':1950, 'Монтаж на стену':0 },
    install: 0,                      /* выезд в цену не входит; поставьте сумму, если берёте */
  };

  /* расчёт цены одного изделия */
  function priceItem(it){
    const rate = PRICE.perM2[it.type] || PRICE.perM2['Рулонная'];
    const area = Math.max(PRICE.minArea, it.w * it.h);
    return Math.round(area * rate * it.qty);
  }
  /* расчёт всего заказа: изделия + доплаты + выезд */
  function priceOrder(o){
    const items = (o.items || []).map(it => ({ it, sum:priceItem(it) }));
    const goods = items.reduce((a,x) => a + x.sum, 0);
    const extras = (o.extras || []).reduce((a,e) => a + (PRICE.extras[e] || 0), 0);
    const install = (o.items || []).length ? PRICE.install : 0;
    return { items, goods, extras, install, total:goods + extras + install };
  }

  /* ── сдельная оплата вне цеха ── */
  const PAY = {
    /* замерщик: 100 за выезд + ставка за м², которая зависит от скидки по заказу */
    measurer:  { trip:100, m2byDisc:{ d0:200, d10:150, d15:120, d20:100 } },
    /* менеджер: оклад 10 000 + 4% от суммы; бонус начисляется отдельно вручную */
    manager:   { salary:10000, pct:4 },
    installer: { piece:150, trip:300 },/* 150 сом за изделие + 300 сом за адрес */
  };
  /* ставка замерщика за м² в зависимости от % скидки по заказу */
  function measurerRate(disc){
    const t = (PAY.measurer && PAY.measurer.m2byDisc) || {};
    if(disc <= 0)  return t.d0  != null ? t.d0  : 200;
    if(disc <= 10) return t.d10 != null ? t.d10 : 150;
    if(disc <= 15) return t.d15 != null ? t.d15 : 120;
    return t.d20 != null ? t.d20 : 100;   /* 15–20% и выше */
  }
  /* сколько сотрудники заработали именно с этого заказа (для карточки) */
  function orderEarnings(o){
    const area  = (o.items || []).reduce((x,i) => x + i.w * i.h * i.qty, 0);
    const pcs   = (o.items || []).reduce((x,i) => x + i.qty, 0);
    const total = orderTotal(o), disc = orderDisc(o);
    return {
      manager:   o.manager   ? Math.round(total * PAY.manager.pct / 100) : 0,
      measurer:  o.measurer  ? Math.round(PAY.measurer.trip + area * measurerRate(disc)) : 0,
      installer: o.installer ? (pcs * PAY.installer.piece + PAY.installer.trip) : 0,
      rate: measurerRate(disc), disc, area,
    };
  }

  const STAFF = [
    { id:'u1',  name:'Тилек кызы Адеми',   role:'manager',   branch:'bishkek', salary:15000 },
    { id:'u2',  name:'Усенбаева Арзыкан',  role:'manager',   branch:'bishkek', salary:15000 },
    { id:'u15', name:'Асанова Айпери',     role:'manager',   branch:'osh' },
    { id:'u3',  name:'Сабайалиев Аслан',   role:'measurer',  branch:'bishkek' },
    { id:'u4',  name:'Максутов Жанарбек',  role:'measurer',  branch:'bishkek' },
    { id:'u5',  name:'Закиров Баяман',     role:'measurer',  branch:'bishkek' },
    { id:'u6',  name:'Халбеков Баяман',    role:'measurer',  branch:'bishkek' },
    { id:'u7',  name:'Мирланов Мирдан',    role:'measurer',  branch:'osh' },
    { id:'u16', name:'Абдиев Тилек',       role:'measurer',  branch:'karakol' },
    { id:'u17', name:'Осмонов Бекзат',     role:'measurer',  branch:'manas' },
    { id:'u8',  name:'Давлес Баетов',      role:'shop',      branch:'bishkek' },
    { id:'u9',  name:'Дамира Осмонова',    role:'shop',      branch:'bishkek' },
    { id:'u19', name:'Айбек Сыдыков',      role:'shop',      branch:'bishkek' },
    { id:'u20', name:'Нургуль Абдиева',    role:'shop',      branch:'bishkek' },
    { id:'u21', name:'Тимур Жээнбеков',    role:'shop',      branch:'bishkek' },
    { id:'u22', name:'Эрмек Осмоналиев',   role:'packer',    branch:'bishkek' },
    { id:'u10', name:'Талгатов Ислам',     role:'senior',    branch:'bishkek', salary:20000 },
    { id:'u11', name:'Нуркалый Асанов',    role:'installer', branch:'bishkek' },
    { id:'u12', name:'Бека Турдубеков',    role:'installer', branch:'bishkek' },
    { id:'u13', name:'Элдияр Сатыбалдиев', role:'installer', branch:'osh' },
    { id:'u18', name:'Виктор Ким',         role:'accountant',branch:'bishkek', salary:30000 },
    { id:'u14', name:'Арген Баетов',       role:'director',  branch:'bishkek' },
  ];
  /* сотрудники роли; если передан филиал — только его люди */
  /* логин и пароль для входа. В демо пароли простые —
     на боевом сервере хранятся хэшами, а не текстом. */
  const LOGINS = {
    u14:{ login:'director', pass:'jcaeaq4y' },
    u1:{ login:'tilek', pass:'x3c2y3vq' },
    u2:{ login:'arzykan', pass:'k3b8y3s2' },
    u3:{ login:'aslan', pass:'9fws5889' },
    u5:{ login:'bayaman', pass:'2yxwktqh' },
    u8:{ login:'davles', pass:'59jcg5sj' },
    u22:{ login:'ermek', pass:'sz2hf9vx' },
    u10:{ login:'islam', pass:'w7smmjt8' },
    u12:{ login:'beka', pass:'cyfmz4tb' },
    u18:{ login:'viktor', pass:'c3rrvuvv' },
  };
  function auth(login, pass){
    const id = Object.keys(LOGINS).find(k =>
      LOGINS[k].login === String(login).trim().toLowerCase() && LOGINS[k].pass === String(pass));
    return id ? STAFF.find(s => s.id === id) : null;
  }
  /* какие разделы видит роль */
  const ACCESS = {
    director:  ['dashboard','orders','production','warehouse','wholesale','invoices','finance','reports','partners'],
    manager:   ['dashboard','orders','warehouse','invoices','partners'],
    measurer:  ['orders','warehouse'],
    shop:      ['production','warehouse'],
    packer:    ['production'],
    senior:    ['orders','production'],
    installer: ['orders'],
    accountant:['dashboard','orders','invoices','finance','reports','wholesale','partners'],
  };

  const byRole = (r, br) => STAFF.filter(s => s.role === r && (!br || s.branch === br));
  const staffRole = id => (STAFF.find(s => s.id === id) || {}).role || '';
  const staffName = id => (STAFF.find(s => s.id === id) || {}).name || '—';

  const USERS = ['Арген Баетов', 'Дамира', 'Камила', 'Давлес'];

  /* ── филиалы (франшиза). Менеджер указывает филиал,
     и заказ уходит в работу именно этому филиалу. ── */
  const BRANCHES = [
    { id:'bishkek', name:'Kasymov Бишкек'  },
    { id:'osh',     name:'Kasymov Ош'      },
    { id:'manas',   name:'Kasymov Манас'   },
    { id:'karakol', name:'Kasymov Каракол' },
  ];

  /* ── районы Бишкека: схема для карты замеров (x,y — 0..100) ── */
  const DISTRICTS = [
    { id:'archa',  name:'Арча-Бешик',  x:26, y:13 },
    { id:'karazh', name:'Кара-Жыгач',  x:38, y:19 },
    { id:'novopok',name:'Новопокровка',x:74, y:14 },
    { id:'akorgo', name:'Ак-Орго',     x:16, y:28 },
    { id:'tunguch',name:'Тунгуч',      x:50, y:29 },
    { id:'alamedin',name:'Аламедин-1', x:68, y:35 },
    { id:'vostok', name:'Восток-5',    x:80, y:44 },
    { id:'center', name:'Центр',       x:50, y:49 },
    { id:'mkr7',   name:'7 мкр',       x:32, y:57 },
    { id:'mkr12',  name:'12 мкр',      x:72, y:60 },
    { id:'jal',    name:'Джал',        x:26, y:72 },
    { id:'asanbay',name:'Асанбай',     x:52, y:73 },
    { id:'kokjar', name:'Кок-Жар',     x:66, y:82 },
  ];

  /* ── поставщики ───────────────────────────────── */
  const suppliers = [
    { id:'sup1', name:'Курулуш',        cats:'Профиль, комплектующие', cur:'KGS', phone:'+996 555 80 41 26', debt:128500 },
    { id:'sup2', name:'Турция',         cats:'Ткань, механизмы',       cur:'USD', phone:'+90 212 660 14 07',  debt:0 },
    { id:'sup3', name:'Текстиль Групп', cats:'Ткань рулонная',         cur:'KGS', phone:'+996 312 54 20 11', debt:0 },
  ];

  /* ── партнёры-дилеры (второй канал) ───────────── */
  /* balance > 0 — партнёр должен нам, < 0 — мы должны партнёру */
  /* ── ПАРТНЁРЫ ──────────────────────────────────
     franchise — франчайзи: работают под нашим брендом,
       продают своим клиентам по своей цене, а нам платят
       оптовую. Их розничный оборот мы только видим.
     b2b — оптовые клиенты: заказывают у нас готовую
       продукцию под себя, платят оптовую цену.
     disc — скидка от нашей розницы, по ней считается
       сумма, которую партнёр платит нам. */
  const partners = [
    { id:'p1', name:'ОсОО «Комфорт Окна»', type:'franchise', city:'Бишкек',
      phone:'+996 700 44 12 08', person:'Комфортов А. Т.', disc:25, since:'2025-03-11' },
    { id:'p2', name:'ИП Асанов М.',        type:'franchise', city:'Ош',
      phone:'+996 555 91 33 40', person:'Асанов Мирлан',    disc:22, since:'2025-08-02' },
    { id:'p3', name:'«Жалюзи Плюс»',       type:'franchise', city:'Каракол',
      phone:'+996 770 15 62 21', person:'Бекова Айнура',    disc:20, since:'2026-01-20' },
    { id:'p4', name:'ОсОО «Окна Мечты»',   type:'b2b',       city:'Бишкек',
      phone:'+996 312 66 71 03', person:'Джумабаев Т.',     disc:18, since:'2025-11-05' },
    { id:'p5', name:'СК «Ак-Ордо Строй»',  type:'b2b',       city:'Бишкек',
      phone:'+996 555 30 18 44', person:'Сыдыков Э. К.',    disc:15, since:'2026-02-14' },
    { id:'p6', name:'ОсОО «Интерьер Юг»',  type:'b2b',       city:'Ош',
      phone:'+996 779 22 90 17', person:'Турсунова Г.',     disc:16, since:'2026-04-03' },
  ];

  /* ── ЗАКАЗЫ ПАРТНЁРОВ ──────────────────────────
     retail — сколько партнёр взял со своего клиента (его оборот,
              заполняется только у франчайзи и нас не касается);
     sum    — сколько партнёр должен заплатить нам;
     paid   — сколько уже оплатил. */
  const porders = [
    { id:'po1', num:'P-0001', partner:'p2', date:'2026-05-14', deadline:'2026-05-27',
      client:'Абдиев Т.', addr:'ул. Ленина 44', status:'new', disc:22,
      items:[{ w:1.53, h:1.62, qty:5, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе' }],
      retail:40200, sum:31400, paid:9400,
      comment:'', history:[{ at:'2026-05-14 09:00', who:'p2', what:'Заказ принят от партнёра' }] },
    { id:'po2', num:'P-0002', partner:'p3', date:'2026-05-19', deadline:'2026-05-31',
      client:'Гостиница «Ала-Тоо»', addr:'ул. Байтик Баатыра 78', status:'done', disc:20,
      items:[{ w:1.23, h:2.15, qty:3, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная' }],
      retail:25400, sum:20300, paid:20300,
      comment:'', history:[{ at:'2026-05-19 09:00', who:'p3', what:'Заказ принят от партнёра' }] },
    { id:'po3', num:'P-0003', partner:'p4', date:'2026-05-02', deadline:'2026-05-14',
      client:'Кофейня «Барака»', addr:'мкр Ак-Тилек 12', status:'done', disc:18,
      items:[{ w:1.55, h:1.52, qty:4, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Вертикальная' }],
      retail:0, sum:20100, paid:20100,
      comment:'', history:[{ at:'2026-05-02 09:00', who:'p4', what:'Заказ принят от партнёра' }] },
    { id:'po4', num:'P-0004', partner:'p1', date:'2026-05-15', deadline:'2026-05-24',
      client:'Кофейня «Барака»', addr:'пр. Масалиева 91', status:'done', disc:25,
      items:[{ w:1.76, h:1.8, qty:3, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Вертикальная' }],
      retail:24700, sum:18500, paid:5600,
      comment:'', history:[{ at:'2026-05-15 09:00', who:'p1', what:'Заказ принят от партнёра' }] },
    { id:'po5', num:'P-0005', partner:'p2', date:'2026-06-22', deadline:'2026-06-30',
      client:'Салон «Айым»', addr:'мкр Восток-5 3', status:'done', disc:22,
      items:[{ w:1.6, h:1.96, qty:5, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная' }],
      retail:50200, sum:39200, paid:39200,
      comment:'', history:[{ at:'2026-06-22 09:00', who:'p2', what:'Заказ принят от партнёра' }] },
    { id:'po6', num:'P-0006', partner:'p4', date:'2026-06-10', deadline:'2026-06-22',
      client:'Салон «Айым»', addr:'ул. Тоголок Молдо 60', status:'ready', disc:18,
      items:[{ w:1.55, h:1.72, qty:5, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная' }],
      retail:0, sum:35000, paid:10500,
      comment:'', history:[{ at:'2026-06-10 09:00', who:'p4', what:'Заказ принят от партнёра' }] },
    { id:'po7', num:'P-0007', partner:'p1', date:'2026-06-16', deadline:'2026-06-24',
      client:'Салон «Айым»', addr:'ул. Курманжан Датка 8', status:'new', disc:25,
      items:[{ w:1.64, h:1.92, qty:6, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Вертикальная' }],
      retail:49100, sum:36800, paid:11000,
      comment:'', history:[{ at:'2026-06-16 09:00', who:'p1', what:'Заказ принят от партнёра' }] },
    { id:'po8', num:'P-0008', partner:'p6', date:'2026-06-12', deadline:'2026-06-24',
      client:'Салон «Айым»', addr:'ул. Абдрахманова 150', status:'done', disc:16,
      items:[{ w:1.79, h:2.33, qty:3, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе' }],
      retail:0, sum:34000, paid:34000,
      comment:'', history:[{ at:'2026-06-12 09:00', who:'p6', what:'Заказ принят от партнёра' }] },
    { id:'po9', num:'P-0009', partner:'p3', date:'2026-06-06', deadline:'2026-06-13',
      client:'Мамытов К.', addr:'ул. Тоголок Молдо 60', status:'done', disc:20,
      items:[{ w:1.91, h:2.36, qty:5, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Вертикальная' }],
      retail:58600, sum:46900, paid:0,
      comment:'', history:[{ at:'2026-06-06 09:00', who:'p3', what:'Заказ принят от партнёра' }] },
    { id:'po10', num:'P-0010', partner:'p5', date:'2026-07-13', deadline:'2026-07-23',
      client:'Абдиев Т.', addr:'ул. Гагарина 27', status:'ready', disc:15,
      items:[{ w:1.25, h:1.47, qty:5, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь' }],
      retail:0, sum:32800, paid:16400,
      comment:'', history:[{ at:'2026-07-13 09:00', who:'p5', what:'Заказ принят от партнёра' }] },
    { id:'po11', num:'P-0011', partner:'p6', date:'2026-07-10', deadline:'2026-07-17',
      client:'Ниязова А.', addr:'ул. Ленина 44', status:'done', disc:16,
      items:[{ w:1.32, h:1.79, qty:4, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная' }],
      retail:0, sum:25400, paid:0,
      comment:'', history:[{ at:'2026-07-10 09:00', who:'p6', what:'Заказ принят от партнёра' }] },
    { id:'po12', num:'P-0012', partner:'p3', date:'2026-07-05', deadline:'2026-07-19',
      client:'Гостиница «Ала-Тоо»', addr:'ул. Тоголок Молдо 60', status:'done', disc:20,
      items:[{ w:1.96, h:2.3, qty:4, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная' }],
      retail:57700, sum:46200, paid:0,
      comment:'', history:[{ at:'2026-07-05 09:00', who:'p3', what:'Заказ принят от партнёра' }] },
    { id:'po13', num:'P-0013', partner:'p5', date:'2026-07-16', deadline:'2026-07-27',
      client:'Абдиев Т.', addr:'ул. Гагарина 27', status:'ready', disc:15,
      items:[{ w:1.58, h:1.68, qty:2, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь' }],
      retail:0, sum:19000, paid:0,
      comment:'', history:[{ at:'2026-07-16 09:00', who:'p5', what:'Заказ принят от партнёра' }] },
    { id:'po14', num:'P-0014', partner:'p5', date:'2026-07-11', deadline:'2026-07-21',
      client:'Гостиница «Ала-Тоо»', addr:'мкр Ак-Тилек 12', status:'done', disc:15,
      items:[{ w:1.48, h:2.08, qty:3, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Вертикальная' }],
      retail:0, sum:20400, paid:20400,
      comment:'', history:[{ at:'2026-07-11 09:00', who:'p5', what:'Заказ принят от партнёра' }] },
    { id:'po15', num:'P-0015', partner:'p2', date:'2026-07-01', deadline:'2026-07-15',
      client:'Мамытов К.', addr:'ул. Абдрахманова 150', status:'done', disc:22,
      items:[{ w:1.16, h:1.52, qty:4, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь' }],
      retail:29600, sum:23100, paid:23100,
      comment:'', history:[{ at:'2026-07-01 09:00', who:'p2', what:'Заказ принят от партнёра' }] },
    { id:'po16', num:'P-0016', partner:'p4', date:'2026-08-08', deadline:'2026-08-17',
      client:'Школа №27', addr:'ул. Ленина 44', status:'done', disc:18,
      items:[{ w:1.27, h:1.78, qty:6, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь' }],
      retail:0, sum:46700, paid:46700,
      comment:'', history:[{ at:'2026-08-08 09:00', who:'p4', what:'Заказ принят от партнёра' }] },
    { id:'po17', num:'P-0017', partner:'p1', date:'2026-08-13', deadline:'2026-08-27',
      client:'Турдубеков Э.', addr:'мкр Юг-2 15', status:'toShop', disc:25,
      items:[{ w:1.46, h:1.97, qty:3, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная' }],
      retail:27600, sum:20700, paid:0,
      comment:'', history:[{ at:'2026-08-13 09:00', who:'p1', what:'Заказ принят от партнёра' }] },
    { id:'po18', num:'P-0018', partner:'p6', date:'2026-08-02', deadline:'2026-08-12',
      client:'Ниязова А.', addr:'ул. Байтик Баатыра 78', status:'new', disc:16,
      items:[{ w:1.24, h:2.13, qty:4, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная' }],
      retail:0, sum:28400, paid:0,
      comment:'', history:[{ at:'2026-08-02 09:00', who:'p6', what:'Заказ принят от партнёра' }] },
    { id:'po19', num:'P-0019', partner:'p1', date:'2026-08-18', deadline:'2026-08-25',
      client:'Кофейня «Барака»', addr:'ул. Байтик Баатыра 78', status:'toShop', disc:25,
      items:[{ w:1.64, h:1.72, qty:6, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Вертикальная' }],
      retail:44000, sum:33000, paid:9900,
      comment:'', history:[{ at:'2026-08-18 09:00', who:'p1', what:'Заказ принят от партнёра' }] },
    { id:'po20', num:'P-0020', partner:'p3', date:'2026-08-07', deadline:'2026-08-19',
      client:'Ниязова А.', addr:'мкр Восток-5 3', status:'toShop', disc:20,
      items:[{ w:1.39, h:2.39, qty:2, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная' }],
      retail:21300, sum:17000, paid:0,
      comment:'', history:[{ at:'2026-08-07 09:00', who:'p3', what:'Заказ принят от партнёра' }] },
  ];

  /* ── оптовые покупатели (третий канал) ────────── */
  /* balance — сколько покупатель нам должен, limit — потолок отгрузки в долг */
  const buyers = [
    { id:'b1', name:'ОсОО «Интерьер Строй»', city:'Бишкек',  phone:'+996 312 90 11 45', discount:12, limit:200000, balance:0 },
    { id:'b2', name:'ИП Турсунов А.',        city:'Каракол', phone:'+996 502 77 18 03', discount:8,  limit:50000,  balance:34500 },
    { id:'b3', name:'ОсОО «Дом Декор»',      city:'Бишкек',  phone:'+996 555 62 30 91', discount:15, limit:100000, balance:78200 },
  ];

  /* ── номенклатура ─────────────────────────────── */
  /* q — остаток по складам, min — точка заказа, cost — средневзвешенная
     себестоимость, opt — оптовая цена, tone — цвет для плашки товара      */
  const goods = [
    { id:'g01', sku:'PR-100', name:'Профиль белый',        cat:'Профиль',      unit:'п.м', q:{tunguch:5880, kokjar:0,   ceh:200}, min:800, cost:78,  opt:110, tone:'#f2f4f8' },
    { id:'g02', sku:'PR-101', name:'Профиль антрацит',     cat:'Профиль',      unit:'п.м', q:{tunguch:960,  kokjar:0,   ceh:0},   min:400, cost:78,  opt:110, tone:'#3a4048' },
    { id:'g03', sku:'PR-102', name:'Профиль коричневый',   cat:'Профиль',      unit:'п.м', q:{tunguch:240,  kokjar:0,   ceh:0},   min:300, cost:78,  opt:110, tone:'#6b4a32' },
    { id:'g04', sku:'TK-200', name:'Silver Series ara gri',cat:'Ткань',        unit:'м²',  q:{tunguch:496,  kokjar:0,   ceh:0},   min:120, cost:215, opt:290, tone:'#9aa0a8' },
    { id:'g05', sku:'TK-201', name:'Silver series Krem',   cat:'Ткань',        unit:'м²',  q:{tunguch:467,  kokjar:0,   ceh:0},   min:120, cost:215, opt:290, tone:'#e8dcc4' },
    { id:'g06', sku:'TK-202', name:'Blackout antrasit',    cat:'Ткань',        unit:'м²',  q:{tunguch:399,  kokjar:0,   ceh:0},   min:100, cost:549, opt:720, tone:'#40454c' },
    { id:'g07', sku:'TK-203', name:'Blackout kahve',       cat:'Ткань',        unit:'м²',  q:{tunguch:61,   kokjar:0,   ceh:39},  min:100, cost:549, opt:720, tone:'#5c4433' },
    { id:'g08', sku:'TK-204', name:'Diamond Series Beyaz', cat:'Ткань',        unit:'м²',  q:{tunguch:40,   kokjar:0,   ceh:60},  min:80,  cost:128, opt:185, tone:'#f7f5f0' },
    { id:'g09', sku:'KM-300', name:'Комплектующий белый',  cat:'Комплектующие',unit:'компл',q:{tunguch:1000,kokjar:0,   ceh:0},   min:200, cost:5,   opt:9,   tone:'#f2f4f8' },
    { id:'g10', sku:'KM-301', name:'Заглушка белый',       cat:'Комплектующие',unit:'шт',  q:{tunguch:1000, kokjar:0,   ceh:0},   min:300, cost:3,   opt:6,   tone:'#f2f4f8' },
    { id:'g11', sku:'KM-302', name:'Кнопка',               cat:'Комплектующие',unit:'шт',  q:{tunguch:5000, kokjar:0,   ceh:0},   min:500, cost:1,   opt:3,   tone:'#dfe4ec' },
    { id:'g16', sku:'KM-303', name:'Комплектующий антрацит',  cat:'Комплектующие',unit:'компл',q:{tunguch:400, kokjar:0,   ceh:0},   min:150, cost:5,   opt:9,   tone:'#3a4048' },
    { id:'g17', sku:'KM-304', name:'Комплектующий коричневый',cat:'Комплектующие',unit:'компл',q:{tunguch:200, kokjar:0,   ceh:0},   min:100, cost:5,   opt:9,   tone:'#6b4a32' },
    { id:'g18', sku:'KM-305', name:'Заглушка антрацит',       cat:'Комплектующие',unit:'шт',  q:{tunguch:600, kokjar:0,   ceh:0},   min:200, cost:3,   opt:6,   tone:'#3a4048' },
    { id:'g19', sku:'KM-306', name:'Заглушка коричневый',     cat:'Комплектующие',unit:'шт',  q:{tunguch:300, kokjar:0,   ceh:0},   min:150, cost:3,   opt:6,   tone:'#6b4a32' },
    { id:'g12', sku:'RS-400', name:'Нитки белый',          cat:'Расходники',   unit:'м',   q:{tunguch:500,  kokjar:0,   ceh:0},   min:200, cost:1,   opt:2,   tone:'#f7f7f7' },
    { id:'g13', sku:'RS-401', name:'Лента',                cat:'Расходники',   unit:'м',   q:{tunguch:250,  kokjar:0,   ceh:0},   min:150, cost:11,  opt:18,  tone:'#e5e0d5' },
    { id:'g14', sku:'MH-500', name:'Механизм цепочный',    cat:'Механизм',     unit:'компл',q:{tunguch:180, kokjar:0,   ceh:12},  min:60,  cost:145, opt:210, tone:'#c9cdd4' },
    { id:'g15', sku:'MH-501', name:'Электропривод Somfy',  cat:'Механизм',     unit:'шт',  q:{tunguch:6,    kokjar:0,   ceh:0},   min:4,   cost:9800,opt:12500,tone:'#2f3439' },
  ];

  /* ── нормы расхода на одно изделие ────────────────
     Возвращает список материалов на позицию заказа.
     w, h — ширина и высота в метрах, qty — количество изделий. */
  function normsFor(it){
    const out = [];
    const add = (name, qty, unit) => out.push({ name, qty:+qty.toFixed(2), unit });
    /* «Профиль белый» -> «белый»: комплектующие идут в цвет профиля */
    const color = String(it.profile || 'Профиль белый').replace('Профиль ', '');

    add(it.fabric, it.w * it.h * it.qty * 1.05, 'м²');        // +5% на подгиб
    add(it.profile, it.w * it.qty, 'п.м');
    add(`Комплектующий ${color}`, it.qty, 'компл');
    add(`Заглушка ${color}`, it.qty * 2, 'шт');
    add('Кнопка', it.qty, 'шт');
    add('Нитки белый', it.w * it.qty * 2, 'м');
    add('Лента', it.w * it.qty, 'м');
    add('Механизм цепочный', it.qty, 'компл');
    return out;
  }

  /* Свод материалов по всему заказу */
  function materials(o){
    const need = {};
    (o.items || []).forEach(it => normsFor(it).forEach(m => {
      if(!need[m.name]) need[m.name] = { name:m.name, qty:0, unit:m.unit };
      need[m.name].qty = +(need[m.name].qty + m.qty).toFixed(2);
    }));
    return Object.values(need);
  }

  /* ── заказы клиентов ────────────────────────────────
     measureAt — когда ехать на замер; timeless=true значит «в течение дня».
     accepted  — момент, когда замерщик подтвердил, что берёт заказ.
     cash      — деньги, принятые установщиком: пока handedAt пуст,
                 сумма числится на руках у установщика, а не в кассе. */
  const orders = [
    { id:374, num:'374', dueDate:'2026-08-12', branch:'bishkek', channel:'retail', client:'Айнура Осмонова',
      phone:'0705609447', addr:'ЖМ Колмо, ул. Сейил 34', district:'akorgo', source:'WhatsApp',
      status:'assigned', manager:'u1', measurer:'u3', accepted:null,
      measureAt:'2026-08-03', measureTime:'15:00', timeless:false,
      created:'2026-08-03 13:12', deadline:'2026-08-14', color:'белый',
      items:[], sum:0, final:0, payments:[], comment:'',
      history:[{ at:'2026-08-03 13:12', who:'u1', what:'Создан заказ' },
               { at:'2026-08-03 13:12', who:'u1', what:'Назначен замерщик — Сабайалиев Аслан' }] },

    { id:373, num:'373', dueDate:'2026-08-14', branch:'bishkek', channel:'retail', client:'Бакыт Жумалиев',
      phone:'0702550405', addr:'ул. Тыналиева 3-13', district:'tunguch', source:'Instagram',
      status:'assigned', manager:'u1', measurer:'u3', accepted:'2026-08-03 13:40',
      measureAt:'2026-08-03', measureTime:'19:00', timeless:false,
      created:'2026-08-03 12:02', deadline:'2026-08-15', color:'белый',
      items:[], sum:0, final:0, payments:[], comment:'',
      history:[{ at:'2026-08-03 12:02', who:'u1', what:'Создан заказ' },
               { at:'2026-08-03 13:40', who:'u3', what:'Замерщик принял заказ' }] },

    { id:372, num:'372', branch:'bishkek', channel:'retail', client:'Нургуль Асанова',
      phone:'0551703464', addr:'Тунгуч, дом 36/1 кв 21', district:'tunguch', source:'2ГИС',
      status:'assigned', manager:'u1', measurer:'u5', accepted:'2026-08-03 11:05',
      measureAt:'2026-08-03', measureTime:'14:00', timeless:false,
      created:'2026-08-03 10:40', deadline:'2026-08-15', color:'антрацит',
      items:[], sum:0, final:0, payments:[], comment:'',
      history:[{ at:'2026-08-03 10:40', who:'u1', what:'Создан заказ' },
               { at:'2026-08-03 11:05', who:'u5', what:'Замерщик принял заказ' }] },

    { id:371, num:'371', branch:'bishkek', channel:'retail', client:'Эркин Садыков',
      phone:'0700151185', addr:'Кара-Жыгач, Жайылган 15', district:'karazh', source:'Рекомендация',
      status:'new', manager:'u2', measurer:null, accepted:null,
      measureAt:'2026-08-04', measureTime:'', timeless:true,
      created:'2026-08-03 11:11', deadline:'2026-08-16', color:'белый',
      items:[], sum:0, final:0, payments:[], comment:'Просит позвонить после 10:00',
      history:[{ at:'2026-08-03 11:11', who:'u2', what:'Создан заказ' }] },

    { id:370, num:'370', branch:'bishkek', channel:'retail', client:'Гулмира Токтоева',
      phone:'0990169947', addr:'Аалы Токомбаева 29', district:'asanbay', source:'Instagram',
      status:'assigned', manager:'u1', measurer:'u5', accepted:null,
      measureAt:'2026-08-04', measureTime:'11:00', timeless:false,
      created:'2026-08-02 19:00', deadline:'2026-08-16', color:'белый',
      items:[], sum:0, final:0, payments:[], comment:'',
      history:[{ at:'2026-08-02 19:00', who:'u1', what:'Создан заказ' }] },

    { id:369, num:'369', branch:'bishkek', channel:'retail', client:'Марат Жумабеков',
      phone:'0550272117', addr:'Аалы Токомбаева 21/3', district:'asanbay', source:'WhatsApp',
      status:'measured', manager:'u2', measurer:'u4', accepted:'2026-08-02 09:30',
      measureAt:'2026-08-02', measureTime:'12:00', timeless:false,
      created:'2026-08-02 08:15', deadline:'2026-08-16', color:'белый',
      items:[{ w:1.4, h:2.1, qty:2, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная' }],
      sum:18800, final:18800, payments:[], comment:'',
      history:[{ at:'2026-08-02 08:15', who:'u2', what:'Создан заказ' },
               { at:'2026-08-02 09:30', who:'u4', what:'Замерщик принял заказ' },
               { at:'2026-08-02 14:20', who:'u4', what:'Замер сделан, внесены размеры' }] },

    { id:368, num:'368', dueDate:'2026-08-06', branch:'bishkek', channel:'retail', client:'Клиент Айва — Асанова Г.',
      phone:'0999900666', addr:'ЖК Токио, 5 блок, 9 этаж', district:'center', source:'Партнёр',
      status:'thinking', manager:'u2', measurer:'u5', accepted:'2026-08-01 10:00',
      measureAt:'2026-08-01', measureTime:'16:00', timeless:false,
      created:'2026-08-01 09:20', deadline:'2026-08-18', color:'антрацит',
      items:[{ w:1.8, h:2.4, qty:3, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'Рулонная' }],
      sum:41500, final:35275, payments:[], comment:'Дорого, думает до пятницы',
      history:[{ at:'2026-08-01 09:20', who:'u2', what:'Создан заказ' },
               { at:'2026-08-01 10:00', who:'u5', what:'Замерщик принял заказ' },
               { at:'2026-08-01 17:40', who:'u5', what:'Замер сделан' },
               { at:'2026-08-02 09:00', who:'u5', what:'Клиент думает' }] },

    { id:367, num:'367', branch:'bishkek', channel:'retail', client:'Азамат Керимов',
      phone:'0779633209', addr:'ул. Абая 14', district:'mkr7', source:'2ГИС',
      status:'rejected', manager:'u2', measurer:'u6', accepted:'2026-08-01 11:20',
      measureAt:'2026-08-01', measureTime:'', timeless:true,
      created:'2026-08-01 08:00', deadline:'2026-08-18', color:'белый',
      items:[{ w:1.2, h:1.6, qty:2, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Рулонная' }],
      sum:12300, final:12300, payments:[], comment:'Нашёл дешевле у конкурента',
      history:[{ at:'2026-08-01 08:00', who:'u2', what:'Создан заказ' },
               { at:'2026-08-01 11:20', who:'u6', what:'Замерщик принял заказ' },
               { at:'2026-08-01 15:00', who:'u6', what:'Отказ клиента' }] },

    { id:357, num:'357', dueDate:'2026-08-05', branch:'bishkek', channel:'retail', client:'Айбек Мамытов',
      phone:'0702882073', addr:'7 апреля, 2-27-19', district:'mkr7', source:'WhatsApp',
      status:'toShop', manager:'u1', measurer:'u5', accepted:'2026-07-31 09:00',
      measureAt:'2026-07-31', measureTime:'15:00', timeless:false,
      created:'2026-07-31 08:20', deadline:'2026-08-08', color:'белый',
      items:[{ w:0.42, h:1.305, qty:2, fabric:'Blackout antrasit', profile:'Профиль белый', type:'Плиссе',
               urgent:true, marks:[
                 { fabric:{by:'u19',at:'2026-08-02 09:10'}, tape:{by:'u20',at:'2026-08-02 10:05'} },
                 { fabric:{by:'u19',at:'2026-08-02 09:12'} }] },
             { w:0.665, h:1.405, qty:2, fabric:'Blackout antrasit', profile:'Профиль белый', type:'Плиссе',
               urgent:true, marks:[
                 { fabric:{by:'u19',at:'2026-08-02 09:25'} },
                 { fabric:{by:'u19',at:'2026-08-02 09:27'} }] }],
      sum:9600, final:8880, dueDate:'2026-08-01', payments:[{ at:'2026-08-02 20:06', sum:1000, kind:'Предоплата', method:'Мбанк', who:'u1', note:'' }],
      comment:'',
      history:[{ at:'2026-07-31 08:20', who:'u1', what:'Создан заказ' },
               { at:'2026-07-31 09:00', who:'u5', what:'Замерщик принял заказ' },
               { at:'2026-08-02 08:35', who:'u1', what:'Заказ подтверждён клиентом' },
               { at:'2026-08-02 14:11', who:'u1', what:'Отправлен в цех' }] },

    { id:352, num:'352', dueDate:'2026-07-29', branch:'bishkek', channel:'retail', client:'Байкешка Осмонов',
      phone:'0509197079', addr:'Байтумар 59, Ак-Ордо 1', district:'akorgo', source:'Instagram',
      status:'toShop', manager:'u1', measurer:'u5', accepted:'2026-07-30 10:10',
      measureAt:'2026-07-30', measureTime:'13:00', timeless:false,
      created:'2026-07-30 09:00', deadline:'2026-08-07', color:'белый',
      items:[{ w:1.6, h:2.2, qty:3, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[
                 { fabric:{by:'u19',at:'2026-08-01 14:00'}, tape:{by:'u20',at:'2026-08-01 15:10'},
                   profile:{by:'u8',at:'2026-08-02 11:15'}, cord:{by:'u20',at:'2026-08-02 10:30'} },
                 { fabric:{by:'u19',at:'2026-08-01 14:05'}, tape:{by:'u20',at:'2026-08-01 15:14'},
                   profile:{by:'u8',at:'2026-08-02 11:18'}, cord:{by:'u20',at:'2026-08-02 10:34'} },
                 { fabric:{by:'u19',at:'2026-08-01 14:09'}, tape:{by:'u20',at:'2026-08-01 15:20'},
                   profile:{by:'u8',at:'2026-08-02 11:22'}, cord:{by:'u20',at:'2026-08-02 10:39'} }] }],
      sum:33800, final:33800, payments:[], comment:'',
      history:[{ at:'2026-07-30 09:00', who:'u1', what:'Создан заказ' },
               { at:'2026-08-01 12:00', who:'u1', what:'Отправлен в цех' }] },

    { id:338, num:'338', branch:'bishkek', channel:'retail', client:'Нурсултан Асанов',
      phone:'0502669750', addr:'с. Новопокровка, ул. Атая 49', district:'novopok', source:'Рекомендация',
      status:'ready', manager:'u2', measurer:'u5', accepted:'2026-07-28 09:00',
      measureAt:'2026-07-28', measureTime:'', timeless:true,
      created:'2026-07-28 08:00', deadline:'2026-08-05', color:'белый',
      items:[{ w:1.1, h:1.6, qty:2, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Рулонная' }],
      sum:11300, final:11300,
      payments:[{ at:'2026-07-29 10:00', sum:3200, kind:'Предоплата', method:'Мбанк', who:'u2', note:'' }],
      comment:'',
      history:[{ at:'2026-07-28 08:00', who:'u2', what:'Создан заказ' },
               { at:'2026-07-30 10:00', who:'u2', what:'Отправлен в цех' },
               { at:'2026-08-02 16:30', who:'u8', what:'Изготовлено, готов в цеху' }] },

    { id:344, num:'344', dueDate:'2026-08-03', branch:'bishkek', channel:'retail', client:'Динара Кыдыралиева',
      phone:'0501951001', addr:'Кок-Жар, ул. Кийизбаева 26А', district:'kokjar', source:'Instagram',
      status:'toInstall', manager:'u2', measurer:'u5', accepted:'2026-07-26 09:00',
      installer:'u11', senior:'u10',
      measureAt:'2026-07-26', measureTime:'11:00', timeless:false,
      created:'2026-07-26 08:00', deadline:'2026-08-04', color:'белый',
      items:[{ w:1.5, h:2.0, qty:3, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная' }],
      sum:28800, final:28800, dueDate:'2026-08-05', payments:[{ at:'2026-07-27 10:00', sum:10000, kind:'Предоплата', method:'Мбанк', who:'u2', note:'' }],
      comment:'',
      history:[{ at:'2026-07-26 08:00', who:'u2', what:'Создан заказ' },
               { at:'2026-07-28 09:00', who:'u2', what:'Отправлен в цех' },
               { at:'2026-08-01 15:00', who:'u8', what:'Готов в цеху' },
               { at:'2026-08-03 09:00', who:'u10', what:'Назначен установщик — Нуркалый Асанов' }] },

    { id:343, num:'343', dueDate:'2026-07-28', branch:'bishkek', channel:'retail', client:'Талант Бекболотов',
      phone:'0990220577', addr:'ул. Манас 89', district:'center', source:'WhatsApp',
      status:'installed', manager:'u2', measurer:'u6', accepted:'2026-07-24 09:00',
      installer:'u12', senior:'u10',
      measureAt:'2026-07-24', measureTime:'14:00', timeless:false,
      created:'2026-07-24 08:00', deadline:'2026-08-02', color:'белый',
      items:[{ w:1.3, h:1.9, qty:4, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная' }],
      sum:31600, final:31600,
      payments:[{ at:'2026-07-25 11:00', sum:8000, kind:'Предоплата', method:'Мбанк', who:'u2', note:'' },
                { at:'2026-08-02 17:20', sum:23600, kind:'Доплата при установке', method:'Наличные',
                  who:'u12', note:'Принял установщик', cash:true, handedAt:null }],
      comment:'',
      history:[{ at:'2026-07-24 08:00', who:'u2', what:'Создан заказ' },
               { at:'2026-08-02 17:20', who:'u12', what:'Установлено, принята доплата 23 600 наличными' }] },

    { id:340, num:'340', branch:'bishkek', channel:'retail', client:'Жаныбек Асанбеков',
      phone:'0705444403', addr:'Ак-Кеме, Ажыбек Батыра 3/1 кв 27', district:'vostok', source:'2ГИС',
      status:'paid', manager:'u2', measurer:'u4', accepted:'2026-07-20 09:00',
      installer:'u13', senior:'u10',
      measureAt:'2026-07-20', measureTime:'10:00', timeless:false,
      created:'2026-07-20 08:00', deadline:'2026-07-30', color:'антрацит',
      items:[{ w:1.7, h:2.3, qty:2, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'Рулонная' }],
      sum:25000, final:25000,
      payments:[{ at:'2026-07-30 16:00', sum:25000, kind:'Полная оплата', method:'Наличные',
                  who:'u13', note:'Принял установщик', cash:true, handedAt:'2026-07-31 09:30' }],
      comment:'',
      history:[{ at:'2026-07-20 08:00', who:'u2', what:'Создан заказ' },
               { at:'2026-07-30 16:00', who:'u13', what:'Установлено, оплата 25 000 наличными' },
               { at:'2026-07-31 09:30', who:'u14', what:'Деньги сданы в кассу' }] },

    { id:349, num:'349', branch:'bishkek', channel:'retail', client:'Айсулуу Маматова',
      phone:'0555 21 40 11', addr:'мкр Джал 23, кв 41', source:'Instagram',
      status:'paid', manager:'u1', measurer:'u3', installer:'u11', senior:'u10',
      accepted:'2026-07-27 09:00', measureAt:'2026-07-27', measureTime:'11:00', timeless:false,
      created:'2026-07-27 08:00', deadline:'2026-08-01', color:'белый',
      items:[{ w:1.3, h:1.9, qty:2, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная', urgent:false,
               marks:[{ fabric:{by:'u19',at:'2026-07-27 10:00'}, tape:{by:'u20',at:'2026-07-27 12:00'}, profile:{by:'u8',at:'2026-07-27 13:00'}, cord:{by:'u20',at:'2026-07-27 14:00'}, pack:{by:'u22',at:'2026-07-27 16:00'} }, { fabric:{by:'u19',at:'2026-07-27 10:00'}, tape:{by:'u20',at:'2026-07-27 12:00'}, profile:{by:'u8',at:'2026-07-27 13:00'}, cord:{by:'u20',at:'2026-07-27 14:00'}, pack:{by:'u22',at:'2026-07-27 16:00'} }] }],
      sum:30000, final:30000, files:[], comment:'',
      payments:[{ at:'2026-08-01 12:00', sum:30000, kind:'Полная оплата', method:'Мбанк',
                 who:'u11', note:'', cash:false, handedAt:'2026-08-01 09:30', files:[] }],
      history:[{ at:'2026-07-27 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-08-01 12:00', who:'u11', what:'Установлено и полностью оплачено' }] },
    { id:348, num:'348', dueDate:'2026-08-10', branch:'bishkek', channel:'retail', client:'Кубат Асанов',
      phone:'0700 63 12 90', addr:'ул. Байтик Баатыра 55', source:'Instagram',
      status:'installed', manager:'u2', measurer:'u6', installer:'u13', senior:'u10',
      accepted:'2026-07-28 09:00', measureAt:'2026-07-28', measureTime:'11:00', timeless:false,
      created:'2026-07-28 08:00', deadline:'2026-08-03', color:'белый',
      items:[{ w:1.1, h:1.7, qty:2, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Рулонная', urgent:false,
               marks:[{ fabric:{by:'u19',at:'2026-07-28 10:00'}, tape:{by:'u20',at:'2026-07-28 12:00'}, profile:{by:'u8',at:'2026-07-28 13:00'}, cord:{by:'u20',at:'2026-07-28 14:00'}, pack:{by:'u22',at:'2026-07-28 16:00'} }, { fabric:{by:'u19',at:'2026-07-28 10:00'}, tape:{by:'u20',at:'2026-07-28 12:00'}, profile:{by:'u8',at:'2026-07-28 13:00'}, cord:{by:'u20',at:'2026-07-28 14:00'}, pack:{by:'u22',at:'2026-07-28 16:00'} }] }],
      sum:26500, final:26500, files:[], comment:'',
      payments:[{ at:'2026-08-03 12:00', sum:26500, kind:'Полная оплата', method:'Наличные',
                 who:'u13', note:'', cash:true, handedAt:'2026-08-03 09:30', files:[] }],
      history:[{ at:'2026-07-28 08:00', who:'u2', what:'Создан заказ' },
               { at:'2026-08-03 12:00', who:'u13', what:'Установлено и полностью оплачено' }] },
    { id:347, num:'347', branch:'bishkek', channel:'retail', client:'ОсОО «Дом Уюта»',
      phone:'0312 90 55 41', addr:'пр. Чуй 155, офис 3', source:'Instagram',
      status:'paid', manager:'u1', measurer:'u5', installer:'u11', senior:'u10',
      accepted:'2026-07-26 09:00', measureAt:'2026-07-26', measureTime:'11:00', timeless:false,
      created:'2026-07-26 08:00', deadline:'2026-08-03', color:'белый',
      items:[{ w:1.6, h:2.3, qty:3, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'Рулонная', urgent:false,
               marks:[{ fabric:{by:'u19',at:'2026-07-26 10:00'}, tape:{by:'u20',at:'2026-07-26 12:00'}, profile:{by:'u8',at:'2026-07-26 13:00'}, cord:{by:'u20',at:'2026-07-26 14:00'}, pack:{by:'u22',at:'2026-07-26 16:00'} }, { fabric:{by:'u19',at:'2026-07-26 10:00'}, tape:{by:'u20',at:'2026-07-26 12:00'}, profile:{by:'u8',at:'2026-07-26 13:00'}, cord:{by:'u20',at:'2026-07-26 14:00'}, pack:{by:'u22',at:'2026-07-26 16:00'} }, { fabric:{by:'u19',at:'2026-07-26 10:00'}, tape:{by:'u20',at:'2026-07-26 12:00'}, profile:{by:'u8',at:'2026-07-26 13:00'}, cord:{by:'u20',at:'2026-07-26 14:00'}, pack:{by:'u22',at:'2026-07-26 16:00'} }] }],
      sum:41000, final:41000, files:[], comment:'',
      payments:[{ at:'2026-08-03 12:00', sum:41000, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u11', note:'', cash:false, handedAt:'2026-08-03 09:30', files:[] }],
      history:[{ at:'2026-07-26 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-08-03 12:00', who:'u11', what:'Установлено и полностью оплачено' }] },
    { id:346, num:'346', branch:'bishkek', channel:'retail', client:'Салтанат Орозова',
      phone:'0770 18 22 45', addr:'ул. Тыналиева 8, кв 12', source:'Instagram',
      status:'done', manager:'u2', measurer:'u4', installer:'u12', senior:'u10',
      accepted:'2026-07-24 09:00', measureAt:'2026-07-24', measureTime:'11:00', timeless:false,
      created:'2026-07-24 08:00', deadline:'2026-08-02', color:'белый',
      items:[{ w:1.4, h:2.0, qty:3, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Рулонная', urgent:false,
               marks:[{ fabric:{by:'u19',at:'2026-07-24 10:00'}, tape:{by:'u20',at:'2026-07-24 12:00'}, profile:{by:'u8',at:'2026-07-24 13:00'}, cord:{by:'u20',at:'2026-07-24 14:00'}, pack:{by:'u22',at:'2026-07-24 16:00'} }, { fabric:{by:'u19',at:'2026-07-24 10:00'}, tape:{by:'u20',at:'2026-07-24 12:00'}, profile:{by:'u8',at:'2026-07-24 13:00'}, cord:{by:'u20',at:'2026-07-24 14:00'}, pack:{by:'u22',at:'2026-07-24 16:00'} }, { fabric:{by:'u19',at:'2026-07-24 10:00'}, tape:{by:'u20',at:'2026-07-24 12:00'}, profile:{by:'u8',at:'2026-07-24 13:00'}, cord:{by:'u20',at:'2026-07-24 14:00'}, pack:{by:'u22',at:'2026-07-24 16:00'} }] }],
      sum:34500, final:34500, files:[], comment:'',
      payments:[{ at:'2026-08-02 12:00', sum:34500, kind:'Полная оплата', method:'Мбанк',
                 who:'u12', note:'', cash:false, handedAt:'2026-08-02 09:30', files:[] }],
      history:[{ at:'2026-07-24 08:00', who:'u2', what:'Создан заказ' },
               { at:'2026-08-02 12:00', who:'u12', what:'Установлено и полностью оплачено' }] },
    { id:345, num:'345', branch:'bishkek', channel:'retail', client:'Азамат Керим уулу',
      phone:'0505 77 30 18', addr:'ул. Ахунбаева 91', source:'Instagram',
      status:'paid', manager:'u1', measurer:'u3', installer:'u11', senior:'u10',
      accepted:'2026-07-22 09:00', measureAt:'2026-07-22', measureTime:'11:00', timeless:false,
      created:'2026-07-22 08:00', deadline:'2026-08-01', color:'белый',
      items:[{ w:1.2, h:1.8, qty:2, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная', urgent:false,
               marks:[{ fabric:{by:'u19',at:'2026-07-22 10:00'}, tape:{by:'u20',at:'2026-07-22 12:00'}, profile:{by:'u8',at:'2026-07-22 13:00'}, cord:{by:'u20',at:'2026-07-22 14:00'}, pack:{by:'u22',at:'2026-07-22 16:00'} }, { fabric:{by:'u19',at:'2026-07-22 10:00'}, tape:{by:'u20',at:'2026-07-22 12:00'}, profile:{by:'u8',at:'2026-07-22 13:00'}, cord:{by:'u20',at:'2026-07-22 14:00'}, pack:{by:'u22',at:'2026-07-22 16:00'} }] }],
      sum:28000, final:28000, files:[], comment:'',
      payments:[{ at:'2026-08-01 12:00', sum:28000, kind:'Полная оплата', method:'Наличные',
                 who:'u11', note:'', cash:true, handedAt:'2026-08-01 09:30', files:[] }],
      history:[{ at:'2026-07-22 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-08-01 12:00', who:'u11', what:'Установлено и полностью оплачено' }] },
    { id:336, num:'336', branch:'bishkek', channel:'retail', client:'Кафе «Ак-Кеме»',
      phone:'0312 44 18 02', addr:'ул. Киевская 148', source:'Instagram',
      status:'done', manager:'u2', measurer:'u4', installer:'u12', senior:'u10',
      accepted:'2026-07-08 09:00', measureAt:'2026-07-08', measureTime:'11:00', timeless:false,
      created:'2026-07-08 08:00', deadline:'2026-07-22', color:'белый',
      items:[{ w:1.8, h:2.4, qty:4, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'Рулонная', urgent:false,
               marks:[{ fabric:{by:'u19',at:'2026-07-08 10:00'}, tape:{by:'u20',at:'2026-07-08 12:00'}, profile:{by:'u8',at:'2026-07-08 13:00'}, cord:{by:'u20',at:'2026-07-08 14:00'}, pack:{by:'u22',at:'2026-07-08 16:00'} }, { fabric:{by:'u19',at:'2026-07-08 10:00'}, tape:{by:'u20',at:'2026-07-08 12:00'}, profile:{by:'u8',at:'2026-07-08 13:00'}, cord:{by:'u20',at:'2026-07-08 14:00'}, pack:{by:'u22',at:'2026-07-08 16:00'} }, { fabric:{by:'u19',at:'2026-07-08 10:00'}, tape:{by:'u20',at:'2026-07-08 12:00'}, profile:{by:'u8',at:'2026-07-08 13:00'}, cord:{by:'u20',at:'2026-07-08 14:00'}, pack:{by:'u22',at:'2026-07-08 16:00'} }, { fabric:{by:'u19',at:'2026-07-08 10:00'}, tape:{by:'u20',at:'2026-07-08 12:00'}, profile:{by:'u8',at:'2026-07-08 13:00'}, cord:{by:'u20',at:'2026-07-08 14:00'}, pack:{by:'u22',at:'2026-07-08 16:00'} }] }],
      sum:52000, final:52000, files:[], comment:'',
      payments:[{ at:'2026-07-22 12:00', sum:52000, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u12', note:'', cash:false, handedAt:'2026-07-22 09:30', files:[] }],
      history:[{ at:'2026-07-08 08:00', who:'u2', what:'Создан заказ' },
               { at:'2026-07-22 12:00', who:'u12', what:'Установлено и полностью оплачено' }] },
    { id:335, num:'335', branch:'bishkek', channel:'retail', client:'Нурлан Бекбоев',
      phone:'0555 90 14 76', addr:'мкр Асанбай 17, кв 8', source:'Instagram',
      status:'paid', manager:'u1', measurer:'u5', installer:'u13', senior:'u10',
      accepted:'2026-07-05 09:00', measureAt:'2026-07-05', measureTime:'11:00', timeless:false,
      created:'2026-07-05 08:00', deadline:'2026-07-15', color:'белый',
      items:[{ w:1.5, h:2.1, qty:4, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная', urgent:false,
               marks:[{ fabric:{by:'u19',at:'2026-07-05 10:00'}, tape:{by:'u20',at:'2026-07-05 12:00'}, profile:{by:'u8',at:'2026-07-05 13:00'}, cord:{by:'u20',at:'2026-07-05 14:00'}, pack:{by:'u22',at:'2026-07-05 16:00'} }, { fabric:{by:'u19',at:'2026-07-05 10:00'}, tape:{by:'u20',at:'2026-07-05 12:00'}, profile:{by:'u8',at:'2026-07-05 13:00'}, cord:{by:'u20',at:'2026-07-05 14:00'}, pack:{by:'u22',at:'2026-07-05 16:00'} }, { fabric:{by:'u19',at:'2026-07-05 10:00'}, tape:{by:'u20',at:'2026-07-05 12:00'}, profile:{by:'u8',at:'2026-07-05 13:00'}, cord:{by:'u20',at:'2026-07-05 14:00'}, pack:{by:'u22',at:'2026-07-05 16:00'} }, { fabric:{by:'u19',at:'2026-07-05 10:00'}, tape:{by:'u20',at:'2026-07-05 12:00'}, profile:{by:'u8',at:'2026-07-05 13:00'}, cord:{by:'u20',at:'2026-07-05 14:00'}, pack:{by:'u22',at:'2026-07-05 16:00'} }] }],
      sum:45000, final:45000, files:[], comment:'',
      payments:[{ at:'2026-07-15 12:00', sum:45000, kind:'Полная оплата', method:'Наличные',
                 who:'u13', note:'', cash:true, handedAt:'2026-07-15 09:30', files:[] }],
      history:[{ at:'2026-07-05 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-07-15 12:00', who:'u13', what:'Установлено и полностью оплачено' }] },

    { id:301, num:'301', branch:'bishkek', channel:'retail',
      client:'Эркин Садыков', phone:'0722 63 18 40',
      addr:'ул. Токтогула 71', source:'Рекомендация',
      status:'paid', manager:'u15',
      measurer:'u3', installer:'u12', senior:'u10',
      accepted:'2026-03-07 09:00', measureAt:'2026-03-07', measureTime:'11:00', timeless:false,
      created:'2026-03-07 08:00', deadline:'2026-03-14', color:'белый',
      items:[{ w:1.59, h:1.57, qty:4, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u19',at:'2026-03-07 10:00'}, tape:{by:'u21',at:'2026-03-07 12:00'}, profile:{by:'u8',at:'2026-03-07 13:00'}, cord:{by:'u19',at:'2026-03-07 14:00'}, pack:{by:'u22',at:'2026-03-07 16:00'} }, { fabric:{by:'u19',at:'2026-03-07 10:00'}, tape:{by:'u21',at:'2026-03-07 12:00'}, profile:{by:'u8',at:'2026-03-07 13:00'}, cord:{by:'u19',at:'2026-03-07 14:00'}, pack:{by:'u22',at:'2026-03-07 16:00'} }, { fabric:{by:'u19',at:'2026-03-07 10:00'}, tape:{by:'u21',at:'2026-03-07 12:00'}, profile:{by:'u8',at:'2026-03-07 13:00'}, cord:{by:'u19',at:'2026-03-07 14:00'}, pack:{by:'u22',at:'2026-03-07 16:00'} }, { fabric:{by:'u19',at:'2026-03-07 10:00'}, tape:{by:'u21',at:'2026-03-07 12:00'}, profile:{by:'u8',at:'2026-03-07 13:00'}, cord:{by:'u19',at:'2026-03-07 14:00'}, pack:{by:'u22',at:'2026-03-07 16:00'} }] }],
      sum:32000, final:32000, files:[], comment:'',
      payments:[{ at:'2026-03-14 12:00', sum:32000, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u12', note:'', cash:false, handedAt:'2026-03-14 17:00', files:[] }],
      history:[{ at:'2026-03-07 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-03-14 12:00', who:'u12', what:'Установлено и оплачено' }] },
    { id:302, num:'302', branch:'bishkek', channel:'retail',
      client:'Улан Джолдошев', phone:'0573 79 25 83',
      addr:'мкр Асанбай 72', source:'WhatsApp',
      status:'paid', manager:'u15',
      measurer:'u7', installer:'u11', senior:'u10',
      accepted:'2026-03-05 09:00', measureAt:'2026-03-05', measureTime:'11:00', timeless:false,
      created:'2026-03-05 08:00', deadline:'2026-03-16', color:'белый',
      items:[{ w:1.52, h:1.56, qty:4, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная',
               urgent:false, marks:[{ fabric:{by:'u19',at:'2026-03-05 10:00'}, tape:{by:'u21',at:'2026-03-05 12:00'}, profile:{by:'u8',at:'2026-03-05 13:00'}, cord:{by:'u19',at:'2026-03-05 14:00'}, pack:{by:'u22',at:'2026-03-05 16:00'} }, { fabric:{by:'u19',at:'2026-03-05 10:00'}, tape:{by:'u21',at:'2026-03-05 12:00'}, profile:{by:'u8',at:'2026-03-05 13:00'}, cord:{by:'u19',at:'2026-03-05 14:00'}, pack:{by:'u22',at:'2026-03-05 16:00'} }, { fabric:{by:'u19',at:'2026-03-05 10:00'}, tape:{by:'u21',at:'2026-03-05 12:00'}, profile:{by:'u8',at:'2026-03-05 13:00'}, cord:{by:'u19',at:'2026-03-05 14:00'}, pack:{by:'u22',at:'2026-03-05 16:00'} }, { fabric:{by:'u19',at:'2026-03-05 10:00'}, tape:{by:'u21',at:'2026-03-05 12:00'}, profile:{by:'u8',at:'2026-03-05 13:00'}, cord:{by:'u19',at:'2026-03-05 14:00'}, pack:{by:'u22',at:'2026-03-05 16:00'} }] }],
      sum:24700, final:23500, files:[], comment:'',
      payments:[{ at:'2026-03-16 12:00', sum:23500, kind:'Полная оплата', method:'Наличные',
                 who:'u11', note:'', cash:true, handedAt:'2026-03-16 17:00', files:[] }],
      history:[{ at:'2026-03-05 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-03-16 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:303, num:'303', branch:'bishkek', channel:'retail',
      client:'Гулмира Садырова', phone:'0660 69 84 68',
      addr:'ул. Тыналиева 39', source:'WhatsApp',
      status:'paid', manager:'u15',
      measurer:'u17', installer:'u13', senior:'u10',
      accepted:'2026-03-12 09:00', measureAt:'2026-03-12', measureTime:'11:00', timeless:false,
      created:'2026-03-12 08:00', deadline:'2026-03-19', color:'белый',
      items:[{ w:1.09, h:2.14, qty:4, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-03-12 10:00'}, tape:{by:'u21',at:'2026-03-12 12:00'}, profile:{by:'u8',at:'2026-03-12 13:00'}, cord:{by:'u21',at:'2026-03-12 14:00'}, pack:{by:'u22',at:'2026-03-12 16:00'} }, { fabric:{by:'u20',at:'2026-03-12 10:00'}, tape:{by:'u21',at:'2026-03-12 12:00'}, profile:{by:'u8',at:'2026-03-12 13:00'}, cord:{by:'u21',at:'2026-03-12 14:00'}, pack:{by:'u22',at:'2026-03-12 16:00'} }, { fabric:{by:'u20',at:'2026-03-12 10:00'}, tape:{by:'u21',at:'2026-03-12 12:00'}, profile:{by:'u8',at:'2026-03-12 13:00'}, cord:{by:'u21',at:'2026-03-12 14:00'}, pack:{by:'u22',at:'2026-03-12 16:00'} }, { fabric:{by:'u20',at:'2026-03-12 10:00'}, tape:{by:'u21',at:'2026-03-12 12:00'}, profile:{by:'u8',at:'2026-03-12 13:00'}, cord:{by:'u21',at:'2026-03-12 14:00'}, pack:{by:'u22',at:'2026-03-12 16:00'} }] }],
      sum:39200, final:39200, files:[], comment:'',
      payments:[{ at:'2026-03-19 12:00', sum:39200, kind:'Полная оплата', method:'Наличные',
                 who:'u13', note:'', cash:true, handedAt:'2026-03-19 17:00', files:[] }],
      history:[{ at:'2026-03-12 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-03-19 12:00', who:'u13', what:'Установлено и оплачено' }] },
    { id:304, num:'304', branch:'karakol', channel:'retail',
      client:'Улан Джолдошев', phone:'0584 53 29 72',
      addr:'ул. Манас 6', source:'Instagram',
      status:'installed', manager:'u15',
      measurer:'u17', installer:'u12', senior:'u10',
      accepted:'2026-03-05 09:00', measureAt:'2026-03-05', measureTime:'11:00', timeless:false,
      created:'2026-03-05 08:00', deadline:'2026-03-11', color:'белый',
      items:[{ w:1.27, h:1.95, qty:3, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе',
               urgent:false, marks:[{ fabric:{by:'u21',at:'2026-03-05 10:00'}, tape:{by:'u19',at:'2026-03-05 12:00'}, profile:{by:'u8',at:'2026-03-05 13:00'}, cord:{by:'u19',at:'2026-03-05 14:00'}, pack:{by:'u22',at:'2026-03-05 16:00'} }, { fabric:{by:'u21',at:'2026-03-05 10:00'}, tape:{by:'u19',at:'2026-03-05 12:00'}, profile:{by:'u8',at:'2026-03-05 13:00'}, cord:{by:'u19',at:'2026-03-05 14:00'}, pack:{by:'u22',at:'2026-03-05 16:00'} }, { fabric:{by:'u21',at:'2026-03-05 10:00'}, tape:{by:'u19',at:'2026-03-05 12:00'}, profile:{by:'u8',at:'2026-03-05 13:00'}, cord:{by:'u19',at:'2026-03-05 14:00'}, pack:{by:'u22',at:'2026-03-05 16:00'} }] }],
      sum:24100, final:21700, files:[], comment:'',
      payments:[{ at:'2026-03-11 12:00', sum:21700, kind:'Полная оплата', method:'Мбанк',
                 who:'u12', note:'', cash:false, handedAt:'2026-03-11 17:00', files:[] }],
      history:[{ at:'2026-03-05 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-03-11 12:00', who:'u12', what:'Установлено и оплачено' }] },
    { id:305, num:'305', branch:'bishkek', channel:'retail',
      client:'Гулназ Алиева', phone:'0658 92 83 97',
      addr:'мкр 7 37', source:'Рекомендация',
      status:'installed', manager:'u2',
      measurer:'u3', installer:'u11', senior:'u10',
      accepted:'2026-03-07 09:00', measureAt:'2026-03-07', measureTime:'11:00', timeless:false,
      created:'2026-03-07 08:00', deadline:'2026-03-15', color:'белый',
      items:[{ w:1.32, h:1.95, qty:3, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-03-07 10:00'}, tape:{by:'u21',at:'2026-03-07 12:00'}, profile:{by:'u8',at:'2026-03-07 13:00'}, cord:{by:'u21',at:'2026-03-07 14:00'}, pack:{by:'u22',at:'2026-03-07 16:00'} }, { fabric:{by:'u20',at:'2026-03-07 10:00'}, tape:{by:'u21',at:'2026-03-07 12:00'}, profile:{by:'u8',at:'2026-03-07 13:00'}, cord:{by:'u21',at:'2026-03-07 14:00'}, pack:{by:'u22',at:'2026-03-07 16:00'} }, { fabric:{by:'u20',at:'2026-03-07 10:00'}, tape:{by:'u21',at:'2026-03-07 12:00'}, profile:{by:'u8',at:'2026-03-07 13:00'}, cord:{by:'u21',at:'2026-03-07 14:00'}, pack:{by:'u22',at:'2026-03-07 16:00'} }] }],
      sum:20100, final:20100, files:[], comment:'',
      payments:[{ at:'2026-03-15 12:00', sum:20100, kind:'Полная оплата', method:'Мбанк',
                 who:'u11', note:'', cash:false, handedAt:'2026-03-15 17:00', files:[] }],
      history:[{ at:'2026-03-07 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-03-15 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:306, num:'306', branch:'osh', channel:'retail',
      client:'Эркин Садыков', phone:'0585 67 61 80',
      addr:'мкр Асанбай 114', source:'WhatsApp',
      status:'done', manager:'u15',
      measurer:'u5', installer:'u11', senior:'u10',
      accepted:'2026-04-09 09:00', measureAt:'2026-04-09', measureTime:'11:00', timeless:false,
      created:'2026-04-09 08:00', deadline:'2026-04-17', color:'белый',
      items:[{ w:1.55, h:1.94, qty:2, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u19',at:'2026-04-09 10:00'}, tape:{by:'u20',at:'2026-04-09 12:00'}, profile:{by:'u8',at:'2026-04-09 13:00'}, cord:{by:'u20',at:'2026-04-09 14:00'}, pack:{by:'u22',at:'2026-04-09 16:00'} }, { fabric:{by:'u19',at:'2026-04-09 10:00'}, tape:{by:'u20',at:'2026-04-09 12:00'}, profile:{by:'u8',at:'2026-04-09 13:00'}, cord:{by:'u20',at:'2026-04-09 14:00'}, pack:{by:'u22',at:'2026-04-09 16:00'} }] }],
      sum:19200, final:19200, files:[], comment:'',
      payments:[{ at:'2026-04-17 12:00', sum:19200, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u11', note:'', cash:false, handedAt:'2026-04-17 17:00', files:[] }],
      history:[{ at:'2026-04-09 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-04-17 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:307, num:'307', branch:'bishkek', channel:'retail',
      client:'Азамат Бердибеков', phone:'0593 43 46 10',
      addr:'мкр Джал 54', source:'Звонок',
      status:'done', manager:'u15',
      measurer:'u7', installer:'u11', senior:'u10',
      accepted:'2026-04-08 09:00', measureAt:'2026-04-08', measureTime:'11:00', timeless:false,
      created:'2026-04-08 08:00', deadline:'2026-04-16', color:'белый',
      items:[{ w:1.8, h:2.36, qty:2, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная',
               urgent:false, marks:[{ fabric:{by:'u19',at:'2026-04-08 10:00'}, tape:{by:'u21',at:'2026-04-08 12:00'}, profile:{by:'u8',at:'2026-04-08 13:00'}, cord:{by:'u19',at:'2026-04-08 14:00'}, pack:{by:'u22',at:'2026-04-08 16:00'} }, { fabric:{by:'u19',at:'2026-04-08 10:00'}, tape:{by:'u21',at:'2026-04-08 12:00'}, profile:{by:'u8',at:'2026-04-08 13:00'}, cord:{by:'u19',at:'2026-04-08 14:00'}, pack:{by:'u22',at:'2026-04-08 16:00'} }] }],
      sum:22100, final:22100, files:[], comment:'',
      payments:[{ at:'2026-04-16 12:00', sum:22100, kind:'Полная оплата', method:'Наличные',
                 who:'u11', note:'', cash:true, handedAt:'2026-04-16 17:00', files:[] }],
      history:[{ at:'2026-04-08 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-04-16 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:308, num:'308', branch:'bishkek', channel:'retail',
      client:'Динара Токтосунова', phone:'0704 60 23 71',
      addr:'ул. Манас 8', source:'WhatsApp',
      status:'paid', manager:'u1',
      measurer:'u6', installer:'u13', senior:'u10',
      accepted:'2026-04-07 09:00', measureAt:'2026-04-07', measureTime:'11:00', timeless:false,
      created:'2026-04-07 08:00', deadline:'2026-04-14', color:'белый',
      items:[{ w:1.77, h:2.36, qty:4, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-04-07 10:00'}, tape:{by:'u21',at:'2026-04-07 12:00'}, profile:{by:'u8',at:'2026-04-07 13:00'}, cord:{by:'u21',at:'2026-04-07 14:00'}, pack:{by:'u22',at:'2026-04-07 16:00'} }, { fabric:{by:'u20',at:'2026-04-07 10:00'}, tape:{by:'u21',at:'2026-04-07 12:00'}, profile:{by:'u8',at:'2026-04-07 13:00'}, cord:{by:'u21',at:'2026-04-07 14:00'}, pack:{by:'u22',at:'2026-04-07 16:00'} }, { fabric:{by:'u20',at:'2026-04-07 10:00'}, tape:{by:'u21',at:'2026-04-07 12:00'}, profile:{by:'u8',at:'2026-04-07 13:00'}, cord:{by:'u21',at:'2026-04-07 14:00'}, pack:{by:'u22',at:'2026-04-07 16:00'} }, { fabric:{by:'u20',at:'2026-04-07 10:00'}, tape:{by:'u21',at:'2026-04-07 12:00'}, profile:{by:'u8',at:'2026-04-07 13:00'}, cord:{by:'u21',at:'2026-04-07 14:00'}, pack:{by:'u22',at:'2026-04-07 16:00'} }] }],
      sum:43400, final:39100, files:[], comment:'',
      payments:[{ at:'2026-04-14 12:00', sum:39100, kind:'Полная оплата', method:'Наличные',
                 who:'u13', note:'', cash:true, handedAt:'2026-04-14 17:00', files:[] }],
      history:[{ at:'2026-04-07 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-04-14 12:00', who:'u13', what:'Установлено и оплачено' }] },
    { id:309, num:'309', branch:'bishkek', channel:'retail',
      client:'Жылдыз Абдырахманова', phone:'0692 29 91 42',
      addr:'ул. Тыналиева 78', source:'2ГИС',
      status:'done', manager:'u1',
      measurer:'u3', installer:'u13', senior:'u10',
      accepted:'2026-04-04 09:00', measureAt:'2026-04-04', measureTime:'11:00', timeless:false,
      created:'2026-04-04 08:00', deadline:'2026-04-10', color:'белый',
      items:[{ w:1.54, h:1.59, qty:4, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-04-04 10:00'}, tape:{by:'u21',at:'2026-04-04 12:00'}, profile:{by:'u8',at:'2026-04-04 13:00'}, cord:{by:'u19',at:'2026-04-04 14:00'}, pack:{by:'u22',at:'2026-04-04 16:00'} }, { fabric:{by:'u20',at:'2026-04-04 10:00'}, tape:{by:'u21',at:'2026-04-04 12:00'}, profile:{by:'u8',at:'2026-04-04 13:00'}, cord:{by:'u19',at:'2026-04-04 14:00'}, pack:{by:'u22',at:'2026-04-04 16:00'} }, { fabric:{by:'u20',at:'2026-04-04 10:00'}, tape:{by:'u21',at:'2026-04-04 12:00'}, profile:{by:'u8',at:'2026-04-04 13:00'}, cord:{by:'u19',at:'2026-04-04 14:00'}, pack:{by:'u22',at:'2026-04-04 16:00'} }, { fabric:{by:'u20',at:'2026-04-04 10:00'}, tape:{by:'u21',at:'2026-04-04 12:00'}, profile:{by:'u8',at:'2026-04-04 13:00'}, cord:{by:'u19',at:'2026-04-04 14:00'}, pack:{by:'u22',at:'2026-04-04 16:00'} }] }],
      sum:41100, final:41100, files:[], comment:'',
      payments:[{ at:'2026-04-10 12:00', sum:41100, kind:'Полная оплата', method:'Наличные',
                 who:'u13', note:'', cash:true, handedAt:'2026-04-10 17:00', files:[] }],
      history:[{ at:'2026-04-04 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-04-10 12:00', who:'u13', what:'Установлено и оплачено' }] },
    { id:310, num:'310', branch:'bishkek', channel:'retail',
      client:'Нургуль Шаршеева', phone:'0511 36 77 56',
      addr:'мкр Джал 89', source:'Звонок',
      status:'paid', manager:'u15',
      measurer:'u5', installer:'u12', senior:'u10',
      accepted:'2026-04-09 09:00', measureAt:'2026-04-09', measureTime:'11:00', timeless:false,
      created:'2026-04-09 08:00', deadline:'2026-04-18', color:'белый',
      items:[{ w:1.44, h:1.58, qty:2, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-04-09 10:00'}, tape:{by:'u20',at:'2026-04-09 12:00'}, profile:{by:'u8',at:'2026-04-09 13:00'}, cord:{by:'u21',at:'2026-04-09 14:00'}, pack:{by:'u22',at:'2026-04-09 16:00'} }, { fabric:{by:'u20',at:'2026-04-09 10:00'}, tape:{by:'u20',at:'2026-04-09 12:00'}, profile:{by:'u8',at:'2026-04-09 13:00'}, cord:{by:'u21',at:'2026-04-09 14:00'}, pack:{by:'u22',at:'2026-04-09 16:00'} }] }],
      sum:14600, final:13100, files:[], comment:'',
      payments:[{ at:'2026-04-18 12:00', sum:13100, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u12', note:'', cash:false, handedAt:'2026-04-18 17:00', files:[] }],
      history:[{ at:'2026-04-09 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-04-18 12:00', who:'u12', what:'Установлено и оплачено' }] },
    { id:311, num:'311', branch:'bishkek', channel:'retail',
      client:'Чолпон Мураталиева', phone:'0614 88 34 40',
      addr:'ул. Манас 95', source:'WhatsApp',
      status:'paid', manager:'u15',
      measurer:'u6', installer:'u12', senior:'u10',
      accepted:'2026-05-12 09:00', measureAt:'2026-05-12', measureTime:'11:00', timeless:false,
      created:'2026-05-12 08:00', deadline:'2026-05-24', color:'белый',
      items:[{ w:1.63, h:1.74, qty:3, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u21',at:'2026-05-12 10:00'}, tape:{by:'u21',at:'2026-05-12 12:00'}, profile:{by:'u8',at:'2026-05-12 13:00'}, cord:{by:'u21',at:'2026-05-12 14:00'}, pack:{by:'u22',at:'2026-05-12 16:00'} }, { fabric:{by:'u21',at:'2026-05-12 10:00'}, tape:{by:'u21',at:'2026-05-12 12:00'}, profile:{by:'u8',at:'2026-05-12 13:00'}, cord:{by:'u21',at:'2026-05-12 14:00'}, pack:{by:'u22',at:'2026-05-12 16:00'} }, { fabric:{by:'u21',at:'2026-05-12 10:00'}, tape:{by:'u21',at:'2026-05-12 12:00'}, profile:{by:'u8',at:'2026-05-12 13:00'}, cord:{by:'u21',at:'2026-05-12 14:00'}, pack:{by:'u22',at:'2026-05-12 16:00'} }] }],
      sum:27200, final:27200, files:[], comment:'',
      payments:[{ at:'2026-05-24 12:00', sum:27200, kind:'Полная оплата', method:'Наличные',
                 who:'u12', note:'', cash:true, handedAt:'2026-05-24 17:00', files:[] }],
      history:[{ at:'2026-05-12 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-05-24 12:00', who:'u12', what:'Установлено и оплачено' }] },
    { id:312, num:'312', branch:'bishkek', channel:'retail',
      client:'Кубанычбек Асанов', phone:'0541 38 23 39',
      addr:'мкр 7 26', source:'2ГИС',
      status:'paid', manager:'u2',
      measurer:'u7', installer:'u11', senior:'u10',
      accepted:'2026-05-07 09:00', measureAt:'2026-05-07', measureTime:'11:00', timeless:false,
      created:'2026-05-07 08:00', deadline:'2026-05-18', color:'белый',
      items:[{ w:1.89, h:2.21, qty:3, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u21',at:'2026-05-07 10:00'}, tape:{by:'u20',at:'2026-05-07 12:00'}, profile:{by:'u8',at:'2026-05-07 13:00'}, cord:{by:'u20',at:'2026-05-07 14:00'}, pack:{by:'u22',at:'2026-05-07 16:00'} }, { fabric:{by:'u21',at:'2026-05-07 10:00'}, tape:{by:'u20',at:'2026-05-07 12:00'}, profile:{by:'u8',at:'2026-05-07 13:00'}, cord:{by:'u20',at:'2026-05-07 14:00'}, pack:{by:'u22',at:'2026-05-07 16:00'} }, { fabric:{by:'u21',at:'2026-05-07 10:00'}, tape:{by:'u20',at:'2026-05-07 12:00'}, profile:{by:'u8',at:'2026-05-07 13:00'}, cord:{by:'u20',at:'2026-05-07 14:00'}, pack:{by:'u22',at:'2026-05-07 16:00'} }] }],
      sum:40100, final:40100, files:[], comment:'',
      payments:[{ at:'2026-05-18 12:00', sum:40100, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u11', note:'', cash:false, handedAt:'2026-05-18 17:00', files:[] }],
      history:[{ at:'2026-05-07 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-05-18 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:313, num:'313', branch:'osh', channel:'retail',
      client:'Нурзат Кыдыров', phone:'0722 91 52 21',
      addr:'ул. Манас 60', source:'Рекомендация',
      status:'installed', manager:'u1',
      measurer:'u16', installer:'u13', senior:'u10',
      accepted:'2026-05-11 09:00', measureAt:'2026-05-11', measureTime:'11:00', timeless:false,
      created:'2026-05-11 08:00', deadline:'2026-05-23', color:'белый',
      items:[{ w:1.43, h:2.09, qty:4, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-05-11 10:00'}, tape:{by:'u21',at:'2026-05-11 12:00'}, profile:{by:'u8',at:'2026-05-11 13:00'}, cord:{by:'u19',at:'2026-05-11 14:00'}, pack:{by:'u22',at:'2026-05-11 16:00'} }, { fabric:{by:'u20',at:'2026-05-11 10:00'}, tape:{by:'u21',at:'2026-05-11 12:00'}, profile:{by:'u8',at:'2026-05-11 13:00'}, cord:{by:'u19',at:'2026-05-11 14:00'}, pack:{by:'u22',at:'2026-05-11 16:00'} }, { fabric:{by:'u20',at:'2026-05-11 10:00'}, tape:{by:'u21',at:'2026-05-11 12:00'}, profile:{by:'u8',at:'2026-05-11 13:00'}, cord:{by:'u19',at:'2026-05-11 14:00'}, pack:{by:'u22',at:'2026-05-11 16:00'} }, { fabric:{by:'u20',at:'2026-05-11 10:00'}, tape:{by:'u21',at:'2026-05-11 12:00'}, profile:{by:'u8',at:'2026-05-11 13:00'}, cord:{by:'u19',at:'2026-05-11 14:00'}, pack:{by:'u22',at:'2026-05-11 16:00'} }] }],
      sum:38300, final:38300, files:[], comment:'',
      payments:[{ at:'2026-05-23 12:00', sum:38300, kind:'Полная оплата', method:'Наличные',
                 who:'u13', note:'', cash:true, handedAt:'2026-05-23 17:00', files:[] }],
      history:[{ at:'2026-05-11 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-05-23 12:00', who:'u13', what:'Установлено и оплачено' }] },
    { id:314, num:'314', branch:'bishkek', channel:'retail',
      client:'Марат Осмонов', phone:'0567 12 11 93',
      addr:'ул. Токтогула 68', source:'WhatsApp',
      status:'done', manager:'u1',
      measurer:'u17', installer:'u11', senior:'u10',
      accepted:'2026-05-04 09:00', measureAt:'2026-05-04', measureTime:'11:00', timeless:false,
      created:'2026-05-04 08:00', deadline:'2026-05-11', color:'белый',
      items:[{ w:1.02, h:2.03, qty:3, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u21',at:'2026-05-04 10:00'}, tape:{by:'u20',at:'2026-05-04 12:00'}, profile:{by:'u8',at:'2026-05-04 13:00'}, cord:{by:'u21',at:'2026-05-04 14:00'}, pack:{by:'u22',at:'2026-05-04 16:00'} }, { fabric:{by:'u21',at:'2026-05-04 10:00'}, tape:{by:'u20',at:'2026-05-04 12:00'}, profile:{by:'u8',at:'2026-05-04 13:00'}, cord:{by:'u21',at:'2026-05-04 14:00'}, pack:{by:'u22',at:'2026-05-04 16:00'} }, { fabric:{by:'u21',at:'2026-05-04 10:00'}, tape:{by:'u20',at:'2026-05-04 12:00'}, profile:{by:'u8',at:'2026-05-04 13:00'}, cord:{by:'u21',at:'2026-05-04 14:00'}, pack:{by:'u22',at:'2026-05-04 16:00'} }] }],
      sum:19900, final:17900, files:[], comment:'',
      payments:[{ at:'2026-05-11 12:00', sum:17900, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u11', note:'', cash:false, handedAt:'2026-05-11 17:00', files:[] }],
      history:[{ at:'2026-05-04 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-05-11 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:315, num:'315', branch:'bishkek', channel:'retail',
      client:'Мээрим Касымова', phone:'0764 63 74 26',
      addr:'ул. Киевская 20', source:'Звонок',
      status:'installed', manager:'u1',
      measurer:'u17', installer:'u12', senior:'u10',
      accepted:'2026-05-05 09:00', measureAt:'2026-05-05', measureTime:'11:00', timeless:false,
      created:'2026-05-05 08:00', deadline:'2026-05-11', color:'белый',
      items:[{ w:1.19, h:1.95, qty:4, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-05-05 10:00'}, tape:{by:'u19',at:'2026-05-05 12:00'}, profile:{by:'u8',at:'2026-05-05 13:00'}, cord:{by:'u19',at:'2026-05-05 14:00'}, pack:{by:'u22',at:'2026-05-05 16:00'} }, { fabric:{by:'u20',at:'2026-05-05 10:00'}, tape:{by:'u19',at:'2026-05-05 12:00'}, profile:{by:'u8',at:'2026-05-05 13:00'}, cord:{by:'u19',at:'2026-05-05 14:00'}, pack:{by:'u22',at:'2026-05-05 16:00'} }, { fabric:{by:'u20',at:'2026-05-05 10:00'}, tape:{by:'u19',at:'2026-05-05 12:00'}, profile:{by:'u8',at:'2026-05-05 13:00'}, cord:{by:'u19',at:'2026-05-05 14:00'}, pack:{by:'u22',at:'2026-05-05 16:00'} }, { fabric:{by:'u20',at:'2026-05-05 10:00'}, tape:{by:'u19',at:'2026-05-05 12:00'}, profile:{by:'u8',at:'2026-05-05 13:00'}, cord:{by:'u19',at:'2026-05-05 14:00'}, pack:{by:'u22',at:'2026-05-05 16:00'} }] }],
      sum:39000, final:39000, files:[], comment:'',
      payments:[{ at:'2026-05-11 12:00', sum:39000, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u12', note:'', cash:false, handedAt:'2026-05-11 17:00', files:[] }],
      history:[{ at:'2026-05-05 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-05-11 12:00', who:'u12', what:'Установлено и оплачено' }] },
    { id:316, num:'316', branch:'karakol', channel:'retail',
      client:'Гулназ Алиева', phone:'0666 97 76 77',
      addr:'ул. Киевская 62', source:'Instagram',
      status:'installed', manager:'u1',
      measurer:'u4', installer:'u11', senior:'u10',
      accepted:'2026-06-09 09:00', measureAt:'2026-06-09', measureTime:'11:00', timeless:false,
      created:'2026-06-09 08:00', deadline:'2026-06-21', color:'белый',
      items:[{ w:1.55, h:2.2, qty:2, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u21',at:'2026-06-09 10:00'}, tape:{by:'u21',at:'2026-06-09 12:00'}, profile:{by:'u8',at:'2026-06-09 13:00'}, cord:{by:'u19',at:'2026-06-09 14:00'}, pack:{by:'u22',at:'2026-06-09 16:00'} }, { fabric:{by:'u21',at:'2026-06-09 10:00'}, tape:{by:'u21',at:'2026-06-09 12:00'}, profile:{by:'u8',at:'2026-06-09 13:00'}, cord:{by:'u19',at:'2026-06-09 14:00'}, pack:{by:'u22',at:'2026-06-09 16:00'} }] }],
      sum:21800, final:21800, files:[], comment:'',
      payments:[{ at:'2026-06-21 12:00', sum:21800, kind:'Полная оплата', method:'Мбанк',
                 who:'u11', note:'', cash:false, handedAt:'2026-06-21 17:00', files:[] }],
      history:[{ at:'2026-06-09 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-06-21 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:317, num:'317', branch:'manas', channel:'retail',
      client:'Нургуль Шаршеева', phone:'0602 98 45 67',
      addr:'ул. Киевская 69', source:'Рекомендация',
      status:'installed', manager:'u1',
      measurer:'u16', installer:'u11', senior:'u10',
      accepted:'2026-06-05 09:00', measureAt:'2026-06-05', measureTime:'11:00', timeless:false,
      created:'2026-06-05 08:00', deadline:'2026-06-13', color:'белый',
      items:[{ w:1.7, h:1.96, qty:4, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-06-05 10:00'}, tape:{by:'u21',at:'2026-06-05 12:00'}, profile:{by:'u8',at:'2026-06-05 13:00'}, cord:{by:'u21',at:'2026-06-05 14:00'}, pack:{by:'u22',at:'2026-06-05 16:00'} }, { fabric:{by:'u20',at:'2026-06-05 10:00'}, tape:{by:'u21',at:'2026-06-05 12:00'}, profile:{by:'u8',at:'2026-06-05 13:00'}, cord:{by:'u21',at:'2026-06-05 14:00'}, pack:{by:'u22',at:'2026-06-05 16:00'} }, { fabric:{by:'u20',at:'2026-06-05 10:00'}, tape:{by:'u21',at:'2026-06-05 12:00'}, profile:{by:'u8',at:'2026-06-05 13:00'}, cord:{by:'u21',at:'2026-06-05 14:00'}, pack:{by:'u22',at:'2026-06-05 16:00'} }, { fabric:{by:'u20',at:'2026-06-05 10:00'}, tape:{by:'u21',at:'2026-06-05 12:00'}, profile:{by:'u8',at:'2026-06-05 13:00'}, cord:{by:'u21',at:'2026-06-05 14:00'}, pack:{by:'u22',at:'2026-06-05 16:00'} }] }],
      sum:42600, final:42600, files:[], comment:'',
      payments:[{ at:'2026-06-13 12:00', sum:42600, kind:'Полная оплата', method:'Мбанк',
                 who:'u11', note:'', cash:false, handedAt:'2026-06-13 17:00', files:[] }],
      history:[{ at:'2026-06-05 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-06-13 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:318, num:'318', branch:'bishkek', channel:'retail',
      client:'Бекзат Асылбеков', phone:'0623 64 19 37',
      addr:'мкр Асанбай 101', source:'Instagram',
      status:'paid', manager:'u15',
      measurer:'u16', installer:'u12', senior:'u10',
      accepted:'2026-06-10 09:00', measureAt:'2026-06-10', measureTime:'11:00', timeless:false,
      created:'2026-06-10 08:00', deadline:'2026-06-18', color:'белый',
      items:[{ w:1.8, h:1.68, qty:3, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-06-10 10:00'}, tape:{by:'u20',at:'2026-06-10 12:00'}, profile:{by:'u8',at:'2026-06-10 13:00'}, cord:{by:'u20',at:'2026-06-10 14:00'}, pack:{by:'u22',at:'2026-06-10 16:00'} }, { fabric:{by:'u20',at:'2026-06-10 10:00'}, tape:{by:'u20',at:'2026-06-10 12:00'}, profile:{by:'u8',at:'2026-06-10 13:00'}, cord:{by:'u20',at:'2026-06-10 14:00'}, pack:{by:'u22',at:'2026-06-10 16:00'} }, { fabric:{by:'u20',at:'2026-06-10 10:00'}, tape:{by:'u20',at:'2026-06-10 12:00'}, profile:{by:'u8',at:'2026-06-10 13:00'}, cord:{by:'u20',at:'2026-06-10 14:00'}, pack:{by:'u22',at:'2026-06-10 16:00'} }] }],
      sum:29400, final:29400, files:[], comment:'',
      payments:[{ at:'2026-06-18 12:00', sum:29400, kind:'Полная оплата', method:'Наличные',
                 who:'u12', note:'', cash:true, handedAt:'2026-06-18 17:00', files:[] }],
      history:[{ at:'2026-06-10 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-06-18 12:00', who:'u12', what:'Установлено и оплачено' }] },
    { id:319, num:'319', branch:'bishkek', channel:'retail',
      client:'Нурзат Кыдыров', phone:'0720 75 61 53',
      addr:'ул. Манас 26', source:'2ГИС',
      status:'done', manager:'u1',
      measurer:'u16', installer:'u13', senior:'u10',
      accepted:'2026-06-12 09:00', measureAt:'2026-06-12', measureTime:'11:00', timeless:false,
      created:'2026-06-12 08:00', deadline:'2026-06-20', color:'белый',
      items:[{ w:1.23, h:1.62, qty:3, fabric:'Silver Series ara gri', profile:'Профиль белый', type:'Рулонная',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-06-12 10:00'}, tape:{by:'u20',at:'2026-06-12 12:00'}, profile:{by:'u8',at:'2026-06-12 13:00'}, cord:{by:'u19',at:'2026-06-12 14:00'}, pack:{by:'u22',at:'2026-06-12 16:00'} }, { fabric:{by:'u20',at:'2026-06-12 10:00'}, tape:{by:'u20',at:'2026-06-12 12:00'}, profile:{by:'u8',at:'2026-06-12 13:00'}, cord:{by:'u19',at:'2026-06-12 14:00'}, pack:{by:'u22',at:'2026-06-12 16:00'} }, { fabric:{by:'u20',at:'2026-06-12 10:00'}, tape:{by:'u20',at:'2026-06-12 12:00'}, profile:{by:'u8',at:'2026-06-12 13:00'}, cord:{by:'u19',at:'2026-06-12 14:00'}, pack:{by:'u22',at:'2026-06-12 16:00'} }] }],
      sum:19100, final:19100, files:[], comment:'',
      payments:[{ at:'2026-06-20 12:00', sum:19100, kind:'Полная оплата', method:'Наличные',
                 who:'u13', note:'', cash:true, handedAt:'2026-06-20 17:00', files:[] }],
      history:[{ at:'2026-06-12 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-06-20 12:00', who:'u13', what:'Установлено и оплачено' }] },
    { id:320, num:'320', branch:'bishkek', channel:'retail',
      client:'Айгуль Бекова', phone:'0617 23 20 43',
      addr:'мкр Асанбай 6', source:'WhatsApp',
      status:'done', manager:'u1',
      measurer:'u17', installer:'u12', senior:'u10',
      accepted:'2026-06-07 09:00', measureAt:'2026-06-07', measureTime:'11:00', timeless:false,
      created:'2026-06-07 08:00', deadline:'2026-06-13', color:'белый',
      items:[{ w:1.5, h:1.9, qty:2, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь',
               urgent:false, marks:[{ fabric:{by:'u21',at:'2026-06-07 10:00'}, tape:{by:'u20',at:'2026-06-07 12:00'}, profile:{by:'u8',at:'2026-06-07 13:00'}, cord:{by:'u21',at:'2026-06-07 14:00'}, pack:{by:'u22',at:'2026-06-07 16:00'} }, { fabric:{by:'u21',at:'2026-06-07 10:00'}, tape:{by:'u20',at:'2026-06-07 12:00'}, profile:{by:'u8',at:'2026-06-07 13:00'}, cord:{by:'u21',at:'2026-06-07 14:00'}, pack:{by:'u22',at:'2026-06-07 16:00'} }] }],
      sum:23900, final:22700, files:[], comment:'',
      payments:[{ at:'2026-06-13 12:00', sum:22700, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u12', note:'', cash:false, handedAt:'2026-06-13 17:00', files:[] }],
      history:[{ at:'2026-06-07 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-06-13 12:00', who:'u12', what:'Установлено и оплачено' }] },
    { id:321, num:'321', branch:'bishkek', channel:'retail',
      client:'Айпери Сатарова', phone:'0529 98 33 64',
      addr:'ул. Токтогула 35', source:'Instagram',
      status:'installed', manager:'u1',
      measurer:'u17', installer:'u13', senior:'u10',
      accepted:'2026-06-08 09:00', measureAt:'2026-06-08', measureTime:'11:00', timeless:false,
      created:'2026-06-08 08:00', deadline:'2026-06-20', color:'белый',
      items:[{ w:1.74, h:1.73, qty:2, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-06-08 10:00'}, tape:{by:'u21',at:'2026-06-08 12:00'}, profile:{by:'u8',at:'2026-06-08 13:00'}, cord:{by:'u20',at:'2026-06-08 14:00'}, pack:{by:'u22',at:'2026-06-08 16:00'} }, { fabric:{by:'u20',at:'2026-06-08 10:00'}, tape:{by:'u21',at:'2026-06-08 12:00'}, profile:{by:'u8',at:'2026-06-08 13:00'}, cord:{by:'u20',at:'2026-06-08 14:00'}, pack:{by:'u22',at:'2026-06-08 16:00'} }] }],
      sum:15700, final:14400, files:[], comment:'',
      payments:[{ at:'2026-06-20 12:00', sum:14400, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u13', note:'', cash:false, handedAt:'2026-06-20 17:00', files:[] }],
      history:[{ at:'2026-06-08 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-06-20 12:00', who:'u13', what:'Установлено и оплачено' }] },
    { id:322, num:'322', branch:'manas', channel:'retail',
      client:'Марат Осмонов', phone:'0522 77 40 24',
      addr:'мкр Джал 34', source:'Instagram',
      status:'paid', manager:'u1',
      measurer:'u5', installer:'u11', senior:'u10',
      accepted:'2026-07-06 09:00', measureAt:'2026-07-06', measureTime:'11:00', timeless:false,
      created:'2026-07-06 08:00', deadline:'2026-07-12', color:'белый',
      items:[{ w:1.77, h:1.56, qty:2, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе',
               urgent:false, marks:[{ fabric:{by:'u21',at:'2026-07-06 10:00'}, tape:{by:'u20',at:'2026-07-06 12:00'}, profile:{by:'u8',at:'2026-07-06 13:00'}, cord:{by:'u20',at:'2026-07-06 14:00'}, pack:{by:'u22',at:'2026-07-06 16:00'} }, { fabric:{by:'u21',at:'2026-07-06 10:00'}, tape:{by:'u20',at:'2026-07-06 12:00'}, profile:{by:'u8',at:'2026-07-06 13:00'}, cord:{by:'u20',at:'2026-07-06 14:00'}, pack:{by:'u22',at:'2026-07-06 16:00'} }] }],
      sum:17900, final:17000, files:[], comment:'',
      payments:[{ at:'2026-07-12 12:00', sum:17000, kind:'Полная оплата', method:'Мбанк',
                 who:'u11', note:'', cash:false, handedAt:'2026-07-12 17:00', files:[] }],
      history:[{ at:'2026-07-06 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-07-12 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:323, num:'323', branch:'bishkek', channel:'retail',
      client:'Азиз Турсунов', phone:'0509 74 80 34',
      addr:'ул. Киевская 61', source:'WhatsApp',
      status:'done', manager:'u1',
      measurer:'u16', installer:'u11', senior:'u10',
      accepted:'2026-07-12 09:00', measureAt:'2026-07-12', measureTime:'11:00', timeless:false,
      created:'2026-07-12 08:00', deadline:'2026-07-20', color:'белый',
      items:[{ w:1.68, h:1.76, qty:4, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе',
               urgent:false, marks:[{ fabric:{by:'u20',at:'2026-07-12 10:00'}, tape:{by:'u19',at:'2026-07-12 12:00'}, profile:{by:'u8',at:'2026-07-12 13:00'}, cord:{by:'u20',at:'2026-07-12 14:00'}, pack:{by:'u22',at:'2026-07-12 16:00'} }, { fabric:{by:'u20',at:'2026-07-12 10:00'}, tape:{by:'u19',at:'2026-07-12 12:00'}, profile:{by:'u8',at:'2026-07-12 13:00'}, cord:{by:'u20',at:'2026-07-12 14:00'}, pack:{by:'u22',at:'2026-07-12 16:00'} }, { fabric:{by:'u20',at:'2026-07-12 10:00'}, tape:{by:'u19',at:'2026-07-12 12:00'}, profile:{by:'u8',at:'2026-07-12 13:00'}, cord:{by:'u20',at:'2026-07-12 14:00'}, pack:{by:'u22',at:'2026-07-12 16:00'} }, { fabric:{by:'u20',at:'2026-07-12 10:00'}, tape:{by:'u19',at:'2026-07-12 12:00'}, profile:{by:'u8',at:'2026-07-12 13:00'}, cord:{by:'u20',at:'2026-07-12 14:00'}, pack:{by:'u22',at:'2026-07-12 16:00'} }] }],
      sum:38300, final:34500, files:[], comment:'',
      payments:[{ at:'2026-07-20 12:00', sum:34500, kind:'Полная оплата', method:'Мбанк',
                 who:'u11', note:'', cash:false, handedAt:'2026-07-20 17:00', files:[] }],
      history:[{ at:'2026-07-12 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-07-20 12:00', who:'u11', what:'Установлено и оплачено' }] },
    { id:324, num:'324', branch:'bishkek', channel:'retail',
      client:'Асель Турдубекова', phone:'0571 61 54 16',
      addr:'мкр Джал 2', source:'Instagram',
      status:'installed', manager:'u15',
      measurer:'u5', installer:'u12', senior:'u10',
      accepted:'2026-07-12 09:00', measureAt:'2026-07-12', measureTime:'11:00', timeless:false,
      created:'2026-07-12 08:00', deadline:'2026-07-21', color:'белый',
      items:[{ w:1.45, h:2.25, qty:3, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная',
               urgent:false, marks:[{ fabric:{by:'u19',at:'2026-07-12 10:00'}, tape:{by:'u19',at:'2026-07-12 12:00'}, profile:{by:'u8',at:'2026-07-12 13:00'}, cord:{by:'u20',at:'2026-07-12 14:00'}, pack:{by:'u22',at:'2026-07-12 16:00'} }, { fabric:{by:'u19',at:'2026-07-12 10:00'}, tape:{by:'u19',at:'2026-07-12 12:00'}, profile:{by:'u8',at:'2026-07-12 13:00'}, cord:{by:'u20',at:'2026-07-12 14:00'}, pack:{by:'u22',at:'2026-07-12 16:00'} }, { fabric:{by:'u19',at:'2026-07-12 10:00'}, tape:{by:'u19',at:'2026-07-12 12:00'}, profile:{by:'u8',at:'2026-07-12 13:00'}, cord:{by:'u20',at:'2026-07-12 14:00'}, pack:{by:'u22',at:'2026-07-12 16:00'} }] }],
      sum:25400, final:23400, files:[], comment:'',
      payments:[{ at:'2026-07-21 12:00', sum:23400, kind:'Полная оплата', method:'Банковский перевод',
                 who:'u12', note:'', cash:false, handedAt:'2026-07-21 17:00', files:[] }],
      history:[{ at:'2026-07-12 08:00', who:'u1', what:'Создан заказ' },
               { at:'2026-07-21 12:00', who:'u12', what:'Установлено и оплачено' }] },
    { id:325, num:'325', branch:'bishkek', channel:'retail',
      client:'Данияр Эсенов', phone:'0624 98 47 15',
      addr:'мкр 7 24', source:'WhatsApp',
      status:'rejected', manager:'u2', measurer:'u6',
      accepted:'2026-03-16 10:00', measureAt:'2026-03-16', measureTime:'', timeless:true,
      created:'2026-03-16 08:00', deadline:'2026-03-26', color:'белый',
      items:[{ w:1.07, h:2.09, qty:3, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная', urgent:false, marks:[] }],
      sum:21500, final:21500, files:[], comment:'Нашёл дешевле у конкурента',
      payments:[], history:[{ at:'2026-03-16 08:00', who:'u1', what:'Создан заказ' }] },
    { id:326, num:'326', branch:'bishkek', channel:'retail',
      client:'Бакыт Ниязов', phone:'0611 55 33 10',
      addr:'ул. Тыналиева 49', source:'Instagram',
      status:'rejected', manager:'u2', measurer:'u5',
      accepted:'2026-03-11 10:00', measureAt:'2026-03-11', measureTime:'', timeless:true,
      created:'2026-03-11 08:00', deadline:'2026-03-21', color:'белый',
      items:[{ w:1.78, h:1.88, qty:1, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь', urgent:false, marks:[] }],
      sum:14100, final:14100, files:[], comment:'Не дозвонились повторно',
      payments:[], history:[{ at:'2026-03-11 08:00', who:'u1', what:'Создан заказ' }] },
    { id:327, num:'327', branch:'bishkek', channel:'retail',
      client:'Динара Токтосунова', phone:'0521 60 12 48',
      addr:'мкр Асанбай 81', source:'WhatsApp',
      status:'rejected', manager:'u1', measurer:'u7',
      accepted:'2026-03-09 10:00', measureAt:'2026-03-09', measureTime:'', timeless:true,
      created:'2026-03-09 08:00', deadline:'2026-03-19', color:'белый',
      items:[{ w:1.62, h:1.56, qty:1, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе', urgent:false, marks:[] }],
      sum:8200, final:8200, files:[], comment:'Не дозвонились повторно',
      payments:[], history:[{ at:'2026-03-09 08:00', who:'u1', what:'Создан заказ' }] },
    { id:328, num:'328', branch:'osh', channel:'retail',
      client:'Марат Осмонов', phone:'0645 89 92 28',
      addr:'ул. Ахунбаева 106', source:'Звонок',
      status:'thinking', manager:'u15', measurer:'u6',
      accepted:'2026-04-07 10:00', measureAt:'2026-04-07', measureTime:'', timeless:true,
      created:'2026-04-07 08:00', deadline:'2026-04-17', color:'белый',
      items:[{ w:1.63, h:1.92, qty:2, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная', urgent:false, marks:[] }],
      sum:16300, final:16300, files:[], comment:'Выбрал другой материал',
      payments:[], history:[{ at:'2026-04-07 08:00', who:'u1', what:'Создан заказ' }] },
    { id:329, num:'329', branch:'manas', channel:'retail',
      client:'Асель Турдубекова', phone:'0617 20 13 15',
      addr:'мкр Джал 82', source:'2ГИС',
      status:'rejected', manager:'u1', measurer:'u6',
      accepted:'2026-04-19 10:00', measureAt:'2026-04-19', measureTime:'', timeless:true,
      created:'2026-04-19 08:00', deadline:'2026-04-29', color:'белый',
      items:[{ w:1.6, h:1.9, qty:1, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе', urgent:false, marks:[] }],
      sum:9800, final:9800, files:[], comment:'Дорого, думает',
      payments:[], history:[{ at:'2026-04-19 08:00', who:'u1', what:'Создан заказ' }] },
    { id:330, num:'330', branch:'osh', channel:'retail',
      client:'Айпери Сатарова', phone:'0501 68 18 74',
      addr:'ул. Киевская 12', source:'Звонок',
      status:'rejected', manager:'u1', measurer:'u16',
      accepted:'2026-04-20 10:00', measureAt:'2026-04-20', measureTime:'', timeless:true,
      created:'2026-04-20 08:00', deadline:'2026-04-30', color:'белый',
      items:[{ w:1.02, h:1.87, qty:1, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная', urgent:false, marks:[] }],
      sum:5000, final:5000, files:[], comment:'Выбрал другой материал',
      payments:[], history:[{ at:'2026-04-20 08:00', who:'u1', what:'Создан заказ' }] },
    { id:331, num:'331', branch:'bishkek', channel:'retail',
      client:'Медер Жумагулов', phone:'0735 73 58 19',
      addr:'мкр 7 117', source:'2ГИС',
      status:'rejected', manager:'u1', measurer:'u7',
      accepted:'2026-05-18 10:00', measureAt:'2026-05-18', measureTime:'', timeless:true,
      created:'2026-05-18 08:00', deadline:'2026-05-28', color:'белый',
      items:[{ w:1.68, h:1.66, qty:1, fabric:'Silver series Krem', profile:'Профиль белый', type:'Рулонная', urgent:false, marks:[] }],
      sum:8900, final:8900, files:[], comment:'Выбрал другой материал',
      payments:[], history:[{ at:'2026-05-18 08:00', who:'u1', what:'Создан заказ' }] },
    { id:332, num:'332', branch:'bishkek', channel:'retail',
      client:'Данияр Эсенов', phone:'0568 11 71 17',
      addr:'мкр 7 35', source:'Instagram',
      status:'rejected', manager:'u15', measurer:'u4',
      accepted:'2026-05-09 10:00', measureAt:'2026-05-09', measureTime:'', timeless:true,
      created:'2026-05-09 08:00', deadline:'2026-05-19', color:'белый',
      items:[{ w:1.12, h:1.68, qty:3, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе', urgent:false, marks:[] }],
      sum:18300, final:18300, files:[], comment:'Выбрал другой материал',
      payments:[], history:[{ at:'2026-05-09 08:00', who:'u1', what:'Создан заказ' }] },
    { id:333, num:'333', branch:'bishkek', channel:'retail',
      client:'Талант Орозбеков', phone:'0602 49 20 70',
      addr:'ул. Ахунбаева 38', source:'Рекомендация',
      status:'rejected', manager:'u1', measurer:'u17',
      accepted:'2026-05-18 10:00', measureAt:'2026-05-18', measureTime:'', timeless:true,
      created:'2026-05-18 08:00', deadline:'2026-05-28', color:'белый',
      items:[{ w:1.41, h:1.83, qty:2, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная', urgent:false, marks:[] }],
      sum:13400, final:13400, files:[], comment:'Не дозвонились повторно',
      payments:[], history:[{ at:'2026-05-18 08:00', who:'u1', what:'Создан заказ' }] },
    { id:334, num:'334', branch:'bishkek', channel:'retail',
      client:'Айнура Кубанова', phone:'0546 28 77 43',
      addr:'ул. Тыналиева 17', source:'Звонок',
      status:'rejected', manager:'u15', measurer:'u7',
      accepted:'2026-06-17 10:00', measureAt:'2026-06-17', measureTime:'', timeless:true,
      created:'2026-06-17 08:00', deadline:'2026-06-27', color:'белый',
      items:[{ w:1.17, h:2.16, qty:1, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная', urgent:false, marks:[] }],
      sum:8100, final:8100, files:[], comment:'Не устроил срок',
      payments:[], history:[{ at:'2026-06-17 08:00', who:'u1', what:'Создан заказ' }] },
    { id:381, num:'381', branch:'bishkek', channel:'retail',
      client:'Азиз Турсунов', phone:'0581 10 72 97',
      addr:'мкр 7 52', source:'2ГИС',
      status:'thinking', manager:'u15', measurer:'u4',
      accepted:'2026-06-06 10:00', measureAt:'2026-06-06', measureTime:'', timeless:true,
      created:'2026-06-06 08:00', deadline:'2026-06-16', color:'белый',
      items:[{ w:1.19, h:2.13, qty:2, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь', urgent:false, marks:[] }],
      sum:21300, final:21300, files:[], comment:'Дорого, думает',
      payments:[], history:[{ at:'2026-06-06 08:00', who:'u1', what:'Создан заказ' }] },
    { id:382, num:'382', branch:'bishkek', channel:'retail',
      client:'Динара Токтосунова', phone:'0561 35 11 47',
      addr:'мкр Асанбай 48', source:'Instagram',
      status:'rejected', manager:'u2', measurer:'u6',
      accepted:'2026-06-14 10:00', measureAt:'2026-06-14', measureTime:'', timeless:true,
      created:'2026-06-14 08:00', deadline:'2026-06-24', color:'белый',
      items:[{ w:1.1, h:1.73, qty:2, fabric:'Blackout antrasit', profile:'Профиль антрацит', type:'День-ночь', urgent:false, marks:[] }],
      sum:16000, final:16000, files:[], comment:'Не дозвонились повторно',
      payments:[], history:[{ at:'2026-06-14 08:00', who:'u1', what:'Создан заказ' }] },
    { id:337, num:'337', branch:'bishkek', channel:'retail',
      client:'Гулназ Алиева', phone:'0646 91 29 41',
      addr:'мкр Асанбай 56', source:'Звонок',
      status:'rejected', manager:'u2', measurer:'u4',
      accepted:'2026-07-05 10:00', measureAt:'2026-07-05', measureTime:'', timeless:true,
      created:'2026-07-05 08:00', deadline:'2026-07-15', color:'белый',
      items:[{ w:1.6, h:2.1, qty:2, fabric:'Blackout kahve', profile:'Профиль коричневый', type:'Рулонная', urgent:false, marks:[] }],
      sum:21500, final:21500, files:[], comment:'Не устроил срок',
      payments:[], history:[{ at:'2026-07-05 08:00', who:'u1', what:'Создан заказ' }] },
    { id:383, num:'383', branch:'karakol', channel:'retail',
      client:'Жылдыз Абдырахманова', phone:'0541 16 62 67',
      addr:'ул. Абдрахманова 97', source:'WhatsApp',
      status:'rejected', manager:'u15', measurer:'u17',
      accepted:'2026-07-16 10:00', measureAt:'2026-07-16', measureTime:'', timeless:true,
      created:'2026-07-16 08:00', deadline:'2026-07-26', color:'белый',
      items:[{ w:1.32, h:2.11, qty:3, fabric:'Silver series Krem', profile:'Профиль белый', type:'Вертикальная', urgent:false, marks:[] }],
      sum:21700, final:21700, files:[], comment:'Не устроил срок',
      payments:[], history:[{ at:'2026-07-16 08:00', who:'u1', what:'Создан заказ' }] },
    { id:339, num:'339', branch:'bishkek', channel:'retail',
      client:'Бакыт Ниязов', phone:'0630 93 43 61',
      addr:'ул. Байтик Баатыра 39', source:'Рекомендация',
      status:'rejected', manager:'u15', measurer:'u16',
      accepted:'2026-07-18 10:00', measureAt:'2026-07-18', measureTime:'', timeless:true,
      created:'2026-07-18 08:00', deadline:'2026-07-28', color:'белый',
      items:[{ w:1.1, h:1.83, qty:2, fabric:'Diamond Series Beyaz', profile:'Профиль белый', type:'Плиссе', urgent:false, marks:[] }],
      sum:13000, final:13000, files:[], comment:'Дорого, думает',
      payments:[], history:[{ at:'2026-07-18 08:00', who:'u1', what:'Создан заказ' }] },
  ];

  /* ── складские документы ──────────────────────────
     type: po | receipt | transfer | invent | writeoff | ret | opt
     lines: [{ good, qty, price, was, fact }]                       */
  const docs = [
    { id:'d1', type:'receipt', num:'12', date:'2026-08-03', to:'kokjar', party:'sup1',
      who:'Дамира', status:'posted', cur:'KGS',
      lines:[{ good:'g01', qty:100, price:78 }] },

    { id:'d2', type:'receipt', num:'11', date:'2026-08-01', to:'tunguch', party:'sup2',
      who:'Дамира', status:'posted', cur:'USD', rate:87.4,
      lines:[{ good:'g10', qty:1000, price:3 }, { good:'g09', qty:1000, price:5 },
             { good:'g11', qty:5000, price:1 }, { good:'g13', qty:250, price:11 },
             { good:'g12', qty:500,  price:1 }, { good:'g08', qty:100, price:128 }] },

    { id:'d3', type:'receipt', num:'10', date:'2026-07-20', to:'tunguch', party:'sup1',
      who:'Дамира', status:'posted', cur:'KGS',
      lines:[{ good:'g02', qty:960, price:78 }, { good:'g03', qty:240, price:78 },
             { good:'g01', qty:5880, price:78 }] },

    { id:'d4', type:'transfer', num:'05', date:'2026-08-03', from:'tunguch', to:'ceh',
      who:'Давлес', status:'posted',
      lines:[{ good:'g01', qty:200 }, { good:'g07', qty:39 }] },

    { id:'d5', type:'transfer', num:'04', date:'2026-07-20', from:'tunguch', to:'ceh',
      who:'Давлес', status:'posted',
      lines:[{ good:'g08', qty:60 }, { good:'g14', qty:12 }] },

    { id:'do11', type:'opt', num:'00011', date:'2026-03-14', time:'12:00',
      from:'tunguch', party:'b3', who:'Арген Баетов', status:'posted', disc:8,
      paid:0, note:'', lines:[{ good:'g11', qty:134, price:3 }, { good:'g05', qty:283, price:290 }] },
    { id:'do12', type:'opt', num:'00012', date:'2026-04-09', time:'12:00',
      from:'tunguch', party:'b1', who:'Арген Баетов', status:'posted', disc:15,
      paid:0, note:'', lines:[{ good:'g01', qty:195, price:110 }, { good:'g14', qty:112, price:210 }] },
    { id:'do13', type:'opt', num:'00013', date:'2026-04-22', time:'12:00',
      from:'tunguch', party:'b3', who:'Арген Баетов', status:'posted', disc:15,
      paid:0, note:'', lines:[{ good:'g13', qty:242, price:18 }, { good:'g01', qty:271, price:110 }] },
    { id:'do14', type:'opt', num:'00014', date:'2026-05-17', time:'12:00',
      from:'tunguch', party:'b1', who:'Арген Баетов', status:'posted', disc:8,
      paid:0, note:'', lines:[{ good:'g13', qty:47, price:18 }, { good:'g05', qty:72, price:290 }] },
    { id:'do15', type:'opt', num:'00015', date:'2026-06-06', time:'12:00',
      from:'tunguch', party:'b2', who:'Арген Баетов', status:'posted', disc:15,
      paid:0, note:'', lines:[{ good:'g05', qty:55, price:290 }, { good:'g11', qty:277, price:3 }] },
    { id:'do16', type:'opt', num:'00016', date:'2026-06-24', time:'12:00',
      from:'tunguch', party:'b2', who:'Арген Баетов', status:'posted', disc:15,
      paid:0, note:'', lines:[{ good:'g05', qty:159, price:290 }, { good:'g11', qty:190, price:3 }] },
    { id:'do17', type:'opt', num:'00017', date:'2026-07-11', time:'12:00',
      from:'tunguch', party:'b3', who:'Арген Баетов', status:'posted', disc:15,
      paid:0, note:'', lines:[{ good:'g01', qty:182, price:110 }, { good:'g14', qty:248, price:210 }] },

    /* ── третий канал: оптовые продажи ──
       paid — сколько уже оплачено по этому документу.
       Долг покупателя = сумма минус оплачено, оплата бывает частичной. */
    { id:'d7', type:'opt', num:'00006', date:'2026-07-15', time:'11:20', from:'tunguch', party:'b1',
      who:'Арген Баетов', status:'posted', disc:12, paid:45500, note:'',
      lines:[{ good:'g01', qty:400, price:110 }, { good:'g11', qty:500, price:3 }] },

    { id:'d8', type:'opt', num:'00007', date:'2026-07-28', time:'16:05', from:'tunguch', party:'b2',
      who:'Камила', status:'posted', disc:8, paid:0, note:'Отгрузка в Каракол, оплата по факту',
      lines:[{ good:'g05', qty:60, price:290 }, { good:'g14', qty:20, price:210 }] },

    { id:'d9', type:'opt', num:'00005', date:'2026-06-20', time:'09:40', from:'tunguch', party:'b2',
      who:'Камила', status:'posted', disc:8, paid:0, note:'',
      lines:[{ good:'g13', qty:500, price:18 }, { good:'g10', qty:650, price:6 }] },

    { id:'d10', type:'opt', num:'00008', date:'2026-08-01', time:'14:12', from:'tunguch', party:'b3',
      who:'Арген Баетов', status:'posted', disc:15, paid:17800, note:'Частичная оплата 02.08',
      lines:[{ good:'g06', qty:100, price:720 }, { good:'g14', qty:20, price:210 },
             { good:'g02', qty:180, price:110 }] },

    { id:'d6', type:'po', num:'03', date:'2026-08-02', to:'tunguch', party:'sup2',
      who:'Арген Баетов', status:'wait', cur:'USD', rate:87.4, eta:'2026-08-20',
      lines:[{ good:'g06', qty:300, price:6.3 }, { good:'g15', qty:6, price:112 }] },
  ];

  /* ── денежные операции (заготовка под «Финансы») ── */
  /* ── наши реквизиты: подставляются в счёт и АВР ── */
  const COMPANY = {
    name:'ОсОО «Kasymov»',
    inn:'01234199710123', okpo:'29481507',
    addr:'Кыргызская Республика, г. Бишкек, ул. Тунгуч 36/1',
    bank:'ОАО «Оптима Банк»', bik:'109018', acc:'1091820159480117',
    phone:'+996 555 80 41 26', dir:'Баетов А. К.', buh:'Ким В. А.',
  };

  /* ── счета-фактуры ────────────────────────────────
     Сам счёт выписывается на сайте налоговой (ЭСФ), а к нам
     загружается готовым файлом. Поэтому:
     status: requested — замерщик запросил, ждёт бухгалтера
             issued    — бухгалтер загрузил файл ЭСФ
     files: [{name, at, by, url, kind:'inv'|'akt'}] */
  const invoices = [
    { id:'inv1', num:'1', date:'2026-06-18', order:340, status:'issued',
      requestedBy:'u4', requestedAt:'2026-06-17 14:20',
      issuedBy:'u18', issuedAt:'2026-06-18 09:40', aktAt:'2026-07-31 11:00',
      files:[{ name:'ЭСФ-0000241-2026.pdf', at:'2026-06-18 09:40', by:'u18', url:null, kind:'inv' },
             { name:'АВР-241-подписан.pdf',  at:'2026-07-31 11:00', by:'u18', url:null, kind:'akt' }],
      company:{ name:'ОсОО «Ак-Кеме Групп»', inn:'02508201910086', addr:'г. Бишкек, ул. Ажыбек Батыра 3/1',
                bank:'ОАО «РСК Банк»', acc:'1298300019477201', dir:'Асанбеков Ж. Т.', phone:'0705444403' },
      lines:[{ name:'Рулонные шторы Blackout antrasit, 1.7×2.3 м', qty:2, price:12500 }] },

    { id:'inv2', num:'2', date:'2026-06-22', order:343, status:'issued',
      requestedBy:'u6', requestedAt:'2026-06-22 10:05',
      issuedBy:'u18', issuedAt:'2026-06-22 15:10', aktAt:null,
      files:[{ name:'ЭСФ-0000258-2026.pdf', at:'2026-06-22 15:10', by:'u18', url:null, kind:'inv' }],
      company:{ name:'ОсОО «Манас Строй»', inn:'01712201710044', addr:'г. Бишкек, ул. Манас 89',
                bank:'ЗАО «Демир Банк»', acc:'1180000401255633', dir:'Бекболотов Т. А.', phone:'0990220577' },
      lines:[{ name:'Рулонные шторы Silver series Krem, 1.3×1.9 м', qty:4, price:7900 }] },

    { id:'inv3', num:'3', date:'2026-07-08', order:344, status:'issued',
      requestedBy:'u5', requestedAt:'2026-07-08 09:15',
      issuedBy:'u18', issuedAt:'2026-07-08 12:30', aktAt:null,
      files:[{ name:'ЭСФ-0000303-2026.pdf', at:'2026-07-08 12:30', by:'u18', url:null, kind:'inv' }],
      company:{ name:'ИП Кыдыралиева Д. С.', inn:'21806199200517', addr:'г. Бишкек, Кок-Жар, ул. Кийизбаева 26А',
                bank:'ОАО «Оптима Банк»', acc:'1091820133410288', dir:'Кыдыралиева Д. С.', phone:'0501951001' },
      lines:[{ name:'Рулонные шторы Blackout kahve, 1.5×2.0 м', qty:3, price:9600 }] },

    { id:'inv4', num:null, date:null, order:357, status:'requested',
      requestedBy:'u5', requestedAt:'2026-08-03 11:40',
      issuedBy:null, issuedAt:null, aktAt:null, files:[],
      company:{ name:'ОсОО «Апрель Девелопмент»', inn:'00904202110073', addr:'г. Бишкек, 7 апреля 2-27-19',
                bank:'ОАО «Айыл Банк»', acc:'1350100019930845', dir:'Мамытов А. Б.', phone:'0702882073' },
      lines:[{ name:'Шторы плиссе Blackout antrasit, 0.42×1.305 м', qty:2, price:2100 },
             { name:'Шторы плиссе Blackout antrasit, 0.665×1.405 м', qty:2, price:2340 }] },
  ];

  /* ── кассы и счета ────────────────────────────────
     start — остаток на начало ведения учёта в системе */
  const ACCOUNTS = [
    { id:'cash',  name:'Касса (наличные)', short:'Касса',  start:0  },
    { id:'mbank', name:'Мбанк',            short:'Мбанк',  start:0  },
    { id:'bank',  name:'Расчётный счёт',   short:'Р/счёт', start:0 },
  ];
  /* каким способом приняли деньги — на какой счёт легли */
  const ACC_BY_METHOD = { 'Наличные':'cash', 'Мбанк':'mbank', 'О!Деньги':'mbank',
                          'Банковский перевод':'bank', 'Перечисление':'bank' };

  const EXP_CATS = ['Закуп материалов','Зарплата','Аренда','Транспорт','Реклама','Налоги','Прочее'];

  /* ── расходы: то, что реально выплачено ── */
  const expenses = [
    { id:'e031', date:'2026-03-05', cat:'Аренда',           acc:'bank',  sum:45000, who:'u14', note:'Цех и склад Тунгуч' },
    { id:'e032', date:'2026-03-25', cat:'Зарплата',         acc:'cash',  sum:52000,  who:'u14', note:'Зарплата за месяц' },
    { id:'e033', date:'2026-03-10', cat:'Реклама',          acc:'mbank', sum:12000,   who:'u1',  note:'Instagram и 2ГИС' },
    { id:'e034', date:'2026-03-18', cat:'Транспорт',        acc:'cash',  sum:7200,   who:'u10', note:'Бензин, доставка' },
    { id:'e035', date:'2026-03-15', cat:'Закуп материалов', acc:'bank',  sum:147000, who:'u14', note:'Оплата поставщику' },
    { id:'e041', date:'2026-04-05', cat:'Аренда',           acc:'bank',  sum:45000, who:'u14', note:'Цех и склад Тунгуч' },
    { id:'e042', date:'2026-04-25', cat:'Зарплата',         acc:'cash',  sum:56000,  who:'u14', note:'Зарплата за месяц' },
    { id:'e043', date:'2026-04-10', cat:'Реклама',          acc:'mbank', sum:14000,   who:'u1',  note:'Instagram и 2ГИС' },
    { id:'e044', date:'2026-04-18', cat:'Транспорт',        acc:'cash',  sum:8100,   who:'u10', note:'Бензин, доставка' },
    { id:'e045', date:'2026-04-15', cat:'Закуп материалов', acc:'bank',  sum:161000, who:'u14', note:'Оплата поставщику' },
    { id:'e051', date:'2026-05-05', cat:'Аренда',           acc:'bank',  sum:45000, who:'u14', note:'Цех и склад Тунгуч' },
    { id:'e052', date:'2026-05-25', cat:'Зарплата',         acc:'cash',  sum:58000,  who:'u14', note:'Зарплата за месяц' },
    { id:'e053', date:'2026-05-10', cat:'Реклама',          acc:'mbank', sum:15000,   who:'u1',  note:'Instagram и 2ГИС' },
    { id:'e054', date:'2026-05-18', cat:'Транспорт',        acc:'cash',  sum:7800,   who:'u10', note:'Бензин, доставка' },
    { id:'e055', date:'2026-05-15', cat:'Закуп материалов', acc:'bank',  sum:149000, who:'u14', note:'Оплата поставщику' },
    { id:'e061', date:'2026-06-05', cat:'Аренда',           acc:'bank',  sum:45000, who:'u14', note:'Цех и склад Тунгуч' },
    { id:'e062', date:'2026-06-25', cat:'Зарплата',         acc:'cash',  sum:61000,  who:'u14', note:'Зарплата за месяц' },
    { id:'e063', date:'2026-06-10', cat:'Реклама',          acc:'mbank', sum:18000,   who:'u1',  note:'Instagram и 2ГИС' },
    { id:'e064', date:'2026-06-18', cat:'Транспорт',        acc:'cash',  sum:8600,   who:'u10', note:'Бензин, доставка' },
    { id:'e065', date:'2026-06-15', cat:'Закуп материалов', acc:'bank',  sum:147000, who:'u14', note:'Оплата поставщику' },
    { id:'e071', date:'2026-07-05', cat:'Аренда',           acc:'bank',  sum:45000, who:'u14', note:'Цех и склад Тунгуч' },
    { id:'e072', date:'2026-07-25', cat:'Зарплата',         acc:'cash',  sum:62000,  who:'u14', note:'Зарплата за месяц' },
    { id:'e073', date:'2026-07-10', cat:'Реклама',          acc:'mbank', sum:16000,   who:'u1',  note:'Instagram и 2ГИС' },
    { id:'e074', date:'2026-07-18', cat:'Транспорт',        acc:'cash',  sum:8500,   who:'u10', note:'Бензин, доставка' },
    { id:'e075', date:'2026-07-15', cat:'Закуп материалов', acc:'bank',  sum:155000, who:'u14', note:'Оплата поставщику' },
    { id:'e5', date:'2026-08-01', cat:'Реклама',          acc:'mbank', sum:16000,  who:'u1',  note:'Instagram, таргет' },
    { id:'e6', date:'2026-08-02', cat:'Аренда',           acc:'bank',  sum:45000,  who:'u14', note:'Цех и склад Тунгуч, август' },
    { id:'e7', date:'2026-08-02', cat:'Закуп материалов', acc:'bank',  sum:120000, who:'u14', note:'Оплата «Роллетные системы КР»', party:'sup3' },
  ];

  /* ── переводы между своими кассами ──
     Снять с расчётного счёта в кассу, положить наличные на счёт. */
  const transfers = [
    { id:'t1', date:'2026-07-25', from:'bank', to:'cash', sum:250000, who:'u14', note:'Снятие на зарплату' },
    { id:'t2', date:'2026-08-01', from:'mbank', to:'bank', sum:80000,  who:'u14', note:'Перевод выручки на счёт' },
  ];

  /* ── премии, штрафы и выплаты зарплаты ── */
  const bonuses = [
    { id:'b1', date:'2026-08-02', who:'u5',  sum:2000, note:'Продал 3 заказа за неделю' },
    { id:'b2', date:'2026-08-01', who:'u19', sum:1500, note:'Закрыл срочный заказ в срок' },
  ];
  const fines = [
    { id:'p1', date:'2026-08-02', who:'u12', sum:1000, note:'Не сдал деньги на следующий день' },
    { id:'p2', date:'2026-07-30', who:'u20', sum:500,  note:'Брак при клейке ленты' },
  ];
  const payouts = [
    { id:'v1', date:'2026-08-01', who:'u19', sum:3000, note:'Аванс' },
    { id:'v2', date:'2026-08-01', who:'u20', sum:2500, note:'Аванс' },
  ];

  const finance = {
    revenueMonth: 189500, profitMonth: 42480, debt: 2300000, balance: 1864600,
    rateUSD: 87.4,
  };

  const seed = { goods, docs, orders, invoices, expenses, transfers, bonuses, fines, payouts, suppliers, partners, porders, buyers, finance,
                 meta:{ today:'2026-08-03' } };

  /* ══════════════════════════════════════════════════
     УТИЛИТЫ
     ══════════════════════════════════════════════════ */

  const clone = o => JSON.parse(JSON.stringify(o));
  const fmt   = n => new Intl.NumberFormat('ru-RU').format(Math.round(n));
  /* количества: до сотых — метраж ткани нельзя округлять до целого */
  const qfmt  = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits:2 })
                       .format(Math.round(n * 100) / 100);
  const money = n => fmt(n) + ' сом';

  function dmy(iso){
    if(!iso) return '—';
    const [y,m,d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
  function today(){ return new Date('2026-08-03T09:00:00'); }
  function todayISO(){ return '2026-08-03'; }

  function daysLeft(iso){
    return Math.round((new Date(iso) - today()) / 864e5);
  }
  function deadlineChip(iso, status){
    const d = daysLeft(iso);
    if(['installed','paid','done','rejected'].includes(status)) return { cls:'gy', text:dmy(iso) };
    if(d < 0)  return { cls:'rd', text:`просрочен на ${-d} дн.` };
    if(d <= 3) return { cls:'am', text:`осталось ${d} дн.` };
    return { cls:'gy', text:dmy(iso) };
  }

  /* ── работа с остатками ───────────────────────── */
  const total = g => LOC_IDS.reduce((s,l) => s + (g.q[l] || 0), 0);

  /* Резерв: материалы, обещанные заказам, которые ещё не сданы */
  /* материал считается обещанным с момента подтверждения заказа
     и до момента, когда изделие уехало на установку */
  const RESERVING = ['ordered', 'toShop', 'ready'];
  function reserved(state){
    const r = {};
    state.orders.filter(o => RESERVING.includes(o.status)).forEach(o =>
      materials(o).forEach(m => { r[m.name] = +((r[m.name] || 0) + m.qty).toFixed(2); }));
    return r;
  }

  /* Заказано у поставщиков и ещё не пришло */
  function onOrder(state){
    const r = {};
    state.docs.filter(d => d.type === 'po' && d.status === 'wait').forEach(d =>
      d.lines.forEach(l => { r[l.good] = (r[l.good] || 0) + l.qty; }));
    return r;
  }

  /* Хватает ли материалов на заказ: [{name, qty, unit, have, ok}] */
  function checkStock(o, goodsList){
    return materials(o).map(n => {
      const g = goodsList.find(x => x.name === n.name);
      const have = g ? total(g) : 0;
      return { ...n, have, ok: have >= n.qty, id: g ? g.id : null, missing: !g };
    });
  }

  /* Долг покупателя = сумма неоплаченных остатков по его продажам.
     Единственный источник правды — документы, отдельного сальдо не держим. */
  function docTotal(d){ return d.lines.reduce((a,l) => a + l.qty * (l.price || 0), 0); }

  function buyerDebt(state, id){
    return state.docs
      .filter(d => d.type === 'opt' && d.party === id)
      .reduce((a,d) => a + Math.max(0, docTotal(d) - (d.paid || 0)), 0);
  }

  /* пересчёт сальдо всех покупателей — вызывать после любой операции */
  function syncBuyers(state){
    state.buyers.forEach(b => { b.balance = buyerDebt(state, b.id); });
    return state;
  }

  /* Средневзвешенная себестоимость при поступлении */
  function newCost(g, addQty, addPrice){
    const have = total(g);
    if(have + addQty <= 0) return addPrice;
    return +(((have * g.cost) + (addQty * addPrice)) / (have + addQty)).toFixed(2);
  }

  /* ── деньги по заказу ─────────────────────────── */
  /* sum — сколько посчитали клиенту, final — сколько берём после скидки */
  const orderTotal = o => Math.round(o.final != null ? o.final : o.sum);
  const orderDisc  = o => (o.sum && o.final != null && o.final < o.sum)
                          ? Math.round((1 - o.final / o.sum) * 1000) / 10 : 0;
  const orderPaid  = o => (o.payments || []).reduce((a,p) => a + p.sum, 0);
  const orderOwe   = o => Math.max(0, orderTotal(o) - orderPaid(o));

  /* Наличные, принятые установщиком и ещё не сданные в кассу.
     Пока handedAt пуст — деньги числятся на человеке, а не в кассе. */
  function cashOnHand(state){
    const byMan = {};
    state.orders.forEach(o => (o.payments || []).forEach(p => {
      if(!p.cash || p.handedAt) return;
      const who = p.who;
      if(!byMan[who]) byMan[who] = { who, sum:0, items:[] };
      byMan[who].sum += p.sum;
      byMan[who].items.push({ order:o, pay:p });
    }));
    return Object.values(byMan);
  }

  const invSum = inv => (inv.lines || []).reduce((a,l) => a + l.qty * l.price, 0);

  /* сумма прописью — без неё счёт в Кыргызстане не принимают */
  function words(n){
    n = Math.round(n);
    const s = n % 100, k = Math.floor(n / 1000);
    const one = ['','один','два','три','четыре','пять','шесть','семь','восемь','девять'];
    const oneF = ['','одна','две','три','четыре','пять','шесть','семь','восемь','девять'];
    const ten = ['десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать',
                 'шестнадцать','семнадцать','восемнадцать','девятнадцать'];
    const ten2 = ['','','двадцать','тридцать','сорок','пятьдесят','шестьдесят','семьдесят','восемьдесят','девяносто'];
    const hun = ['','сто','двести','триста','четыреста','пятьсот','шестьсот','семьсот','восемьсот','девятьсот'];

    function trio(v, fem){
      const o = fem ? oneF : one, out = [];
      out.push(hun[Math.floor(v / 100)]);
      const r = v % 100;
      if(r >= 10 && r < 20) out.push(ten[r - 10]);
      else { out.push(ten2[Math.floor(r / 10)]); out.push(o[r % 10]); }
      return out.filter(Boolean).join(' ');
    }
    function form(v, a, b, c){
      const r10 = v % 10, r100 = v % 100;
      if(r100 >= 11 && r100 <= 14) return c;
      if(r10 === 1) return a;
      if(r10 >= 2 && r10 <= 4) return b;
      return c;
    }
    const parts = [];
    const mil = Math.floor(n / 1e6), th = Math.floor(n / 1000) % 1000, rest = n % 1000;
    if(mil)  parts.push(trio(mil) + ' ' + form(mil, 'миллион','миллиона','миллионов'));
    if(th)   parts.push(trio(th, true) + ' ' + form(th, 'тысяча','тысячи','тысяч'));
    if(rest) parts.push(trio(rest));
    if(!parts.length) parts.push('ноль');
    const t = parts.join(' ');
    return t.charAt(0).toUpperCase() + t.slice(1) + ' ' + form(n, 'сом','сома','сомов') + ' 00 тыйын';
  }

  /* ══ ДЕНЬГИ: поступления и выплаты ══════════════
     Наличные, принятые сотрудником, попадают в кассу только
     после сдачи — до этого они числятся на человеке. */
  function moneyIn(state){
    const out = [];
    state.orders.forEach(o => (o.payments || []).forEach(p => {
      const acc = ACC_BY_METHOD[p.method] || 'cash';
      if(p.cash && !p.handedAt) return;              // ещё на руках
      out.push({ date:(p.cash ? p.handedAt : p.at).slice(0,10), sum:p.sum, acc,
                 src:'Розница', who:p.who, note:`Заказ #${o.num} · ${o.addr}`, order:o.id });
    }));
    state.docs.filter(d => d.type === 'opt' && d.paid > 0).forEach(d => {
      const b = state.buyers.find(x => x.id === d.party);
      out.push({ date:d.date, sum:d.paid, acc:'bank', src:'Опт', who:d.who,
                 note:`Продажа №${d.num} · ${b ? b.name : ''}` });
    });
    return out.sort((a,b) => b.date.localeCompare(a.date));
  }

  function moneyOut(state){
    return (state.expenses || []).map(e => ({ ...e, date:e.date }))
      .sort((a,b) => b.date.localeCompare(a.date));
  }

  /* остаток по каждой кассе */
  function balances(state){
    const res = {};
    ACCOUNTS.forEach(a => res[a.id] = a.start);
    moneyIn(state).forEach(x => res[x.acc] = (res[x.acc] || 0) + x.sum);
    moneyOut(state).forEach(x => res[x.acc] = (res[x.acc] || 0) - x.sum);
    (state.transfers || []).forEach(t => {
      res[t.from] = (res[t.from] || 0) - t.sum;
      res[t.to]   = (res[t.to]   || 0) + t.sum;
    });
    return res;
  }

  /* себестоимость материалов, ушедших в заказ */
  function orderCost(o, goodsList){
    return checkStock(o, goodsList).reduce((a,n) => {
      const g = goodsList.find(x => x.name === n.name);
      return a + n.qty * (g ? g.cost : 0);
    }, 0);
  }

  /* ══ ЗАРПЛАТНАЯ ВЕДОМОСТЬ ══════════════════════
     Цех — сдельно по галочкам, остальные — по своим правилам. */
  function payroll(state, from, to){
    const inR = d => { const x = (d || '').slice(0,10); return x >= from && x <= to; };
    const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5) + 1);
    const rows = {};
    const add = (s, part, sum, note) => {
      if(!rows[s.id]) rows[s.id] = { id:s.id, name:s.name, role:s.role,
        roleName:ROLES[s.role].label, parts:[], salary:0, piece:0, bonus:0, fine:0, paid:0, per:null };
      rows[s.id][part] += sum;
      if(sum) rows[s.id].parts.push({ part, sum, note });
    };

    /* оклад — пропорционально длине периода в месяце (менеджерам оклад из PAY, ниже) */
    STAFF.forEach(s => { if(s.salary && s.role !== 'manager')
      add(s, 'salary', Math.round(s.salary * Math.min(1, days / 30)), 'оклад'); });

    /* цех — сдельно по галочкам */
    [...byRole('shop'), ...byRole('packer')].forEach(s => {
      const per = {}; let sum = 0, qty = 0;
      state.orders.forEach(o => o.items.forEach(it => (it.marks || []).forEach(m =>
        OPS.forEach(op => {
          const e = m[op.key];
          if(!e || e.by !== s.id || !inR(e.at)) return;
          per[op.key] = (per[op.key] || 0) + 1; qty++; sum += op.rate;
        }))));
      if(qty){ add(s, 'piece', sum, `${qty} операций сдельно`); rows[s.id].per = per; }
    });

    /* замерщики — выезд плюс метраж по ставке, зависящей от скидки заказа */
    byRole('measurer').forEach(s => {
      const l = state.orders.filter(o => o.measurer === s.id && o.items.length && inR(o.measureAt));
      if(!l.length) return;
      let sum = l.length * PAY.measurer.trip;
      l.forEach(o => { const area = o.items.reduce((x,i) => x + i.w * i.h * i.qty, 0);
        sum += Math.round(area * measurerRate(orderDisc(o))); });
      add(s, 'piece', Math.round(sum),
          `${l.length} выездов × ${PAY.measurer.trip} + м² по ставке скидки (${PAY.measurer.m2byDisc.d0}/${PAY.measurer.m2byDisc.d10}/${PAY.measurer.m2byDisc.d15}/${PAY.measurer.m2byDisc.d20})`);
    });

    /* менеджеры — оклад + процент от закрытых заказов (бонус начисляется отдельно) */
    byRole('manager').forEach(s => {
      add(s, 'salary', Math.round((PAY.manager.salary || 0) * Math.min(1, days / 30)), 'оклад');
      const l = state.orders.filter(o => o.manager === s.id &&
        ['installed','paid','done'].includes(o.status) && inR(o.deadline));
      if(l.length){
        const rev = l.reduce((a,o) => a + orderTotal(o), 0);
        add(s, 'piece', Math.round(rev * PAY.manager.pct / 100),
            `${PAY.manager.pct}% от ${fmt(rev)} сом (${l.length} заказов)`);
      }
    });

    /* установщики — изделия плюс выезды */
    byRole('installer').forEach(s => {
      const l = state.orders.filter(o => o.installer === s.id &&
        ['installed','paid','done'].includes(o.status) && inR(o.deadline));
      if(!l.length) return;
      const pcs = l.reduce((a,o) => a + o.items.reduce((x,i) => x + i.qty, 0), 0);
      add(s, 'piece', pcs * PAY.installer.piece + l.length * PAY.installer.trip,
          `${pcs} изделий × ${PAY.installer.piece} + ${l.length} адресов × ${PAY.installer.trip}`);
    });

    /* премии, штрафы, уже выплаченное */
    (state.bonuses || []).filter(b => inR(b.date)).forEach(b => {
      const s = STAFF.find(x => x.id === b.who); if(s) add(s, 'bonus', b.sum, b.note); });
    (state.fines || []).filter(f => inR(f.date)).forEach(f => {
      const s = STAFF.find(x => x.id === f.who); if(s) add(s, 'fine', f.sum, f.note); });
    (state.payouts || []).filter(v => inR(v.date)).forEach(v => {
      const s = STAFF.find(x => x.id === v.who); if(s) add(s, 'paid', v.sum, v.note); });

    return Object.values(rows).map(r => {
      r.total = r.salary + r.piece + r.bonus - r.fine;
      r.left  = r.total - r.paid;
      r.base  = r.parts.filter(p => p.part === 'piece').map(p => p.note).join(' · ') || 'оклад';
      r.sum   = r.total;
      return r;
    }).filter(r => r.total || r.paid).sort((a,b) => b.total - a.total);
  }

  /* ══ ДДС: движение денег за период ══════════════ */
  function cashflow(state, from, to){
    const inR = d => { const x = (d || '').slice(0,10); return x >= from && x <= to; };
    const before = d => (d || '').slice(0,10) < from;

    const allIn = moneyIn(state), allOut = moneyOut(state);
    const start = ACCOUNTS.reduce((a,x) => a + x.start, 0)
      + allIn.filter(x => before(x.date)).reduce((a,x) => a + x.sum, 0)
      - allOut.filter(x => before(x.date)).reduce((a,x) => a + x.sum, 0);

    const inn = allIn.filter(x => inR(x.date));
    const out = allOut.filter(x => inR(x.date));
    const byCat = {};
    out.forEach(e => byCat[e.cat] = (byCat[e.cat] || 0) + e.sum);
    const bySrc = {};
    inn.forEach(x => bySrc[x.src] = (bySrc[x.src] || 0) + x.sum);

    const opIn = inn.reduce((a,x) => a + x.sum, 0);
    const opOut = out.reduce((a,x) => a + x.sum, 0);
    return { start, inn, out, byCat, bySrc, opIn, opOut,
             op:opIn - opOut, end:start + opIn - opOut };
  }

  /* ══ БАЛАНС: чем владеем и кому должны ══════════ */
  function balanceSheet(state){
    const money = ACCOUNTS.reduce((a,x) => a + balances(state)[x.id], 0);
    const hands = cashOnHand(state).reduce((a,c) => a + c.sum, 0);
    const stock = state.goods.reduce((a,g) => a + total(g) * g.cost, 0);
    const clients = state.orders.filter(o => o.status !== 'rejected')
      .reduce((a,o) => a + orderOwe(o), 0);
    const buyers = state.buyers.reduce((a,b) => a + b.balance, 0);
    const sup = state.suppliers.reduce((a,s) => a + s.debt, 0);
    const assets = money + hands + stock + clients + buyers;
    return { money, hands, stock, clients, buyers, assets,
             sup, capital:assets - sup, liab:sup };
  }

  /* ══ ВЫГРУЗКА В EXCEL ═══════════════════════════
     CSV с разделителем «;» и BOM — Excel на русской раскладке
     открывает такой файл сразу правильно, без импорта. */
  function toExcel(filename, headers, rows){
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
    };
    const body = [headers.map(esc).join(';'),
                  ...rows.map(r => r.map(esc).join(';'))].join('\r\n');
    const blob = new Blob(['\uFEFF' + body], { type:'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename.replace(/[\\/:*?"<>|]/g,'-') + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Файл «${a.download}» скачан`);
  }
  /* собрать выгрузку прямо из отрисованной таблицы */
  function tableToExcel(el, filename){
    if(!el){ toast('Таблица не найдена', 'bad'); return; }
    const grab = tr => [...tr.children].map(td => td.innerText.replace(/\s+/g,' ').trim());
    const head = el.querySelector('thead tr');
    const rows = [...el.querySelectorAll('tbody tr')].map(grab)
      .filter(r => r.join('').trim().length);
    [...el.querySelectorAll('tfoot tr')].forEach(tr => rows.push(grab(tr)));
    toExcel(filename, head ? grab(head) : [], rows);
  }

  /* ══ ЕДИНЫЙ ФИЛЬТР ПЕРИОДА ══════════════════════
     Одинаковая панель во всех разделах: быстрые кнопки
     плюс произвольный диапазон «с … по …». */
  const RANGES = [['today','Сегодня'],['week','7 дней'],['month','Этот месяц'],
                  ['prev','Прошлый месяц'],['q','Квартал'],['year','Год'],['all','Всё время']];

  function rangeOf(preset, from, to){
    if(from || to) return [from || '2000-01-01', to || '2099-12-31'];
    const T = '2026-08-03', y = T.slice(0,4), m = T.slice(0,7);
    const back = n => { const d = new Date(T); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); };
    const mback = n => { const d = new Date(T + 'T00:00:00'); d.setMonth(d.getMonth() - n);
                         return d.toISOString().slice(0,7); };
    switch(preset){
      case 'today': return [T, T];
      case 'week':  return [back(6), T];
      case 'prev':  return [mback(1) + '-01', mback(1) + '-31'];
      case 'q':     return [mback(2) + '-01', T];
      case 'year':  return [y + '-01-01', y + '-12-31'];
      case 'all':   return ['2000-01-01', '2099-12-31'];
      default:      return [m + '-01', m + '-31'];
    }
  }
  function rangeName(preset, from, to){
    if(from || to) return `${from ? dmy(from) : '…'} — ${to ? dmy(to) : '…'}`;
    return (RANGES.find(r => r[0] === preset) || RANGES[2])[1].toLowerCase();
  }

  let dateCssAdded = false;
  function dateBar(preset, from, to){
    if(!dateCssAdded && typeof document !== 'undefined'){
      dateCssAdded = true;
      const st = document.createElement('style');
      st.textContent = `
        .kdate{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:14px;
               background:#fff;border:1px solid #e2e8f1;border-radius:12px;padding:9px 11px;
               box-shadow:0 1px 2px rgba(21,29,41,.05)}
        .kd-p{border:1px solid #dbe2ee;background:#fff;border-radius:20px;padding:5px 12px;
              font:600 12px/1 inherit;color:#57617f;cursor:pointer;font-family:inherit}
        .kd-p:hover{border-color:#b9c3d8}
        .kd-p.on{background:#16203a;border-color:#16203a;color:#fff}
        .kd-sep{width:1px;height:20px;background:#e2e8f1;margin:0 4px}
        .kd-l{font-size:11px;font-weight:700;color:#98a1bb;text-transform:uppercase;letter-spacing:.04em}
        .kd-i{border:1px solid #dbe2ee;border-radius:8px;padding:5px 8px;font-family:inherit;
              font-size:12.5px;color:#16203a;background:#fff}
        .kd-i:focus{outline:none;border-color:#2b7fd4;box-shadow:0 0 0 3px rgba(43,127,212,.15)}
        .kd-x{border:none;background:#fdecea;color:#9d2b26;border-radius:8px;padding:6px 11px;
              font:700 11.5px/1 inherit;cursor:pointer;font-family:inherit}
        .kd-now{margin-left:auto;font-size:11.5px;color:#98a1bb}
        @media (max-width:700px){ .kd-now{display:none} }`;
      document.head.appendChild(st);
    }
    const custom = !!(from || to);
    return `<div class="kdate">
      ${RANGES.map(([k,n]) => `<button class="kd-p ${!custom && preset===k?'on':''}" data-kp="${k}">${n}</button>`).join('')}
      <span class="kd-sep"></span>
      <span class="kd-l">с</span><input class="kd-i" type="date" data-kf value="${from||''}">
      <span class="kd-l">по</span><input class="kd-i" type="date" data-kt value="${to||''}">
      ${custom ? '<button class="kd-x" data-kx>Сбросить даты</button>' : ''}
      <span class="kd-now">Период: ${rangeName(preset, from, to)}</span>
    </div>`;
  }
  /* onChange({preset, from, to}) */
  function bindDateBar(onChange, cur){
    document.querySelectorAll('[data-kp]').forEach(b => b.addEventListener('click',
      () => onChange({ preset:b.dataset.kp, from:'', to:'' })));
    const f = document.querySelector('[data-kf]'), t = document.querySelector('[data-kt]');
    if(f) f.addEventListener('change', () => onChange({ preset:cur.preset, from:f.value, to:t ? t.value : '' }));
    if(t) t.addEventListener('change', () => onChange({ preset:cur.preset, from:f ? f.value : '', to:t.value }));
    const x = document.querySelector('[data-kx]');
    if(x) x.addEventListener('click', () => onChange({ preset:cur.preset || 'month', from:'', to:'' }));
  }

  /* ── партнёры: деньги по заказу ── */
  const poOwe  = o => Math.max(0, o.sum - (o.paid || 0));
  const poCost = (o, goodsList) => (o.items || []).reduce((a,it) => {
    const g = goodsList.find(x => x.name === it.fabric);
    const area = it.w * it.h * it.qty * 1.05;
    const prof = goodsList.find(x => x.name === it.profile);
    return a + area * (g ? g.cost : 0) + (it.w * 2 * it.qty) * (prof ? prof.cost : 0);
  }, 0);
  /* сводка по партнёру за период */
  function partnerStats(state, id, from, to){
    const list = (state.porders || []).filter(o => o.partner === id &&
      (!from || (o.date >= from && o.date <= to)));
    const sum = list.reduce((a,o) => a + o.sum, 0);
    const paid = list.reduce((a,o) => a + (o.paid || 0), 0);
    const retail = list.reduce((a,o) => a + (o.retail || 0), 0);
    const cost = list.reduce((a,o) => a + poCost(o, state.goods), 0);
    const pcs = list.reduce((a,o) => a + o.items.reduce((x,i) => x + i.qty, 0), 0);
    return { list, sum, paid, owe:sum - paid, retail, cost, profit:sum - cost, pcs };
  }

  /* ── обещанная дата оплаты ──
     due — когда клиент обещал закрыть долг.
     Возвращает: нет обещания / просрочено / сегодня / ждём. */
  function dueState(o, today){
    const t = today || '2026-08-03';
    if(orderOwe(o) <= 0) return { kind:'paid', label:'оплачен', cls:'gn', days:0 };
    if(!o.dueDate) return { kind:'none', label:'дата не назначена', cls:'gy', days:null };
    const d = Math.round((new Date(o.dueDate) - new Date(t)) / 864e5);
    if(d < 0)  return { kind:'late',  label:`просрочено на ${-d} дн.`, cls:'rd', days:d };
    if(d === 0) return { kind:'today', label:'обещал сегодня', cls:'am', days:0 };
    return { kind:'wait', label:`через ${d} дн.`, cls:'bl', days:d };
  }
  /* кому напомнить сегодня */
  const dueToday = (state, today) => state.orders.filter(o =>
    orderOwe(o) > 0 && o.status !== 'rejected' &&
    ['late','today'].includes(dueState(o, today).kind));

  /* ── связь модулей с оболочкой ────────────────── */
  let onAction = null;

  function connect(apply, actionHandler){
    onAction = actionHandler || null;
    let got = false;

    window.addEventListener('message', e => {
      const d = e.data;
      if(!d || d.ns !== 'kasymov') return;
      if(d.type === 'state'){
        got = true;
        /* применяем настройки из админки: ставки зарплаты и прайс */
        if(d.state){
          if(d.state.pay)   Object.assign(PAY, d.state.pay);
          if(d.state.price) Object.assign(PRICE, d.state.price);
        }
        apply(d.state);
      }
      if(d.type === 'action' && onAction) onAction(d.name);
    });

    if(window.parent !== window){
      window.parent.postMessage({ ns:'kasymov', type:'ready' }, '*');
    }
    /* модуль открыт напрямую, без оболочки — работаем на своих данных */
    setTimeout(() => { if(!got) apply(clone(seed)); }, 300);
  }

  function commit(state){
    if(window.parent !== window){
      window.parent.postMessage({ ns:'kasymov', type:'commit', state:clone(state) }, '*');
    }
  }

  function toast(msg, kind){
    let el = document.querySelector('.toast');
    if(!el){ el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.toggle('bad', kind === 'bad');
    requestAnimationFrame(() => el.classList.add('on'));
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('on'), 3000);
  }

  function esc(s){
    return String(s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return { seed, clone,
           LOC, LOC_IDS, CATS, UNITS, STATUS, FLOW, NEXT, CHANNEL, USERS,
           ROLES, STAFF, byRole, staffName, BRANCHES, DISTRICTS, OPS, PAY,
           orderTotal, orderDisc, orderPaid, orderOwe, cashOnHand, staffRole,
           COMPANY, invSum, words, ACCOUNTS, ACC_BY_METHOD, EXP_CATS,
           PRICE, priceItem, priceOrder, LOGINS, auth, ACCESS, toExcel, tableToExcel,
           RANGES, rangeOf, rangeName, dateBar, bindDateBar,
           dueState, dueToday,
           poOwe, poCost, partnerStats,
           moneyIn, moneyOut, balances, orderCost, payroll, cashflow, balanceSheet,
           measurerRate, orderEarnings,
           bonuses, fines, payouts,
           fmt, qfmt, money, dmy, today, todayISO, daysLeft, deadlineChip,
           materials, normsFor, checkStock, total, reserved, onOrder, newCost,
           docTotal, buyerDebt, syncBuyers,
           connect, commit, toast, esc };
})();
