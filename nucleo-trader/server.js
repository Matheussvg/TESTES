'use strict';
// Núcleo Trader — robô de trade simulado rodando 24h no servidor, em vários ativos.
// Lê preços reais da Binance, escolhe a melhor estratégia por torneio e opera com dinheiro fictício.
// Cada ativo tem sua própria conta simulada, seu próprio torneio e seus próprios relatórios de 24h.
const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const META = {
  BTCBRL: { nome: 'Bitcoin', curto: 'BTC', prec: 0 },
  USDTBRL: { nome: 'Dólar digital (USDT)', curto: 'DÓLAR', prec: 3 },
  ETHBRL: { nome: 'Ethereum', curto: 'ETH', prec: 0 },
  SOLBRL: { nome: 'Solana', curto: 'SOL', prec: 2 },
  BNBBRL: { nome: 'BNB', curto: 'BNB', prec: 1 },
  XRPBRL: { nome: 'XRP', curto: 'XRP', prec: 3 },
};
const SYMBOLS = (process.env.SYMBOLS || 'BTCBRL,USDTBRL,ETHBRL').split(',').map(s => s.trim().toUpperCase()).filter(s => META[s]);
const PORT = +process.env.PORT || 10000;
const MODE_ID = E.MODES[process.env.MODE] ? process.env.MODE : 'v1';
const MODE = E.MODES[MODE_ID];
const LIVE_TFS = MODE.trend && !MODE.tfs.includes('1h') ? [...MODE.tfs, '1h'] : MODE.tfs;
const FAST = MODE.tfs[0];   // tempo mais curto: dá o preço ao vivo e o ritmo do torneio
const CFG = {
  cap: +(process.env.CAPITAL || 10000),
  lev: +(process.env.LEVERAGE || 1),
  costPct: MODE.feePct,                            // taxa por lado, em %
  evalMs: +(process.env.EVAL_SECONDS || MODE.evalS) * 1000,
  always: process.env.ALWAYS === '1',
};
const COST = CFG.costPct / 100;
const REST = process.env.DATA_URL ? [process.env.DATA_URL] : ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com', 'https://api3.binance.com'];
const HIST = 500, MAXC = 700, DAY = 864e5;
const TZ = 'America/Sao_Paulo';
const BOOT = Date.now();

const nf = (v, d) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const brl = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (v, d = 2) => (v >= 0 ? '+' : '') + nf(v * 100, d) + '%';
const quando = t => new Date(t).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/* ---------------- persistência (Render Key Value) ---------------- */
let redis = null;
async function initRedis() {
  const url = process.env.REDIS_URL;
  if (!url) { console.log('Sem REDIS_URL: estado só em memória.'); return }
  try {
    const { createClient } = require('redis');
    redis = createClient({ url, socket: { reconnectStrategy: r => Math.min(r * 500, 10000) } });
    redis.on('error', e => console.error('redis:', e.message));
    await redis.connect();
  } catch (e) { console.error('redis indisponível:', e.message); redis = null }
}

/* ---------------- dados de mercado (REST só para histórico) ---------------- */
const toC = k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
let cooldownUntil = 0;
async function fetchJSON(p) {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) throw new Error('aguardando a Binance liberar o acesso (' + Math.ceil(wait / 1000) + ' s)');
  let err;
  for (const h of REST) {
    try {
      const r = await fetch(h + p, { signal: AbortSignal.timeout(8000) });
      if (r.status === 429 || r.status === 418) {
        const ra = Math.max(30, +r.headers.get('retry-after') || 60);
        cooldownUntil = Date.now() + ra * 1000;
        throw new Error('Binance pediu para esperar ' + ra + ' s (HTTP ' + r.status + ')');
      }
      if (!r.ok) throw new Error(h + ' HTTP ' + r.status);
      return await r.json();
    } catch (e) { err = e; if (cooldownUntil > Date.now()) break }
  }
  throw err;
}

/* ================= um robô por ativo ================= */
function createBot(SYMBOL) {
  const M = META[SYMBOL], KEY = 'nt:state:' + SYMBOL;
  const S = {
    candles: {}, price: null, lastTick: 0, ranking: [], active: null, pending: null,
    votes: null, bias: 0, lastTour: 0, startedAt: Date.now(), acc: null, logs: [], reports: [],
    win: null, dataOk: false, lastErr: null, ready: false, archive: [],
  };
  const freshAcc = () => ({ start: CFG.cap, bal: CFG.cap, pos: null, trades: [], eqHist: [], peak: CFG.cap, mdd: 0, fees: 0 });
  const fmtPx = v => v == null ? '—' : nf(v, M.prec);

  function log(msg, cls = '') {
    S.logs.unshift({ t: Date.now(), msg, cls });
    if (S.logs.length > 300) S.logs.length = 300;
    console.log(new Date().toISOString(), '[' + M.curto + ']', msg);
  }
  function equity(p = S.price) { const a = S.acc; if (!a.pos || p == null) return a.bal; return a.bal + a.pos.dir * (p - a.pos.entry) * a.pos.qty }

  let saving = false, again = false, lastSave = 0;
  async function save(force) {
    if (!redis || !S.acc) return;
    if (saving) { if (force) again = true; return }
    if (!force && Date.now() - lastSave < 30000) return;
    saving = true;
    try {
      const data = { v: 1, mode: MODE_ID, startedAt: S.startedAt, acc: S.acc, logs: S.logs.slice(0, 200), reports: S.reports, win: S.win, archive: S.archive };
      await redis.set(KEY, JSON.stringify(data)); lastSave = Date.now();
    } catch (e) { console.error('save:', e.message) }
    saving = false;
    if (again) { again = false; save(true) }
  }
  async function init() {
    let st = null;
    if (redis) try { const s = await redis.get(KEY); st = s ? JSON.parse(s) : null } catch (e) { console.error('load:', e.message) }
    if (st && st.acc && (st.mode || 'v1') !== MODE_ID) {
      // nova versão do robô: guarda o resultado do teste anterior e começa um teste novo, do zero
      const a = st.acc, px0 = a.eqHist && a.eqHist.length ? a.eqHist[0][2] : null, px1 = a.eqHist && a.eqHist.length ? a.eqHist[a.eqHist.length - 1][2] : null, eqv = a.bal + (a.pos && px1 ? a.pos.dir * (px1 - a.pos.entry) * a.pos.qty : 0);
      S.archive = (st.archive || []).concat([{ mode: st.mode || 'v1', inicio: st.startedAt, fim: Date.now(), start: a.start, eq: eqv, ret: eqv / a.start - 1, trades: a.trades.length, wins: a.trades.filter(t => t.net > 0).length, fees: a.fees || 0, mdd: a.mdd, hold: px0 && px1 ? px1 / px0 - 1 : null, dias: st.reports ? st.reports.length : 0 }]);
      S.logs = st.logs || [];
      S.acc = freshAcc();
      const ar = S.archive[S.archive.length - 1];
      log(`Teste da ${ar.mode} encerrado e guardado: ${pct(ar.ret)} em ${ar.trades} operações (taxas ${brl(ar.fees)}). Começo um teste novo de 7 dias com a ${MODE.nome}, com ${brl(CFG.cap)} simulados.`, 'k');
    } else if (st && st.acc) {
      S.archive = st.archive || [];
      S.startedAt = st.startedAt; S.acc = st.acc; S.logs = st.logs || []; S.reports = st.reports || []; S.win = st.win || null;
      if (S.acc.fees == null) S.acc.fees = 0;
      log(`Servidor reiniciado: retomei a conta (${brl(S.acc.bal)} de saldo, ${S.acc.trades.length} operações, dia ${S.reports.length + 1}).`, 'k');
    } else {
      S.acc = freshAcc();
      log(`Robô iniciado em ${M.nome} (${SYMBOL}) com ${brl(CFG.cap)} simulados · alavancagem ${CFG.lev}x · taxa ${nf(CFG.costPct, 2)}% por lado (igual à Binance).`, 'k');
    }
  }
  async function loadHistory() {
    const out = {};
    for (const tf of LIVE_TFS) {
      const d = await fetchJSON(`/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${HIST}`);
      out[tf] = d.map(toC);
    }
    S.candles = out;
  }
  function afterHistory(first) {
    const one = S.candles[FAST]; S.price = one[one.length - 1].c; S.lastTick = Date.now(); S.dataOk = true;
    if (!first) return;
    log(`Histórico carregado: ${LIVE_TFS.map(t => S.candles[t].length + '×' + t).join(', ')}.`);
    if (!S.win) S.win = newWindow(S.startedAt);
    if (!S.acc.eqHist.length) S.acc.eqHist.push([Date.now(), S.acc.bal, S.price]);
    runTournament(true);
    if (S.acc.pos) {
      const r = S.ranking.find(x => x.key === S.acc.pos.key);
      if (r) S.active = r;
      log(`Retomei a posição aberta de ${S.acc.pos.dir > 0 ? 'compra' : 'venda'} a ${fmtPx(S.acc.pos.entry)}.`, 'k');
    }
    updateVotes(); save(true); S.ready = true;
  }
  function onKline(k) {
    if (!S.ready) return;
    const tf = k.i, arr = S.candles[tf]; if (!arr) return;
    const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }, last = arr[arr.length - 1];
    if (last && last.t === c.t) arr[arr.length - 1] = c;
    else if (!last || c.t > last.t) { arr.push(c); if (arr.length > MAXC) arr.shift() }
    else return;
    S.dataOk = true; S.lastErr = null;
    if (tf === FAST) tick(c.c);
    if (k.x) candleClosed(tf, arr.length - 1);
  }

  /* ---- cérebro ---- */
  function rowOf(r) { return r && { key: r.key, tf: r.tf, nome: r.st.nome, fam: r.st.fam, f: r.st.f || null, risco: r.rk.nome, perDay: r.perDay, win: r.win, trades: r.trades, mdd: r.mdd, score: r.score } }
  function runTournament(reason) {
    const t0 = Date.now(); const res = E.tournament(S.candles, COST, { tfs: MODE.tfs, longOnly: MODE.longOnly, oos: MODE.oos, allowLong: MODE.trend ? E.makeTrend(S.candles['1h']) : null });
    S.ranking = res; S.lastTour = Date.now();
    const best = res[0]; if (!best) return;
    const ok = best.score > 0 || CFG.always;
    if (reason) log(`Torneio: testei ${res.length} combinações (${E.STRATS.length} estratégias × ${MODE.tfs.length} tempos × ${E.RISKS.length} perfis de stop) em ${Date.now() - t0} ms.`);
    const cur = S.active && S.active.key;
    if (!ok) {
      if (S.active && !S.acc.pos) { log(`Nenhuma estratégia está ganhando depois das taxas. Melhor: ${best.st.nome} em ${best.tf} com ${pct(best.perDay, 3)}/dia. Fico de fora.`, 'w'); S.active = null }
      else if (!S.active && reason) log(`Nenhuma estratégia passou do zero depois das taxas (melhor: ${pct(best.perDay, 3)}/dia). Fico de fora e sigo observando.`, 'w');
      if (S.acc.pos) S.pending = null;
    } else if (best.key !== cur) {
      if (S.acc.pos) { if (!S.pending || S.pending.key !== best.key) { S.pending = best; log(`Nova líder: ${best.st.nome} em ${best.tf}. Troco quando a posição atual fechar.`) } }
      else { S.active = best; S.pending = null; log(`Assumo ${best.st.nome} no gráfico de ${best.tf} (${best.rk.nome}): ${pct(best.perDay, 3)}/dia no histórico, ${nf(best.win * 100, 0)}% de acerto em ${best.trades} operações.`, 'k') }
    } else if (reason) log(`Mantenho ${best.st.nome} em ${best.tf}: segue na liderança com ${pct(best.perDay, 3)}/dia.`);
    else S.active = best;
  }
  function updateVotes() {
    const tf = S.active ? S.active.tf : '5m', c = S.candles[tf]; if (!c || c.length < E.WARM) return;
    const I = E.makeInd(c); S.votes = E.votes(I, c.length - 1); S.votesTf = tf;
    const v = S.votes; S.bias = (v.tend + v.mom + v.forca + v.bandas + v.romp) / 5;
  }
  function why(I, i, act, s) {
    const v = E.votes(I, i), parts = ['RSI ' + nf(I.rsi(14)[i], 1), 'tendência ' + (v.tend > 0 ? 'de alta' : 'de baixa')];
    if (act.st.fam === 'reversão') parts.push(s > 0 ? 'preço esticado para baixo' : 'preço esticado para cima');
    if (act.st.fam === 'rompimento') parts.push(s > 0 ? 'rompeu a máxima recente' : 'perdeu a mínima recente');
    return parts.join(' · ');
  }
  function candleClosed(tf, idx) {
    if (tf === FAST && Date.now() - S.lastTour >= CFG.evalMs) runTournament(true);
    if (tf === FAST) updateVotes();
    const act = S.active; if (!act || act.tf !== tf || S.price == null) return;
    const c = S.candles[tf], I = E.makeInd(c), a = S.acc, px = S.price;
    let s = act.st.sig(I, idx);
    const tag = `${act.st.nome} (${tf})`;
    if (s === null) return;
    if (MODE.longOnly && s === -1) s = 0;          // à vista na Binance não dá para vender a descoberto: sinal de venda = sair para o caixa
    if (s === 1 && MODE.trend && !a.pos && !E.makeTrend(S.candles['1h'])(c[idx].t + E.TFMS[tf])) {
      if (Date.now() - (S.lastTrendLog || 0) > 3600e3) { S.lastTrendLog = Date.now(); log(`Sinal de compra de ${tag} ignorado: o 1h está abaixo da média de 200 (tendência de baixa).`, 'w') }
      return;
    }
    if (s === 0) { if (a.pos) closePos(px, 'sinal de saída de ' + tag); return }
    if (a.pos && a.pos.dir === s) return;
    if (a.pos) closePos(px, 'sinal contrário de ' + tag);
    if (S.active !== act) return;
    if (S.pending) { S.active = S.pending; S.pending = null; log(`Troco para ${S.active.st.nome} em ${S.active.tf}.`, 'k'); return }
    const atr = I.atr(14)[idx]; if (!(atr > 0)) return;
    openPos(s, px, atr, act, why(I, idx, act, s));
  }
  function openPos(dir, px, atr, act, reason) {
    const a = S.acc, notional = equity(px) * CFG.lev, qty = notional / px, fee = notional * COST;
    a.bal -= fee; a.fees += fee;
    a.pos = { dir, entry: px, qty, sl: px - dir * act.rk.sl * atr, tp: px + dir * act.rk.tp * atr, t: Date.now(), strat: act.st.nome, tf: act.tf, key: act.key, fee };
    log(`${dir > 0 ? 'COMPRA' : 'VENDA'} simulada a ${fmtPx(px)} · ${act.st.nome} (${act.tf}) · ${reason}. Stop ${fmtPx(a.pos.sl)}, alvo ${fmtPx(a.pos.tp)}.`, dir > 0 ? 'b' : 's');
    save(true);
  }
  function closePos(px, reason) {
    const a = S.acc, p = a.pos; if (!p) return;
    const gross = p.dir * (px - p.entry) * p.qty, fee = px * p.qty * COST, net = gross - fee - p.fee;
    a.bal += gross - fee; a.fees += fee;
    a.trades.unshift({ dir: p.dir, entry: p.entry, exit: px, t0: p.t, t1: Date.now(), net, fees: fee + p.fee, strat: p.strat, tf: p.tf, reason });
    if (a.trades.length > 2000) a.trades.length = 2000;
    a.pos = null;
    log(`Encerrei ${p.dir > 0 ? 'compra' : 'venda'} a ${fmtPx(px)} (${reason}): ${net >= 0 ? 'ganho' : 'perda'} de ${brl(Math.abs(net))} já com taxas.`, net >= 0 ? 'b' : 's');
    if (S.pending) { S.active = S.pending; S.pending = null; log(`Agora assumo ${S.active.st.nome} em ${S.active.tf}.`, 'k') }
    save(true);
  }
  function tick(px) {
    S.price = px; S.lastTick = Date.now();
    const a = S.acc, p = a.pos;
    if (p) {
      if (p.dir > 0 && px <= p.sl) closePos(px, 'stop'); else if (p.dir > 0 && px >= p.tp) closePos(px, 'alvo atingido');
      else if (p.dir < 0 && px >= p.sl) closePos(px, 'stop'); else if (p.dir < 0 && px <= p.tp) closePos(px, 'alvo atingido');
    }
    const eq = equity(px); if (eq > a.peak) a.peak = eq; const dd = 1 - eq / a.peak; if (dd > a.mdd) a.mdd = dd;
    const h = a.eqHist, now = Date.now();
    if (!h.length || now - h[h.length - 1][0] >= 60000) { h.push([now, Math.round(eq * 100) / 100, px]); if (h.length > 15000) h.shift() }
    trackWindow();
    save();
  }

  /* ---- relatórios de 24h ---- */
  function newWindow(start) { const eq = equity(); return { start, eq0: eq, px0: S.price, peak: eq, mdd: 0, inMkt: 0, lastT: Date.now() } }
  function summarize(w, end) {
    const eq = equity(), tr = S.acc.trades.filter(t => t.t1 >= w.start && t.t1 < end), wins = tr.filter(t => t.net > 0);
    const est = {}; for (const t of tr) est[t.strat + ' ' + t.tf] = (est[t.strat + ' ' + t.tf] || 0) + 1;
    return {
      dia: S.reports.length + 1, inicio: w.start, fim: end, eq0: w.eq0, eq1: eq, pnl: eq - w.eq0, pct: eq / w.eq0 - 1,
      btc0: w.px0, btc1: S.price, btcPct: w.px0 ? S.price / w.px0 - 1 : 0,
      ops: tr.length, acertos: wins.length, taxa: tr.length ? wins.length / tr.length : null,
      melhor: tr.length ? Math.max(...tr.map(t => t.net)) : null, pior: tr.length ? Math.min(...tr.map(t => t.net)) : null,
      taxas: tr.reduce((s, t) => s + (t.fees || 0), 0), mdd: w.mdd,
      tempoPosicionado: Math.min(1, w.inMkt / Math.max(1, Math.min(end, Date.now()) - w.start)),
      estrategias: est, totalPct: eq / S.acc.start - 1, posAberta: !!S.acc.pos,
    };
  }
  function trackWindow() {
    if (!S.win) S.win = newWindow(S.startedAt);
    const w = S.win, now = Date.now(), eq = equity();
    if (S.acc.pos) w.inMkt += now - w.lastT; w.lastT = now;
    if (eq > w.peak) w.peak = eq; const dd = 1 - eq / w.peak; if (dd > w.mdd) w.mdd = dd;
    const end = S.startedAt + (S.reports.length + 1) * DAY;
    if (now >= end) {
      const r = summarize(w, end); S.reports.push(r);
      log(`Relatório do dia ${r.dia}: ${pct(r.pct)} (${brl(r.pnl)}) em ${r.ops} operações · ${M.curto} no período ${pct(r.btcPct)}.`, r.pnl >= 0 ? 'b' : 's');
      S.win = newWindow(end); save(true);
    }
  }
  function holdPct() { const px0 = S.acc.eqHist.length ? S.acc.eqHist[0][2] : null; return px0 && S.price ? S.price / px0 - 1 : null }
  function reportText() {
    const a = S.acc, eq = equity(), days = (Date.now() - S.startedAt) / DAY, L = [];
    L.push(`=== ${M.nome} (${SYMBOL}) ===`);
    for (const ar of S.archive) L.push(`Teste anterior (${ar.mode}, ${quando(ar.inicio)} → ${quando(ar.fim)}): ${pct(ar.ret)} em ${ar.trades} operações, taxas ${brl(ar.fees)}, ${M.curto} parado ${ar.hold == null ? '—' : pct(ar.hold)}.`);
    L.push(`Rodando desde ${quando(S.startedAt)} (${nf(days, 1)} dias, dia ${Math.floor(days) + 1} do teste). Dados ${S.dataOk ? 'ao vivo' : 'COM FALHA: ' + (S.lastErr || '')}. Último preço ${fmtPx(S.price)} às ${quando(S.lastTick)}.`);
    L.push(`Patrimônio ${brl(eq)} · resultado total ${pct(eq / a.start - 1)} (${brl(eq - a.start)}) · ${a.trades.length} operações · acerto ${a.trades.length ? nf(a.trades.filter(t => t.net > 0).length / a.trades.length * 100, 0) + '%' : '—'} · taxas pagas ${brl(a.fees)} · maior queda ${nf(a.mdd * 100, 2)}%.`);
    const h = holdPct(); if (h != null) L.push(`Comparação: ${M.curto} parado no mesmo período ${pct(h)}.`);
    L.push(a.pos ? `Posição aberta: ${a.pos.dir > 0 ? 'COMPRA' : 'VENDA'} a ${fmtPx(a.pos.entry)} (${a.pos.strat} ${a.pos.tf}), resultado aberto ${brl(a.pos.dir * (S.price - a.pos.entry) * a.pos.qty)}.` : 'Sem posição aberta.');
    L.push(S.active ? `Estratégia atual: ${S.active.st.nome} em ${S.active.tf}.` : 'Sem estratégia ativa (nenhuma vence as taxas agora).');
    for (const r of S.reports.slice().reverse()) L.push(`Dia ${r.dia} (${quando(r.inicio)} → ${quando(r.fim)}): ${pct(r.pct)} (${brl(r.pnl)}) · ${r.ops} ops · acerto ${r.taxa == null ? '—' : nf(r.taxa * 100, 0) + '%'} · melhor ${r.melhor == null ? '—' : brl(r.melhor)} · pior ${r.pior == null ? '—' : brl(r.pior)} · taxas ${brl(r.taxas)} · maior queda ${nf(r.mdd * 100, 2)}% · posicionado ${nf(r.tempoPosicionado * 100, 0)}% do tempo · ${M.curto} ${pct(r.btcPct)} · acumulado ${pct(r.totalPct)}.`);
    if (S.win) { const p = summarize(S.win, Date.now()); L.push(`Parcial de hoje (desde ${quando(S.win.start)}): ${pct(p.pct)} (${brl(p.pnl)}) · ${p.ops} ops · ${M.curto} ${pct(p.btcPct)}.`) }
    return L.join('\n');
  }
  function estado() {
    if (!S.dataOk && S.lastTick === 0) return 'iniciando'; if (!S.dataOk) return 'sem-dados';
    const a = S.acc; if (a.pos) return a.pos.dir > 0 ? 'comprado' : 'vendido'; if (S.active) return 'espreita'; if (S.ranking.length) return 'fora'; return 'iniciando';
  }
  function ch24() { const c = S.candles['1h']; return c && c.length > 25 && S.price ? S.price / c[c.length - 25].c - 1 : null }
  function overview() {
    const a = S.acc, eq = a ? equity() : CFG.cap;
    return { symbol: SYMBOL, nome: M.nome, curto: M.curto, prec: M.prec, price: S.price, ch24: ch24(), eq, start: a ? a.start : CFG.cap, nTrades: a ? a.trades.length : 0, estado: estado(), hold: a ? holdPct() : null, startedAt: S.startedAt };
  }
  function statePayload() {
    const a = S.acc, eq = equity(), h = a.eqHist, step = Math.max(1, Math.ceil(h.length / 400));
    const eqHist = h.filter((_, i) => i % step === 0 || i === h.length - 1).map(x => [x[0], x[1], x[2]]);
    return {
      symbol: SYMBOL, meta: M, now: Date.now(), startedAt: S.startedAt, bootAt: BOOT, cfg: { cap: CFG.cap, lev: CFG.lev, costPct: CFG.costPct, evalS: CFG.evalMs / 1000, mode: MODE_ID, modeNome: MODE.nome, tfs: MODE.tfs }, archive: S.archive,
      price: S.price, lastTick: S.lastTick, ch24: ch24(), dataOk: S.dataOk, lastErr: S.lastErr, estado: estado(),
      active: rowOf(S.active), pending: rowOf(S.pending), votes: S.votes, votesTf: S.votesTf, bias: S.bias,
      ranking: S.ranking.slice(0, 12).map(rowOf), combos: S.ranking.length, lastTour: S.lastTour,
      acc: { start: a.start, bal: a.bal, eq, peak: a.peak, mdd: a.mdd, fees: a.fees, pos: a.pos, nTrades: a.trades.length, wins: a.trades.filter(t => t.net > 0).length },
      trades: a.trades.slice(0, 200), logs: S.logs.slice(0, 80), reports: S.reports,
      parcial: S.win ? summarize(S.win, Date.now()) : null, eqHist,
      btc0: a.eqHist.length ? a.eqHist[0][2] : null,
    };
  }
  function periodic() { if (S.ready && S.ranking.length && Date.now() - S.lastTour > CFG.evalMs * 2) runTournament(false) }
  function setDataError(msg) { S.lastErr = msg }
  function markStale() { S.dataOk = false }
  // histórico de velas guardado no banco: um reinício não depende da API da Binance (que bloqueia IPs compartilhados)
  async function loadCache() {
    if (!redis) return false;
    try {
      const raw = await redis.get('nt:candles:' + SYMBOL); if (!raw) return false;
      const d = JSON.parse(raw);
      if (Date.now() - d.savedAt > 12 * 3600e3) return false;
      if (!LIVE_TFS.every(tf => d.candles[tf] && d.candles[tf].length > E.WARM + 60)) return false;
      S.candles = d.candles; return d.savedAt;
    } catch (e) { return false }
  }
  async function saveCache() {
    if (!redis || !S.ready) return;
    try { const c = {}; for (const tf of LIVE_TFS) c[tf] = (S.candles[tf] || []).slice(-500); await redis.set('nt:candles:' + SYMBOL, JSON.stringify({ savedAt: Date.now(), candles: c })) }
    catch (e) { console.error('cache:', e.message) }
  }
  return { SYMBOL, M, S, init, loadHistory, afterHistory, loadCache, saveCache, onKline, save, summarize, reportText, statePayload, overview, periodic, setDataError, markStale, log, equity };
}

const bots = {}; for (const s of SYMBOLS) bots[s] = createBot(s);
const list = () => SYMBOLS.map(s => bots[s]);
async function loadAllHistory() { for (const b of list()) await b.loadHistory() }

/* ---------------- WebSocket: um só para todos os ativos ---------------- */
const WSS = process.env.WS_URL ? [process.env.WS_URL] : ['wss://data-stream.binance.vision/stream?streams=', 'wss://stream.binance.com:9443/stream?streams='];
let ws = null, wsIdx = 0, lastMsg = 0, reconnecting = false, warned = false;
function connectWS() {
  const streams = SYMBOLS.flatMap(s => LIVE_TFS.map(t => s.toLowerCase() + '@kline_' + t)).join('/');
  const url = WSS[wsIdx % WSS.length] + streams;
  let me;
  try { me = ws = new WebSocket(url) } catch (e) { return scheduleReconnect('erro ao abrir a conexão: ' + e.message) }
  me.onopen = () => { if (me !== ws) return; lastMsg = Date.now(); console.log('WebSocket conectado:', url.split('?')[0], SYMBOLS.join(',')) };
  me.onmessage = ev => {
    if (me !== ws) return; lastMsg = Date.now();
    try {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)), k = m.data && m.data.k;
      if (k) { const b = bots[k.s || m.data.s]; if (b) b.onKline(k) }
      if (warned) { warned = false; for (const b of list()) b.log('Dados da Binance voltaram ao normal.', 'k') }
    } catch (e) { console.error('mensagem inválida:', e.message) }
  };
  me.onclose = () => { if (me === ws) scheduleReconnect('conexão com a Binance caiu') };
  me.onerror = () => { try { me.close() } catch (e) { } };
}
function scheduleReconnect(why) {
  if (reconnecting) return; reconnecting = true;
  if (ws) { const o = ws; ws = null; try { o.onclose = null; o.close() } catch (e) { } }
  for (const b of list()) b.setDataError(why);
  wsIdx++;
  // reconecta o preço ao vivo na hora; o buraco de velas é completado depois, quando a API deixar
  setTimeout(() => { reconnecting = false; connectWS(); backfill() }, 5000);
}
let backfilling = false;
async function backfill() {
  if (backfilling) return; backfilling = true;
  for (;;) {
    try { await loadAllHistory(); for (const b of list()) b.afterHistory(false); break }
    catch (e) { const w = Math.max(60000, cooldownUntil - Date.now()); console.log('completar histórico adiado ' + Math.round(w / 1000) + ' s:', e.message); await new Promise(r => setTimeout(r, w)) }
  }
  backfilling = false;
}
setInterval(() => {
  if (!lastMsg || reconnecting) return;
  if (Date.now() - lastMsg > 60000) {
    for (const b of list()) b.markStale();
    if (!warned) { warned = true; for (const b of list()) b.log('Sem preço da Binance há mais de 1 minuto. Reconectando.', 'w') }
    lastMsg = Date.now(); scheduleReconnect('sem mensagens da Binance');
  }
}, 15000);

/* ---------------- laboratório: compara as versões nos últimos dias reais ---------------- */
const { Worker } = require('worker_threads');
const LAB = { status: 'parado', startedAt: null, finishedAt: null, results: null, error: null, period: null };
async function fetchRange(sym, tf, total) {
  let out = [], end = Date.now();
  while (out.length < total) {
    let d;
    try { d = await fetchJSON(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${Math.min(1000, total - out.length)}&endTime=${end}`) }
    catch (e) {
      if (cooldownUntil <= Date.now()) throw e;
      LAB.status = 'aguardando a Binance liberar o acesso'; await new Promise(r => setTimeout(r, cooldownUntil - Date.now() + 2000)); LAB.status = 'baixando dados'; continue;
    }
    if (!d.length) break;
    out = d.map(toC).concat(out); end = d[0][0] - 1;
    await new Promise(r => setTimeout(r, 1000));
  }
  return out;
}
async function runLab(days) {
  LAB.status = 'baixando dados'; LAB.startedAt = Date.now(); LAB.error = null;
  try {
    const now = Date.now(), H = 3600e3, testEnd = Math.floor(now / H) * H, testStart = testEnd - days * 864e5, data = {};
    for (const sym of SYMBOLS) {
      data[sym] = {};
      for (const tf of ['5m', '15m', '1h', '4h']) data[sym][tf] = await fetchRange(sym, tf, 520 + Math.ceil((now - testStart) / E.TFMS[tf]) + 2);
    }
    LAB.status = 'simulando';
    LAB.results = await new Promise((res, rej) => {
      const w = new Worker(path.join(__dirname, 'lab.js'), { workerData: { data, modes: ['v2', 'v3', 'v4'], testStart, testEnd, step: H } });
      w.once('message', res); w.once('error', rej); w.once('exit', c => { if (c) rej(new Error('simulação parou com código ' + c)) });
    });
    LAB.period = { testStart, testEnd, days }; LAB.status = 'pronto'; LAB.finishedAt = Date.now();
  } catch (e) { LAB.status = 'erro'; LAB.error = e.message; console.error('lab:', e) }
}
function labText() {
  if (LAB.status !== 'pronto') return `Laboratório: ${LAB.status}${LAB.error ? ' (' + LAB.error + ')' : ''}${LAB.startedAt ? ', iniciado ' + quando(LAB.startedAt) : ''}. Abra /lab?run=1 para rodar.`;
  const L = [`LABORATÓRIO — robô inteiro reproduzido de ${quando(LAB.period.testStart)} a ${quando(LAB.period.testEnd)} (${LAB.period.days} dias), escolhendo a estratégia a cada hora só com o passado. R$ 10.000 por ativo.`, ''];
  for (const id of Object.keys(Object.values(LAB.results)[0] || {})) L.push(`${id}: ${E.MODES[id].nome}`);
  L.push('(a v1 original já tem o resultado real ao vivo, então não precisa ser reproduzida)');
  for (const sym of Object.keys(LAB.results)) {
    L.push('', `=== ${META[sym].nome} (${sym}) — ativo parado no período: ${pct(Object.values(LAB.results[sym])[0].hold)} ===`);
    for (const [id, r] of Object.entries(LAB.results[sym])) L.push(`${id}: resultado ${pct(r.ret)} (${brl(r.ret * CFG.cap)}) · ${r.trades} operações · acerto ${r.win == null ? '—' : nf(r.win * 100, 0) + '%'} · taxas ${brl(r.fees * CFG.cap)} · maior queda ${nf(r.mdd * 100, 2)}% · posicionado ${nf(r.inMkt * 100, 0)}% do tempo · ${r.estrategias} estratégias diferentes usadas`);
  }
  const tot = {}; for (const sym of Object.keys(LAB.results)) for (const [id, r] of Object.entries(LAB.results[sym])) tot[id] = (tot[id] || 0) + r.ret;
  L.push('', 'Carteira somada (3 ativos): ' + Object.entries(tot).map(([id, v]) => `${id} ${pct(v / Object.keys(LAB.results).length)}`).join(' · '));
  return L.join('\n');
}

/* ---------------- API ---------------- */
function fullReport() {
  const all = list(), eq = all.reduce((s, b) => s + (b.S.acc ? b.equity() : CFG.cap), 0), cap = all.length * CFG.cap;
  const L = [`NÚCLEO TRADER — relatório (dinheiro simulado, ${all.length} ativos com ${brl(CFG.cap)} cada)`,
    `Versão do robô: ${MODE.nome}. Configuração: alavancagem ${CFG.lev}x, taxa ${nf(CFG.costPct, 3)}% por lado. Carteira somada: ${brl(eq)} de ${brl(cap)} (${pct(eq / cap - 1)}).`, ''];
  for (const b of all) { if (b.S.acc) { L.push(b.reportText()); L.push('') } }
  return L.join('\n');
}
const PUB = path.join(__dirname, 'public');
const files = { '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'], '/lw.js': ['lw.js', 'application/javascript', 'public, max-age=86400'] };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)) };
  const bot = () => bots[(u.searchParams.get('s') || SYMBOLS[0]).toUpperCase()];
  try {
    if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok') }
    if (u.pathname === '/api/overview') return json({ now: Date.now(), cfg: { cap: CFG.cap, lev: CFG.lev, costPct: CFG.costPct }, assets: list().map(b => b.overview()) });
    if (u.pathname === '/api/state') { const b = bot(); if (!b || !b.S.acc) return json({ error: 'ativo indisponível' }, 404); return json(b.statePayload()) }
    if (u.pathname === '/api/candles') { const b = bot(), tf = u.searchParams.get('tf') || '5m'; const c = b && b.S.candles[tf]; if (!c) return json({ error: 'ativo ou tempo inválido' }, 400); return json({ tf, candles: c.slice(-300) }) }
    if (u.pathname === '/api/report') return json({ assets: list().filter(b => b.S.acc).map(b => ({ symbol: b.SYMBOL, reports: b.S.reports, parcial: b.S.win ? b.summarize(b.S.win, Date.now()) : null })), texto: fullReport() });
    if (u.pathname === '/lab' || u.pathname === '/api/lab') {
      const busy = ['baixando dados', 'simulando', 'aguardando a Binance liberar o acesso'].includes(LAB.status);
      if (u.searchParams.get('run') && !busy && (!LAB.finishedAt || Date.now() - LAB.finishedAt > 10 * 60e3)) runLab(Math.min(7, Math.max(1, +u.searchParams.get('dias') || 4)));
      if (u.pathname === '/api/lab') return json({ ...LAB, texto: labText() });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end(labText());
    }
    if (u.pathname === '/relatorio') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fullReport()) }
    const f = files[u.pathname];
    if (f) { res.writeHead(200, { 'content-type': f[1], 'cache-control': f[2] }); return fs.createReadStream(path.join(PUB, f[0])).pipe(res) }
    res.writeHead(404); res.end('não encontrado');
  } catch (e) { console.error(e); json({ error: e.message }, 500) }
});

/* ---------------- inicialização ---------------- */
async function boot() {
  server.listen(PORT, () => console.log('Núcleo Trader ouvindo na porta ' + PORT + ' · ativos: ' + SYMBOLS.join(', ')));
  // o plano grátis do Render dorme sem acessos; o próprio robô se acessa a cada 10 min (já desde o início, mesmo esperando a Binance)
  const ext = process.env.RENDER_EXTERNAL_URL;
  if (ext) setInterval(() => fetch(ext + '/health').catch(() => { }), 10 * 60e3);
  await initRedis();
  for (const b of list()) await b.init();
  let cached = true;
  for (const b of list()) { const at = await b.loadCache(); if (at) b.log(`Retomei o histórico de velas guardado em ${quando(at)}, sem precisar da API da Binance.`, 'k'); else cached = false }
  if (!cached) for (;;) {
    try { await loadAllHistory(); break }
    catch (e) {
      const w = Math.max(15000, cooldownUntil - Date.now());
      for (const b of list()) b.setDataError(e.message);
      bots[SYMBOLS[0]].log('Não consegui baixar o histórico da Binance (' + e.message + '). Tento de novo em ' + Math.round(w / 1000) + ' s.', 's');
      await new Promise(r => setTimeout(r, w));
    }
  }
  for (const b of list()) b.afterHistory(true);
  connectWS(); lastMsg = Date.now();
  if (cached) backfill();
  setInterval(() => { for (const b of list()) b.periodic() }, 15000);
  setInterval(() => { for (const b of list()) b.saveCache() }, 5 * 60e3);
  setTimeout(() => { for (const b of list()) b.saveCache() }, 30e3);
}
process.on('SIGTERM', async () => { try { await Promise.all(list().flatMap(b => [b.save(true), b.saveCache()])) } finally { process.exit(0) } });
boot();
