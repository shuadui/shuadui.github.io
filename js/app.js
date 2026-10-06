/* 介面：讀資料、全域設定、查店家、清單外店家、今日試算。判斷邏輯都在 js/rules.js。 */
(function () {
  'use strict';

  const R = window.RichartRules;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt1 = (x) => R.round1(x).toFixed(1);
  const fmtAmount = (n) => n.toLocaleString('zh-TW');

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
    payment: '刷卡',
    currentPlan: null,
    baseRate: 0,
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
    const savedPay = prefs.get('payment', '刷卡');
    S.payment = R.PAYMENTS.includes(savedPay) ? savedPay : '刷卡';
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
    fillSelect($('#payment'), R.PAYMENTS, S.payment);
    fillSelect($('#calcPayment'), R.PAYMENTS, S.payment);
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
    $('#payment').addEventListener('change', (e) => {
      S.payment = e.target.value;
      prefs.set('payment', S.payment);
      $('#calcPayment').value = S.payment;
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
  }

  // ---- 查店家 ----

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
    const item = { store: s, payment: S.payment, overseas: S.lookup.overseas, dining: false };
    const rows = R.rankPlans(S.index, item, ctx(), S.currentPlan);
    const adv = R.advise(rows, S.currentPlan);
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
    h += adviceHtml(adv);
    h += rowsHtml(rows, adv);
    h += '</article>';
    return h;
  }

  function adviceHtml(adv) {
    const cur = S.currentPlan;
    if (adv.kind === 'none') return '<div class="advice none">沒有方案有加碼回饋</div>';
    if (adv.kind === 'base') {
      return `<div class="advice none">沒有方案高於基本回饋 ${R.fmtRate(adv.best.r.rate)}%</div>`;
    }
    if (adv.kind === 'stay') return `<div class="advice stay">目前方案「${esc(cur)}」就是最佳，不用切</div>`;
    const curText = adv.cur && adv.cur.r.rate > 0 ? `${R.fmtRate(adv.cur.r.rate)}%` : '沒有回饋';
    return `<div class="advice switch">建議切到 <strong>${esc(adv.best.plan.name)}</strong>（+${R.fmtRate(adv.diff)}%）`
      + `<small>目前方案 ${esc(cur)}：${curText}</small></div>`;
  }

  function factList(r) {
    const facts = [`類別：${r.channel}${r.theme ? `（#${r.theme}）` : ''}`];
    if (r.condition) facts.push(`條件：${r.condition}`);
    if (r.scope) facts.push(`範圍：${r.scope}`);
    if (r.note) facts.push(`附註：${r.note}`);
    if (r.perk) facts.push(`另享：${r.perk}`);
    return facts;
  }

  function bestHtml(x) {
    return '<div class="best">'
      + `<div class="best-top"><span class="plan">${esc(x.plan.name)}</span><span class="rate">${R.fmtRate(x.r.rate)}%</span></div>`
      + `<ul class="facts">${factList(x.r).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      + `<span class="badge">${esc(planEnd(x.plan))}</span>`
      + '</div>';
  }

  function otherHtml(x) {
    const r = x.r;
    const bits = [r.base ? '一般消費（基本回饋）' : `${r.channel}${r.theme ? `（#${r.theme}）` : ''}`];
    if (r.condition) bits.push(r.condition);
    if (r.base && r.reason) bits.push(r.reason);
    bits.push(planEnd(x.plan));
    return `<li><span class="plan">${esc(x.plan.name)}</span><span class="rate">${R.fmtRate(r.rate)}%</span>`
      + `<span class="muted">${esc(bits.join('・'))}</span></li>`;
  }

  function rowsHtml(rows, adv) {
    let h = '';
    const ok = rows.filter((x) => x.r.rate > 0);
    if (adv.kind === 'switch' || adv.kind === 'stay') {
      h += bestHtml(ok[0]);
      if (ok.length > 1) h += `<h3 class="sub-head">其他可用方案</h3><ol class="others">${ok.slice(1).map(otherHtml).join('')}</ol>`;
    }
    const bad = rows.filter((x) => x.r.rate <= 0 && x.r.reason);
    if (bad.length) {
      h += `<details class="na"><summary>不適用的方案（${bad.length}）</summary><ul>`
        + bad.map((x) => `<li><span class="plan">${esc(x.plan.name)}</span>${esc(x.r.reason)}</li>`).join('')
        + '</ul></details>';
    }
    h += '<p class="fine">回饋率為官方標示的「最高」值，細則以台新官網為準。</p>';
    return h;
  }

  // ---- 清單上沒有的店 ----

  function renderOfflist() {
    document.querySelectorAll('#offlistKinds button')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === S.lookup.kind)));
    const box = $('#offlistResult');
    const kind = S.lookup.kind;
    if (!kind) {
      box.innerHTML = '';
      return;
    }
    const item = { store: null, payment: S.payment, overseas: kind === 'overseas', dining: kind === 'dining' };
    const c = ctx();
    const rows = R.rankPlans(S.index, item, c, S.currentPlan);
    const adv = R.advise(rows, S.currentPlan);
    const kindText = { dining: '國內餐飲', overseas: '海外消費', general: '國內其他消費' }[kind];
    box.innerHTML = `<p class="hint">${esc(kindText)}・${esc(S.payment)}・${c.holiday ? '假日' : '平日'}</p>`
      + adviceHtml(adv) + rowsHtml(rows, adv);
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
    $('#calcPayment').value = S.payment;
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
        + `<small>比目前方案 ${esc(S.currentPlan)}（約 NT$${fmt1(curV)}）多約 NT$${fmt1(topV - curV)}</small></div>`;
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
