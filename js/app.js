/* 介面：讀資料、查店家（比較各付款方式）、清單外店家、今日試算、設定。判斷邏輯都在 js/rules.js。 */
(function () {
  'use strict';

  const R = window.RichartRules;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt1 = (x) => R.round1(x).toFixed(1);
  const fmtAmount = (n) => n.toLocaleString('zh-TW');
  const WEEKDAY = '日一二三四五六';
  const SWITCH_TIP = '當天 00:00–23:59 的消費都依當天最後套用的方案計算：付完款再切也算，但一天只能切一次。';

  // 設定存在 localStorage；私密模式或封鎖網站資料時讀寫會丟例外，這時用預設值、不保存
  const PREFIX = 'richart-tool:';
  const prefs = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem(PREFIX + k);
        return v === null ? fallback : v;
      } catch (e) {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(PREFIX + k, v);
      } catch (e) {
        // 無法保存：這次照常運作，下次開啟會回到預設值
      }
    },
  };

  const S = {
    index: null,
    cal: null,
    today: R.todayTaipei(),
    date: null,
    dateManual: false,
    holidayOverride: null, // null＝自動判斷
    currentPlan: null,
    baseRate: 0,
    calcPayment: '刷卡', // 今日試算新增消費時預設的付款方式（記住上次選的）
    planListYear: null,
    lookup: { query: '', selectedKey: null, overseas: false, kind: null },
    calc: { items: [], nextId: 1, pickedKey: null },
  };
  S.date = S.today;

  function ctx() {
    const info = R.holidayInfo(S.cal, S.date);
    return { date: S.date, holiday: S.holidayOverride === null ? info.holiday : S.holidayOverride, baseRate: S.baseRate };
  }

  function planEnd(plan) {
    return `${R.fmtDate(plan.period.end, S.date)} 截止`;
  }

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url}：HTTP ${res.status}`);
    return res.json();
  }

  async function init() {
    let plans, extras, cal;
    try {
      [plans, extras, cal] = await Promise.all(
        ['data/richart_plans.json', 'data/extras.json', 'data/holidays.json'].map(loadJson));
    } catch (e) {
      const el = $('#appError');
      el.textContent = `資料載入失敗（${e.message}），請重新整理頁面。`;
      el.hidden = false;
      return;
    }
    S.index = R.buildIndex(plans, extras);
    S.cal = cal;

    const names = S.index.plans.map((p) => p.name);
    const savedPlan = prefs.get('currentPlan', plans.current_plan);
    S.currentPlan = names.includes(savedPlan) ? savedPlan : names[0];
    const savedPay = prefs.get('calcPayment', '刷卡');
    S.calcPayment = R.PAYMENTS.includes(savedPay) ? savedPay : '刷卡';
    const savedBase = parseFloat(prefs.get('baseRate', '0'));
    S.baseRate = Number.isFinite(savedBase) && savedBase > 0 && savedBase <= 5 ? savedBase : 0;

    setupControls();
    bindEvents();
    renderAll();
  }

  function fillSelect(sel, values, value) {
    sel.innerHTML = values.map((v) => `<option${v === value ? ' selected' : ''}>${esc(v)}</option>`).join('');
  }

  function setupControls() {
    const years = S.cal.years || [];
    if (years.length) {
      $('#date').min = `${Math.min(...years)}-01-01`;
      $('#date').max = `${Math.max(...years)}-12-31`;
    }
    $('#date').value = S.date;
    fillSelect($('#calcPayment'), R.PAYMENTS, S.calcPayment);
    fillSelect($('#currentPlan'), S.index.plans.map((p) => p.name), S.currentPlan);
    $('#baseRate').value = S.baseRate;
  }

  function debounce(fn, ms) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  function bindEvents() {
    $('#date').addEventListener('change', (e) => {
      if (!e.target.value) {
        e.target.value = S.date;
        return;
      }
      S.date = e.target.value;
      S.dateManual = S.date !== S.today;
      S.holidayOverride = null;
      renderAll();
    });
    $('#todayBtn').addEventListener('click', () => {
      S.today = R.todayTaipei();
      S.date = S.today;
      S.dateManual = false;
      S.holidayOverride = null;
      $('#date').value = S.date;
      renderAll();
    });
    $('#holiday').addEventListener('change', (e) => {
      const auto = R.holidayInfo(S.cal, S.date).holiday;
      S.holidayOverride = e.target.checked === auto ? null : e.target.checked;
      renderAll();
    });
    $('#currentPlan').addEventListener('change', (e) => {
      S.currentPlan = e.target.value;
      prefs.set('currentPlan', S.currentPlan);
      renderAll();
    });
    $('#baseRate').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      S.baseRate = Number.isFinite(v) && v > 0 ? Math.min(v, 5) : 0;
      prefs.set('baseRate', String(S.baseRate));
      renderAll();
    });
    // 結果裡的「改目前方案」：打開最下面的設定
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-action="edit-settings"]')) return;
      const box = $('#settings');
      box.open = true;
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    document.querySelectorAll('[role="tab"]').forEach((tab) => tab.addEventListener('click', () => selectTab(tab)));

    $('#q').addEventListener('input', debounce(() => {
      S.lookup.query = $('#q').value;
      S.lookup.selectedKey = null;
      renderLookup();
    }, 120));
    $('#lookupOverseas').addEventListener('change', (e) => {
      S.lookup.overseas = e.target.checked;
      renderLookup();
    });
    $('#candidates').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-key]');
      if (!b) return;
      S.lookup.selectedKey = b.dataset.key;
      renderLookup();
    });
    $('#offlistKinds').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-kind]');
      if (!b) return;
      S.lookup.kind = S.lookup.kind === b.dataset.kind ? null : b.dataset.kind;
      renderOfflist();
    });

    $('#calcStore').addEventListener('input', () => {
      S.calc.pickedKey = null;
      renderSuggest();
    });
    $('#suggest').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-key]');
      if (!b) return;
      const s = S.index.stores.get(b.dataset.key);
      S.calc.pickedKey = s.key;
      $('#calcStore').value = s.name;
      renderSuggest();
      $('#calcAmount').focus();
    });
    $('#calcPayment').addEventListener('change', (e) => {
      S.calcPayment = e.target.value;
      prefs.set('calcPayment', S.calcPayment);
    });
    $('#addForm').addEventListener('submit', (e) => {
      e.preventDefault();
      addItem();
    });
    $('#items').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-remove]');
      if (!b) return;
      S.calc.items = S.calc.items.filter((it) => it.id !== Number(b.dataset.remove));
      renderCalc();
    });
    $('#clearItems').addEventListener('click', () => {
      S.calc.items = [];
      renderCalc();
    });

    // 頁面開著過了午夜：回到前景時把「今天」更新成新日期（手動改過日期就不動）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const t = R.todayTaipei();
      if (t === S.today) return;
      S.today = t;
      if (!S.dateManual) {
        S.date = t;
        S.holidayOverride = null;
        $('#date').value = t;
      }
      renderAll();
    });
  }

  function selectTab(tab) {
    document.querySelectorAll('[role="tab"]').forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
  }

  function renderAll() {
    renderSettings();
    renderLookup();
    renderOfflist();
    renderSuggest();
    renderCalc();
    renderPlanList();
  }

  function renderSettings() {
    const info = R.holidayInfo(S.cal, S.date);
    const c = ctx();
    $('#holiday').checked = c.holiday;
    let label = `自動判斷：${info.label}`;
    if (S.holidayOverride !== null) label = `已手動設為${c.holiday ? '假日' : '平日'}（${label}）`;
    if (!info.covered) label += '。這一年不在內建假日資料內，只判斷週末';
    $('#holidayLabel').textContent = label;
    $('#todayBtn').hidden = S.date === S.today;
    const cur = S.index.plans.find((p) => p.name === S.currentPlan);
    const out = cur && (S.date < cur.period.start || S.date > cur.period.end);
    $('#currentPlanHint').textContent = out
      ? `${cur.name}在這天不在活動期間（${R.fmtDate(cur.period.start)}–${R.fmtDate(cur.period.end)}）` : '';

    let summary = `${R.fmtDate(S.date, S.today)} 週${WEEKDAY[R.weekday(S.date)]}・${c.holiday ? '假日' : '平日'}`;
    if (S.date !== S.today) summary += '（模擬）';
    summary += `｜目前方案 ${S.currentPlan}${out ? '（不在期間）' : ''}`;
    $('#settingsSummary').innerHTML = `<span class="gear" aria-hidden="true">⚙</span> ${esc(summary)}`;
  }

  // ---- 查店家、清單外店家：比較各付款方式 ----

  function renderLookup() {
    const q = S.lookup.query.trim();
    const msg = $('#lookupMsg');
    const chips = $('#candidates');
    const box = $('#lookupResult');
    if (!q) {
      msg.textContent = '';
      chips.innerHTML = '';
      box.innerHTML = '';
      return;
    }
    const found = R.search(S.index, q, 8);
    if (!found.length) {
      msg.textContent = `找不到「${q}」，可以改用下方「清單上沒有的店」依消費類型判斷。`;
      chips.innerHTML = '';
      box.innerHTML = '';
      return;
    }
    let sel = (S.lookup.selectedKey && found.find((f) => f.store.key === S.lookup.selectedKey)) || null;
    if (!sel) sel = found.find((f) => f.score === 300) || (found.length === 1 ? found[0] : null);
    const others = found.filter((f) => f !== sel);
    msg.textContent = sel ? (others.length ? '其他符合的店家：' : '') : `符合的店家有 ${found.length} 家，請選一家：`;
    chips.innerHTML = others
      .map((f) => `<button type="button" class="chip" data-key="${esc(f.store.key)}">${esc(f.store.name)}</button>`)
      .join('');
    box.innerHTML = sel ? storeResultHtml(sel) : '';
  }

  function storeResultHtml(sel) {
    const s = sel.store;
    const item = { store: s, overseas: S.lookup.overseas, dining: false };
    const cmp = R.comparePayments(S.index, item, ctx(), S.currentPlan);
    let h = '<article class="card result">';
    h += `<header class="result-head"><h2>${esc(s.name)}</h2>`;
    if (sel.via) h += `<span class="muted">輸入「${esc(sel.via)}」對應到這家</span>`;
    h += '</header>';
    if (s.excluded) {
      h += `<p class="note-warn">屬於不回饋項目（${esc(s.excluded)}）${s.hits.length ? '，只有方案明列的類別例外' : ''}。</p>`;
    }
    if (!item.overseas && s.raws.some((r) => /[(（](日本|韓國)[)）]/.test(r))) {
      h += '<p class="hint">這是海外店家，勾選「海外消費」可以一起比較玩旅刷。</p>';
    }
    h += compareHtml(cmp);
    h += '</article>';
    return h;
  }

  function renderOfflist() {
    document.querySelectorAll('#offlistKinds button')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === S.lookup.kind)));
    const box = $('#offlistResult');
    const kind = S.lookup.kind;
    if (!kind) {
      box.innerHTML = '';
      return;
    }
    const item = { store: null, overseas: kind === 'overseas', dining: kind === 'dining' };
    const c = ctx();
    const cmp = R.comparePayments(S.index, item, c, S.currentPlan);
    const kindText = { dining: '國內餐飲', overseas: '海外消費', general: '國內其他消費' }[kind];
    box.innerHTML = `<p class="hint">${esc(kindText)}・${c.holiday ? '假日' : '平日'}</p>${compareHtml(cmp)}`;
  }

  function compareHtml(cmp) {
    let h = '';
    if (cmp.kind === 'switch' || cmp.kind === 'stay') h += bestHtml(cmp);
    h += adviceHtml(cmp);
    if (cmp.maybe.length) h += maybeHtml(cmp);
    h += paysHtml(cmp);
    h += plansHtml(cmp);
    h += '<p class="fine">回饋率為官方標示的「最高」值，細則以台新官網為準。</p>';
    return h;
  }

  function payPhrase(cmp) {
    if (cmp.anyPayment) return '付款方式不限';
    if (cmp.samePays.includes('刷卡')) return '刷卡即可';
    return `用${cmp.samePays.join('／')}付款`;
  }

  function factList(r) {
    const facts = [`類別：${r.channel}${r.theme ? `（#${r.theme}）` : ''}`];
    if (r.condition && !r.condition.startsWith('以')) facts.push(`條件：${r.condition}`);
    if (r.scope) facts.push(`範圍：${r.scope}`);
    if (r.note) facts.push(`附註：${r.note}`);
    if (r.perk) facts.push(`另享：${r.perk}`);
    return facts;
  }

  function bestHtml(cmp) {
    const x = cmp.best.top;
    const facts = [payPhrase(cmp)].concat(factList(x.r));
    return '<div class="best">'
      + '<div class="best-label">最划算</div>'
      + `<div class="best-top"><span class="plan">${esc(x.plan.name)}</span><span class="rate">${R.fmtRate(x.r.rate)}%</span></div>`
      + `<ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      + `<span class="badge">${esc(planEnd(x.plan))}</span>`
      + '</div>';
  }

  function adviceHtml(cmp) {
    const cur = esc(S.currentPlan);
    const edit = '<button type="button" class="link small" data-action="edit-settings">改目前方案</button>';
    if (cmp.kind === 'none') {
      return `<div class="advice none">${cmp.maybe.length ? '沒有確定拿得到的加碼回饋' : '沒有方案有加碼回饋'}</div>`;
    }
    if (cmp.kind === 'base') {
      return `<div class="advice none">沒有方案高於基本回饋 ${R.fmtRate(cmp.best.top.r.rate)}%</div>`;
    }
    if (cmp.kind === 'stay') {
      return `<div class="advice stay">目前方案「${cur}」就是最佳，不用切<small>${edit}</small></div>`;
    }
    const curText = cmp.cur && cmp.cur.r.rate > 0 ? `${R.fmtRate(cmp.cur.r.rate)}%` : '沒有回饋';
    return `<div class="advice switch">建議切到 <strong>${esc(cmp.best.top.plan.name)}</strong>（+${R.fmtRate(cmp.diff)}%）`
      + `<small>目前方案 ${cur}：${curText}　${edit}</small></div>`
      + `<p class="tip">※ ${SWITCH_TIP}</p>`;
  }

  // 要看店家收不收的選項：依「方案＋回饋率」分組，例：LINE Pay／全盈+Pay → 切 Pay著刷 2.3%
  function maybeHtml(cmp) {
    const groups = [];
    cmp.maybe.forEach((x) => {
      const perk = x.top.r.perk || null;
      const g = groups.find((y) => y.plan === x.top.plan && y.rate === x.top.r.rate && y.perk === perk);
      if (g) g.pays.push(x.payment);
      else groups.push({ plan: x.top.plan, rate: x.top.r.rate, perk, pays: [x.payment] });
    });
    const lines = groups.map((g) => `${g.pays.join('／')} → 切 ${g.plan.name} ${R.fmtRate(g.rate)}%${g.perk ? `（${g.perk}）` : ''}`);
    return '<div class="maybe">'
      + `<div class="maybe-head">${cmp.best ? '店家如果收這些行動支付，還可以更高：' : '店家如果收這些行動支付：'}</div>`
      + `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  }

  function paysHtml(cmp) {
    const rows = cmp.byPayment.map((x) => {
      const hit = cmp.best && x.top && x.top.plan === cmp.best.top.plan && cmp.samePays.includes(x.payment) ? ' class="hit"' : '';
      if (!x.top) return `<li${hit}><span class="pay">${esc(x.payment)}</span><span class="muted">沒有回饋</span></li>`;
      return `<li${hit}><span class="pay">${esc(x.payment)}</span><span class="plan">${esc(x.top.plan.name)}</span>`
        + `<span class="rate">${R.fmtRate(x.top.r.rate)}%</span>`
        + (R.isSure(x.top.r) ? '' : '<span class="cond">若店家可用</span>') + '</li>';
    }).join('');
    return `<h3 class="sub-head">各付款方式</h3><ul class="pays">${rows}</ul>`;
  }

  // 用最划算的付款方式（沒有就用刷卡）逐一列出 8 個方案
  function plansHtml(cmp) {
    const basis = cmp.best || cmp.byPayment[0];
    const items = basis.rows.map((x) => {
      const r = x.r;
      let what;
      if (r.rate > 0) {
        const cond = r.condition && !r.condition.startsWith('以') ? `・${r.condition}` : '';
        what = `${R.fmtRate(r.rate)}%・${r.base ? '基本回饋' : r.channel}${cond}`;
      } else {
        what = r.reason || '沒有回饋';
      }
      return `<li><span class="plan">${esc(x.plan.name)}</span><span class="muted">${esc(what)}</span></li>`;
    }).join('');
    return `<details class="na"><summary>依方案看（${esc(basis.payment)}）</summary><ul class="by-plan">${items}</ul></details>`;
  }

  // ---- 今日試算 ----

  function resolveCalcStore(text) {
    if (S.calc.pickedKey) return S.index.stores.get(S.calc.pickedKey) || null;
    const found = R.search(S.index, text, 2);
    if (found.length && (found[0].score === 300 || found.length === 1)) return found[0].store;
    return null;
  }

  function renderSuggest() {
    const text = $('#calcStore').value.trim();
    const found = !text || S.calc.pickedKey ? [] : R.search(S.index, text, 6);
    $('#suggest').innerHTML = found
      .map((f) => `<button type="button" class="chip" data-key="${esc(f.store.key)}">${esc(f.store.name)}</button>`)
      .join('');
    $('#calcDiningWrap').hidden = !text || !!resolveCalcStore(text);
  }

  function addItem() {
    const storeInput = $('#calcStore');
    const amountInput = $('#calcAmount');
    const text = storeInput.value.trim();
    const amount = Math.round(Number(amountInput.value));
    if (!text) {
      storeInput.focus();
      return;
    }
    if (!(amount > 0)) {
      amountInput.focus();
      return;
    }
    const store = resolveCalcStore(text);
    S.calc.items.push({
      id: S.calc.nextId++,
      label: store ? store.name : text,
      store,
      amount,
      payment: $('#calcPayment').value,
      overseas: $('#calcOverseas').checked,
      dining: !store && $('#calcDining').checked,
    });
    storeInput.value = '';
    amountInput.value = '';
    $('#calcOverseas').checked = false;
    $('#calcDining').checked = false;
    $('#calcPayment').value = S.calcPayment;
    S.calc.pickedKey = null;
    renderSuggest();
    renderCalc();
    storeInput.focus();
  }

  function lineHtml(l) {
    const it = l.item;
    const r = l.r;
    const what = r.rate > 0
      ? `${R.fmtRate(r.rate)}%・${r.base ? '基本回饋' : r.channel}${r.condition ? `・${r.condition}` : ''}`
      : (r.reason || '沒有回饋');
    return `<li><span class="name">${esc(it.label)}</span><span class="amt">${fmt1(l.cashback)}</span>`
      + `<span class="muted">NT$${esc(fmtAmount(it.amount))}・${esc(what)}</span></li>`;
  }

  function renderCalc() {
    const items = S.calc.items;
    $('#itemsCard').hidden = !items.length;
    $('#items').innerHTML = items.map((it) => {
      const tags = [it.payment];
      if (it.overseas) tags.push('海外');
      if (!it.store) tags.push(it.dining ? '清單外・餐飲' : '清單外');
      return `<li><span class="name">${esc(it.label)}</span><span class="amt">NT$${esc(fmtAmount(it.amount))}</span>`
        + `<span class="muted">${esc(tags.join('・'))}</span>`
        + `<button type="button" class="link" data-remove="${it.id}" aria-label="刪除 ${esc(it.label)}">刪除</button></li>`;
    }).join('');

    const box = $('#calcResult');
    if (!items.length) {
      box.innerHTML = '<p class="hint center">新增今天預計的消費，會列出 8 個方案各自的回饋。</p>';
      return;
    }
    const totals = R.calcDay(S.index, items, ctx(), S.currentPlan);
    const top = totals[0];
    const cur = totals.find((t) => t.plan.name === S.currentPlan);
    const topV = R.round1(top.total);
    const curV = cur ? R.round1(cur.total) : 0;
    let h = '<div class="card result">';
    if (topV <= 0) {
      h += '<div class="advice none">這些消費在各方案都沒有回饋</div>';
    } else if (curV >= topV) {
      h += `<div class="advice stay">目前方案「${esc(S.currentPlan)}」就是最佳，不用切（約 NT$${fmt1(curV)}）</div>`;
    } else {
      h += `<div class="advice switch">今天切 <strong>${esc(top.plan.name)}</strong>，約 NT$${fmt1(topV)}`
        + `<small>比目前方案 ${esc(S.currentPlan)}（約 NT$${fmt1(curV)}）多約 NT$${fmt1(topV - curV)}</small></div>`
        + `<p class="tip">※ ${SWITCH_TIP}今天的消費都輸入完，再在 23:59 前切一次。</p>`;
    }
    h += '<ol class="totals">' + totals.map((t, i) => {
      const v = R.round1(t.total);
      const isTop = i === 0 && v > 0;
      const badges = (isTop ? '<span class="badge good">今天切這個</span>' : '')
        + (t.plan.name === S.currentPlan ? '<span class="badge">目前</span>' : '');
      return `<li${isTop ? ' class="top"' : ''}><details><summary><span class="plan">${esc(t.plan.name)}</span>${badges}`
        + `<span class="sum">約 NT$${fmt1(v)}</span></summary>`
        + `<ul class="lines">${t.lines.map(lineHtml).join('')}</ul></details></li>`;
    }).join('') + '</ol>';
    h += '<p class="fine">回饋金額取到小數一位；回饋率為官方標示的「最高」值，細則以台新官網為準。</p></div>';
    box.innerHTML = h;
  }

  // ---- 方案一覽 ----

  function renderPlanList() {
    const year = S.date.slice(0, 4); // 截止日顯示格式隨年份變，同一年內不重畫（保留展開狀態）
    if (S.planListYear === year) return;
    S.planListYear = year;
    $('#planList').innerHTML = S.index.plans.map((p) => {
      const chs = p.channels.map((ch) => {
        let li = `<li><div class="ch-name">${ch.theme ? `#${esc(ch.theme)}・` : ''}${esc(ch.name)}`
          + ` <span class="rate">${R.fmtRate(ch.rate_pct)}%</span></div>`;
        if (ch.scope) li += `<div class="muted">${esc(ch.scope)}</div>`;
        if (ch.stores && ch.stores.length) {
          li += `<div class="stores">${esc(ch.stores.join('、'))}${ch.stores_complete === false ? ' 等' : ''}</div>`;
        }
        if (ch.note) li += `<div class="muted">${esc(ch.note)}</div>`;
        if (ch.perk) li += `<div class="muted">${esc(ch.perk)}</div>`;
        if (ch.added) {
          li += `<div class="muted">${esc(Object.entries(ch.added).map(([k, v]) => `${k} ${R.fmtDate(v)} 起`).join('、'))}</div>`;
        }
        return `${li}</li>`;
      }).join('');
      return `<details class="plan-card"><summary><span class="plan">${esc(p.name)}</span>`
        + `<span class="rate">最高 ${R.fmtRate(p.max_rate_pct)}%</span><span class="badge">${esc(planEnd(p))}</span></summary>`
        + `<p class="muted">活動期間 ${R.fmtDate(p.period.start)}–${R.fmtDate(p.period.end)}${p.tagline ? `・${esc(p.tagline)}` : ''}</p>`
        + (p.note ? `<p class="muted">${esc(p.note)}</p>` : '')
        + `<ul class="channels">${chs}</ul></details>`;
    }).join('');
  }

  init();
})();
