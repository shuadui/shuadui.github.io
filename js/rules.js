/* Richart 卡回饋方案判斷：純邏輯、不碰 DOM，index.html 與 test.html 共用。
 * 規則出處：notes/richart_tool_plan.md 第 3.5 節（回饋判斷）、第 4 節（搜尋正規化）；
 * 別名、餐飲、不回饋項目等補充規則在 data/extras.json。 */
(function (root) {
  'use strict';

  const PAYMENTS = ['刷卡', '台新Pay', '台新Pay+', 'LINE Pay', '全盈+Pay'];

  // 範圍型類別（channel.scope）由哪個條件觸發
  const SCOPE_TRIGGER = { '好饗刷': 'dining', '玩旅刷': 'overseas', '假日刷': 'holiday' };

  // 天天刷「日常採買」的全家、7-11 限台新Pay（計畫書 3.5 第 4 點）
  const TAISHIN_PAY_ONLY = { plan: '天天刷', channel: '日常採買', stores: ['全家', '7-11'] };

  const WEEKDAY = '日一二三四五六';

  // 去掉括號註記：「新光三越(含skm pay)」→「新光三越」（同 tools/build_lookup.py 的 norm）
  function stripNote(s) {
    return String(s).replace(/\s*[(（][^)）]*[)）]/g, '').trim();
  }

  // 搜尋用正規化：全半形統一、英文不分大小寫、臺→台、去掉空白與標點符號
  function normalize(s) {
    return String(s).normalize('NFKC').toLowerCase().replace(/臺/g, '台').replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function keyOf(name) {
    return normalize(stripNote(name));
  }

  // Pay著刷 的類別名稱 → 付款方式：「台新Pay 綁定支付(TWQR、台灣Pay)」→「台新Pay」
  function payOf(channel) {
    return channel.name.replace(/\s*綁定支付.*$/, '');
  }

  function isOverseasChannel(channel) {
    return channel.name.includes('海外');
  }

  // 3.3 → "3.3"、10 → "10"、5 - 3.3 → "1.7"
  function fmtRate(x) {
    return String(Math.round(x * 100) / 100);
  }

  function round1(x) {
    return Math.round(x * 10 + 1e-9) / 10;
  }

  // "2026-12-31" → "2026/12/31"；給 ref 且同一年 → "12/31"
  function fmtDate(date, ref) {
    const [y, m, d] = date.split('-').map(Number);
    return ref && ref.slice(0, 4) === date.slice(0, 4) ? `${m}/${d}` : `${y}/${m}/${d}`;
  }

  function todayTaipei(now) {
    const parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now || new Date())
      .forEach((p) => { parts[p.type] = p.value; });
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function weekday(date) {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
  }

  // 假日：辦公日曆表的放假日＋週末，補行上班日除外（data/holidays.json）
  function holidayInfo(cal, date) {
    const wd = weekday(date);
    const covered = (cal.years || []).includes(Number(date.slice(0, 4)));
    const work = cal.workdays && cal.workdays[date];
    if (work) return { holiday: false, label: work, covered };
    const name = cal.holidays && cal.holidays[date];
    if (name) return { holiday: true, label: `${name}（週${WEEKDAY[wd]}）`, covered };
    if (wd === 0 || wd === 6) return { holiday: true, label: `週${WEEKDAY[wd]}`, covered };
    return { holiday: false, label: `平日（週${WEEKDAY[wd]}）`, covered };
  }

  // 從 plans 建店家索引（不依賴 lookup.by_store，之後更新資料只要改 plans）
  function buildIndex(data, extras) {
    extras = extras || {};
    const stores = new Map();
    const problems = [];
    const ensure = (name) => {
      const key = keyOf(name);
      let s = stores.get(key);
      if (!s) {
        s = { key, name: stripNote(name), raws: [], hits: [], excluded: null, dining: false, overseasByFlag: false };
        stores.set(key, s);
      }
      return s;
    };
    const find = (name, what) => {
      const s = stores.get(keyOf(name));
      if (!s) problems.push(`${what}「${name}」不在店家清單`);
      return s;
    };

    data.plans.forEach((plan, pi) => plan.channels.forEach((ch, ci) => (ch.stores || []).forEach((raw) => {
      const s = ensure(raw);
      if (!s.raws.includes(raw)) s.raws.push(raw);
      s.hits.push({ pi, ci, raw });
    })));
    Object.entries(extras.excluded_stores || {}).forEach(([name, why]) => { ensure(name).excluded = why; });
    (extras.dining || []).forEach((name) => { const s = find(name, '餐飲店家'); if (s) s.dining = true; });
    (extras.overseas_by_flag || []).forEach((name) => { const s = find(name, '用海外勾選區分的店家'); if (s) s.overseasByFlag = true; });

    // 搜尋鍵：去掉括號註記的店名、原文店名、別名
    const keys = [];
    stores.forEach((s) => {
      keys.push({ k: s.key, store: s, via: null });
      s.raws.forEach((raw) => {
        const k = normalize(raw);
        if (k !== s.key) keys.push({ k, store: s, via: null });
      });
    });
    Object.entries(extras.aliases || {}).forEach(([alias, targets]) => targets.forEach((t) => {
      const s = find(t, `別名「${alias}」的對象`);
      if (s) keys.push({ k: normalize(alias), store: s, via: alias });
    }));

    return { data, plans: data.plans, stores, keys, problems };
  }

  function findStore(index, name) {
    return index.stores.get(keyOf(name)) || null;
  }

  // 回傳 [{ store, score, via }]，score：300 完全符合、2xx 開頭符合、1xx 包含、<100 輸入裡含店名
  function search(index, query, limit) {
    const q = normalize(query);
    if (!q) return [];
    const found = new Map();
    const put = (e, score) => {
      const cur = found.get(e.store);
      if (!cur || score > cur.score) found.set(e.store, { store: e.store, score, via: e.via });
    };
    index.keys.forEach((e) => {
      if (e.k === q) put(e, 300);
      else if (e.k.startsWith(q)) put(e, 200 - Math.min(e.k.length, 99));
      else if (e.k.includes(q)) put(e, 100 - Math.min(e.k.length, 99));
    });
    if (!found.size) {
      // 輸入比店名長，例：「新光三越信義店」含「新光三越」
      index.keys.forEach((e) => { if (e.k.length >= 2 && q.includes(e.k)) put(e, Math.min(e.k.length, 99)); });
    }
    return [...found.values()]
      .sort((a, b) => b.score - a.score || a.store.name.localeCompare(b.store.name, 'zh-Hant'))
      .slice(0, limit || 8);
  }

  function na(reason) {
    return { rate: 0, na: true, reason: reason || '', bonus: false };
  }

  function scopeApplies(plan, item, ctx) {
    const trigger = SCOPE_TRIGGER[plan.name];
    const s = item.store;
    if (!trigger || (s && s.excluded)) return false;
    if (trigger === 'dining') return (s ? s.dining : !!item.dining) && !item.overseas;
    if (trigger === 'overseas') return !!item.overseas;
    return !!ctx.holiday;
  }

  // 「台新Pay／台新Pay+ 3.8%、LINE Pay／全盈+Pay 2.3%」
  function payTips(chans) {
    const byRate = new Map();
    chans.forEach((x) => {
      const pays = byRate.get(x.ch.rate_pct) || [];
      if (!pays.includes(x.pay)) pays.push(x.pay);
      byRate.set(x.ch.rate_pct, pays);
    });
    return [...byRate.entries()].sort((a, b) => b[0] - a[0])
      .map(([rate, pays]) => `${pays.join('／')} ${fmtRate(rate)}%`).join('、');
  }

  // Pay著刷：只看付款方式；清單裡的店家只是舉例（計畫書 3.5 第 3 點）
  function payRate(index, pi, item, ctx) {
    const plan = index.plans[pi];
    const s = item.store || null;
    const pay = item.payment;
    const chans = plan.channels.map((ch, ci) => ({ ch, ci, pay: payOf(ch) }));
    const listed = s ? chans.filter((x) => s.hits.some((h) => h.pi === pi && h.ci === x.ci)) : [];
    if (s && s.excluded && !listed.length) return na('');
    if (pay === '刷卡') return na(`刷卡不適用，改用${payTips(s && s.excluded ? listed : chans)}`);
    const mine = chans.filter((x) => x.pay === pay);
    if (!mine.length) return na(`${pay}不在 Pay著刷 範圍`);
    if (s && s.excluded && !listed.some((x) => x.pay === pay)) return na(`${s.name}只限${payTips(listed)}`);
    const since = mine[0].ch.added && mine[0].ch.added[pay];
    if (since && ctx.date < since) return na(`${pay} ${fmtDate(since)} 起才適用`);
    const hit = listed.find((x) => x.pay === pay);
    const use = hit || mine[0];
    return {
      rate: use.ch.rate_pct, channel: use.ch.name, theme: null, note: null, scope: null,
      condition: hit ? `以${pay}付款` : `若該店可用${pay}`,
      perk: use.ch.perk || null, bonus: true,
    };
  }

  // 其他方案：店家在某個類別的清單內就用該類別回饋率，同方案多個類別命中取最高；再看範圍型類別
  function channelRate(index, pi, item, ctx) {
    const plan = index.plans[pi];
    const s = item.store || null;
    const reasons = [];
    let best = null;
    // 同率時優先顯示店家清單命中的類別（比範圍型類別具體）
    const take = (r, listed) => {
      if (!best || r.rate > best.rate || (r.rate === best.rate && listed && !best.listed)) best = Object.assign(r, { listed });
    };
    plan.channels.forEach((ch, ci) => {
      const hit = s && s.hits.find((h) => h.pi === pi && h.ci === ci);
      if (hit) {
        const since = ch.added && ch.added[hit.raw];
        if (since && ctx.date < since) {
          reasons.push(`${s.name} ${fmtDate(since)} 起才適用`);
        } else if (plan.name === TAISHIN_PAY_ONLY.plan && ch.name === TAISHIN_PAY_ONLY.channel
            && TAISHIN_PAY_ONLY.stores.includes(s.name) && item.payment !== '台新Pay') {
          reasons.push(`${s.name}限台新Pay`);
        } else if (s.overseasByFlag && isOverseasChannel(ch) !== !!item.overseas) {
          reasons.push(item.overseas ? `海外消費不算「${ch.name}」` : `要勾「海外消費」才算「${ch.name}」`);
        } else {
          take({ rate: ch.rate_pct, channel: ch.name, theme: ch.theme || null, condition: null,
            note: ch.note || null, perk: ch.perk || null, scope: null }, true);
        }
      }
      if (ch.scope && scopeApplies(plan, item, ctx)) {
        take({ rate: ch.rate_pct, channel: stripNote(ch.scope).split('，')[0], theme: null, condition: null,
          note: ch.note || null, perk: null, scope: ch.scope }, false);
      }
    });
    if (!best && SCOPE_TRIGGER[plan.name] === 'dining' && item.overseas && (s ? s.dining : item.dining)) {
      reasons.push('全臺餐飲不含海外');
    }
    if (!best) return na(reasons.join('；'));
    best.bonus = true;
    return best;
  }

  // item：{ store: 店家（清單外為 null）, payment, overseas, dining（只用在清單外店家） }
  // ctx：{ date: 'YYYY-MM-DD', holiday, baseRate }
  // 回傳 { rate, channel, theme, condition, note, perk, scope, bonus, base } 或 { rate: 0, na: true, reason }
  function rateFor(index, pi, item, ctx) {
    const plan = index.plans[pi];
    const s = item.store || null;
    if (ctx.date < plan.period.start || ctx.date > plan.period.end) {
      const relevant = (s && s.hits.some((h) => h.pi === pi)) || scopeApplies(plan, item, ctx);
      if (!relevant) return na('');
      return na(ctx.date < plan.period.start
        ? `${fmtDate(plan.period.start)} 起才開始` : `已於 ${fmtDate(plan.period.end)} 截止`);
    }
    const r = plan.name === 'Pay著刷' ? payRate(index, pi, item, ctx) : channelRate(index, pi, item, ctx);
    // 非指定通路的基本回饋：不回饋項目不給（計畫書 3.5 第 5、10 點）；指定類別的回饋率視為已含基本回饋
    if (ctx.baseRate > 0 && !(s && s.excluded) && (r.na || r.rate < ctx.baseRate)) {
      return { rate: ctx.baseRate, channel: '一般消費', theme: null, condition: null, note: null, perk: null,
        scope: null, bonus: false, base: true, reason: r.reason };
    }
    return r;
  }

  // 依回饋率排序；同率時目前方案優先（同率就不用切），再依方案順序
  function rankPlans(index, item, ctx, currentPlan) {
    return index.plans
      .map((plan, pi) => ({ plan, pi, r: rateFor(index, pi, item, ctx) }))
      .sort((a, b) => (b.r.rate - a.r.rate)
        || ((b.plan.name === currentPlan) - (a.plan.name === currentPlan))
        || (a.pi - b.pi));
  }

  // 台新Pay+ 的舉例店家都在日韓：國內消費不列，勾海外或店家本身在日韓才列
  function paymentsFor(item) {
    const foreign = !!item.overseas
      || (!!item.store && item.store.raws.some((r) => /[(（](日本|韓國)[)）]/.test(r)));
    return foreign ? PAYMENTS.slice() : PAYMENTS.filter((p) => p !== '台新Pay+');
  }

  // 「若該店可用台新Pay」這類要看店家收不收的回饋，不算確定拿得到
  function isSure(r) {
    return !String(r.condition || '').startsWith('若');
  }

  // 付款方式比較：同一筆消費用每種付款方式各排一次方案。
  // best：確定拿得到的最佳「付款方式＋方案」；maybe：要看店家收不收、但比 best 高的選項。
  // 同率時依序偏好：目前方案（不用切）→ 確定的 → 有額外優惠的 → 付款方式順序（刷卡優先）
  function comparePayments(index, item, ctx, currentPlan) {
    const byPayment = paymentsFor(item).map((payment, order) => {
      const rows = rankPlans(index, Object.assign({}, item, { payment }), ctx, currentPlan);
      return { payment, order, rows, top: rows[0].r.rate > 0 ? rows[0] : null };
    });
    const ranked = byPayment.filter((x) => x.top).sort((a, b) => (b.top.r.rate - a.top.r.rate)
      || ((b.top.plan.name === currentPlan) - (a.top.plan.name === currentPlan))
      || (isSure(b.top.r) - isSure(a.top.r))
      || (Boolean(b.top.r.perk) - Boolean(a.top.r.perk))
      || (a.order - b.order));
    const best = ranked.find((x) => isSure(x.top.r)) || null;
    const maybe = ranked.filter((x) => !isSure(x.top.r) && (!best || x.top.r.rate > best.top.r.rate));
    const out = { byPayment, best, maybe, kind: 'none', diff: 0, cur: null, samePays: [], anyPayment: false };
    if (!best) return out;
    out.cur = best.rows.find((x) => x.plan.name === currentPlan) || null;
    const curRate = out.cur ? out.cur.r.rate : 0;
    if (!best.top.r.bonus) {
      out.kind = 'base';
    } else if (curRate >= best.top.r.rate) {
      out.kind = 'stay';
    } else {
      out.kind = 'switch';
      out.diff = best.top.r.rate - curRate;
    }
    out.samePays = byPayment
      .filter((x) => x.top && x.top.plan === best.top.plan && x.top.r.rate === best.top.r.rate)
      .map((x) => x.payment);
    out.anyPayment = out.samePays.length === byPayment.length;
    return out;
  }

  function advise(rows, currentPlan) {
    const best = rows[0];
    if (!best || best.r.rate <= 0) return { kind: 'none' };
    if (!best.r.bonus) return { kind: 'base', best };
    const cur = rows.find((x) => x.plan.name === currentPlan) || null;
    const curRate = cur ? cur.r.rate : 0;
    if (curRate >= best.r.rate) return { kind: 'stay', best, cur };
    return { kind: 'switch', best, cur, diff: best.r.rate - curRate };
  }

  // 今日試算：items 為 [{ store, payment, overseas, dining, amount }]，依總回饋排序
  function calcDay(index, items, ctx, currentPlan) {
    return index.plans
      .map((plan, pi) => {
        const lines = items.map((it) => {
          const r = rateFor(index, pi, it, ctx);
          return { item: it, r, cashback: (it.amount * r.rate) / 100 };
        });
        return { plan, pi, lines, total: lines.reduce((sum, l) => sum + l.cashback, 0) };
      })
      .sort((a, b) => (round1(b.total) - round1(a.total))
        || ((b.plan.name === currentPlan) - (a.plan.name === currentPlan))
        || (a.pi - b.pi));
  }

  root.RichartRules = {
    PAYMENTS, stripNote, normalize, keyOf, fmtRate, fmtDate, round1, todayTaipei, weekday, holidayInfo,
    buildIndex, findStore, search, rateFor, rankPlans, advise, calcDay, paymentsFor, isSure, comparePayments,
  };
})(typeof window !== 'undefined' ? window : globalThis);
