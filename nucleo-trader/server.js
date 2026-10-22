'use strict';
// Núcleo Trader — robô de trade simulado rodando 24h no servidor.
// Lê preços reais da Binance, escolhe a melhor estratégia por torneio e opera com dinheiro fictício.
const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const SYMBOL = process.env.SYMBOL || 'BTCBRL';
const PORT = +process.env.PORT || 10000;
const CFG = {
  cap: +(process.env.CAPITAL || 10000),
  lev: +(process.env.LEVERAGE || 1),
  costPct: +(process.env.FEE_PCT || 0.1),          // taxa por lado, em %
  evalMs: +(process.env.EVAL_SECONDS || 60) * 1000,
  always: process.env.ALWAYS === '1',
};
const COST = CFG.costPct / 100;
const REST = process.env.DATA_URL ? [process.env.DATA_URL] : ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com', 'https://api3.binance.com'];
const HIST = 500, MAXC = 700, DAY = 864e5;
const KEY = 'nt:state:' + SYMBOL;
const TZ = 'America/Sao_Paulo';

/* ---------------- estado ---------------- */
const S = {
  candles: {}, price: null, lastTick: 0, ranking: [], active: null, pending: null,
  votes: null, bias: 0, lastTour: 0, startedAt: Date.now(), acc: null, logs: [], reports: [],
  win: null, dataOk: false, bootAt: Date.now(), lastErr: null,
};
const freshAcc = () => ({ start: CFG.cap, bal: CFG.cap, pos: null, trades: [], eqHist: [], peak: CFG.cap, mdd: 0, fees: 0 });

const nf = (v, d) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const brl = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (v, d = 2) => (v >= 0 ? '+' : '') + nf(v * 100, d) + '%';
const fmtPx = v => v == null ? '—' : nf(v, 0);
const quando = t => new Date(t).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function log(msg, cls = '') {
  S.logs.unshift({ t: Date.now(), msg, cls });
  if (S.logs.length > 300) S.logs.length = 300;
  console.log(new Date().toISOString(), msg);
}
function equity(p = S.price) { const a = S.acc; if (!a.pos || p == null) return a.bal; return a.bal + a.pos.dir * (p - a.pos.entry) * a.pos.qty }

/* ---------------- persistência (Render Key Value) ---------------- */
let redis = null, saving = false, again = false, lastSave = 0;
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
async function loadState() {
  if (!redis) return null;
  try { const s = await redis.get(KEY); return s ? JSON.parse(s) : null } catch (e) { console.error('load:', e.message); return null }
}
async function save(force) {
  if (!redis) return;
  if (saving) { if (force) again = true; return }
  if (!force && Date.now() - lastSave < 30000) return;
  saving = true;
  try {
    const data = { v: 1, startedAt: S.startedAt, acc: S.acc, logs: S.logs.slice(0, 200), reports: S.reports, win: S.win };
    await redis.set(KEY, JSON.stringify(data)); lastSave = Date.now();
  } catch (e) { console.error('save:', e.message) }
  saving = false;
  if (again) { again = false; save(true) }
}

/* ---------------- dados de mercado ---------------- */
const toC = k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
async function fetchJSON(p) {
  let err;
  for (const h of REST) {
    try {
      const r = await fetch(h + p, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(h + ' HTTP ' + r.status);
      return await r.json();
    } catch (e) { err = e }
  }
  throw err;
}
async function loadHistory() {
  const out = {};
  for (const tf of E.TFS) {
    const d = await fetchJSON(`/api/v3/klines?symbol=${SYMBOL}&interval=${tf.id}&limit=${HIST}`);
    out[tf.id] = d.map(toC);
  }
  S.candles = out;
}
function merge(arr, ks, ms) {
  let added = 0, gap = false;
  for (const k of ks) {
    const last = arr[arr.length - 1];
    if (!last || k.t > last.t) { if (last && k.t - last.t > ms) gap = true; arr.push(k); added++; if (arr.length > MAXC) arr.shift() }
    else { const j = arr.findIndex(x => x.t === k.t); if (j >= 0) arr[j] = k }
  }
  return { added, gap };
}

let failCount = 0;
async function poll() {
  try {
    const ks = (await fetchJSON(`/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=3`)).map(toC);
    failCount = 0; S.dataOk = true; S.lastErr = null;
    const one = S.candles['1m'];
    const { added, gap } = merge(one, ks, 60e3);
    if (gap) { log('Detectei um buraco nos dados (o servidor ficou parado). Recarregando o histórico.', 'w'); await loadHistory() }
    const px = ks[ks.length - 1].c, nowT = ks[ks.length - 1].t;
    // candles maiores em formação acompanham o preço
    const toClose = [];
    for (const tf of E.TFS.slice(1)) {
      const arr = S.candles[tf.id], last = arr[arr.length - 1], b = Math.floor(nowT / tf.ms) * tf.ms;
      if (b === last.t) { last.h = Math.max(last.h, px); last.l = Math.min(last.l, px); last.c = px }
      else if (b > last.t) {
        const d = (await fetchJSON(`/api/v3/klines?symbol=${SYMBOL}&interval=${tf.id}&limit=3`)).map(toC);
        if (merge(arr, d, tf.ms).gap) { await loadHistory(); break } toClose.push(tf.id);
      }
    }
    tick(px);
    if (added > 0 && !gap) candleClosed('1m', one.length - 2);
    for (const id of toClose) candleClosed(id, S.candles[id].length - 2);
  } catch (e) {
    failCount++; S.lastErr = e.message;
    if (failCount === 3) log('Sem resposta da Binance há alguns segundos (' + e.message + '). Sigo tentando.', 'w');
    if (failCount > 15) S.dataOk = false;
  }
  setTimeout(poll, 2000);
}

/* ---------------- cérebro ---------------- */
function rowOf(r) { return r && { key: r.key, tf: r.tf, nome: r.st.nome, fam: r.st.fam, f: r.st.f || null, risco: r.rk.nome, perDay: r.perDay, win: r.win, trades: r.trades, mdd: r.mdd, score: r.score } }
function runTournament(reason) {
  const t0 = Date.now(); const res = E.tournament(S.candles, COST);
  S.ranking = res; S.lastTour = Date.now();
  const best = res[0]; if (!best) return;
  const ok = best.score > 0 || CFG.always;
  if (reason) log(`Torneio: testei ${res.length} combinações (${E.STRATS.length} estratégias × ${E.TFS.length} tempos × ${E.RISKS.length} perfis de stop) em ${Date.now() - t0} ms.`);
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
  if (tf === '1m' && Date.now() - S.lastTour >= CFG.evalMs) runTournament(true);
  if (tf === '1m') updateVotes();
  const act = S.active; if (!act || act.tf !== tf || S.price == null) return;
  const c = S.candles[tf], I = E.makeInd(c), s = act.st.sig(I, idx), a = S.acc, px = S.price;
  const tag = `${act.st.nome} (${tf})`;
  if (s === null) return;
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

/* ---------------- relatórios de 24h ---------------- */
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
    log(`Relatório do dia ${r.dia}: ${pct(r.pct)} (${brl(r.pnl)}) em ${r.ops} operações · BTC no período ${pct(r.btcPct)}.`, r.pnl >= 0 ? 'b' : 's');
    S.win = newWindow(end); save(true);
  }
}
function reportText() {
  const a = S.acc, eq = equity(), days = (Date.now() - S.startedAt) / DAY;
  const L = [];
  L.push(`NÚCLEO TRADER — relatório (${SYMBOL}, dinheiro simulado)`);
  L.push(`Rodando desde ${quando(S.startedAt)} (${nf(days, 1)} dias). Dados ${S.dataOk ? 'ao vivo' : 'COM FALHA: ' + (S.lastErr || '')}. Último preço ${fmtPx(S.price)} às ${quando(S.lastTick)}.`);
  L.push(`Configuração: capital ${brl(a.start)}, alavancagem ${CFG.lev}x, taxa ${nf(CFG.costPct, 2)}% por lado.`);
  L.push(`Patrimônio ${brl(eq)} · resultado total ${pct(eq / a.start - 1)} (${brl(eq - a.start)}) · ${a.trades.length} operações · acerto ${a.trades.length ? nf(a.trades.filter(t => t.net > 0).length / a.trades.length * 100, 0) + '%' : '—'} · taxas pagas ${brl(a.fees)} · maior queda ${nf(a.mdd * 100, 2)}%.`);
  if (S.startedAt && S.acc.eqHist.length) { const px0 = S.acc.eqHist[0][2]; if (px0) L.push(`Comparação: BTC parado no mesmo período ${pct(S.price / px0 - 1)}.`) }
  L.push(a.pos ? `Posição aberta: ${a.pos.dir > 0 ? 'COMPRA' : 'VENDA'} a ${fmtPx(a.pos.entry)} (${a.pos.strat} ${a.pos.tf}), resultado aberto ${brl(a.pos.dir * (S.price - a.pos.entry) * a.pos.qty)}.` : 'Sem posição aberta.');
  L.push(S.active ? `Estratégia atual: ${S.active.st.nome} em ${S.active.tf}.` : 'Sem estratégia ativa (nenhuma vence as taxas agora).');
  L.push('');
  for (const r of S.reports.slice().reverse()) L.push(`Dia ${r.dia} (${quando(r.inicio)} → ${quando(r.fim)}): ${pct(r.pct)} (${brl(r.pnl)}) · ${r.ops} ops · acerto ${r.taxa == null ? '—' : nf(r.taxa * 100, 0) + '%'} · melhor ${r.melhor == null ? '—' : brl(r.melhor)} · pior ${r.pior == null ? '—' : brl(r.pior)} · taxas ${brl(r.taxas)} · maior queda ${nf(r.mdd * 100, 2)}% · posicionado ${nf(r.tempoPosicionado * 100, 0)}% do tempo · BTC ${pct(r.btcPct)} · acumulado ${pct(r.totalPct)}.`);
  if (S.win) { const p = summarize(S.win, Date.now()); L.push(`Parcial de hoje (desde ${quando(S.win.start)}): ${pct(p.pct)} (${brl(p.pnl)}) · ${p.ops} ops · BTC ${pct(p.btcPct)}.`) }
  return L.join('\n');
}

/* ---------------- API ---------------- */
function statePayload() {
  const a = S.acc, eq = equity(), h = a.eqHist, step = Math.max(1, Math.ceil(h.length / 400));
  const eqHist = h.filter((_, i) => i % step === 0 || i === h.length - 1).map(x => [x[0], x[1], x[2]]);
  const c1h = S.candles['1h'];
  const ch24 = c1h && c1h.length > 25 && S.price ? S.price / c1h[c1h.length - 25].c - 1 : null;
  let estado = 'iniciando';
  if (!S.dataOk && S.lastTick === 0) estado = 'iniciando'; else if (!S.dataOk) estado = 'sem-dados';
  else if (a.pos) estado = a.pos.dir > 0 ? 'comprado' : 'vendido'; else if (S.active) estado = 'espreita'; else if (S.ranking.length) estado = 'fora';
  return {
    symbol: SYMBOL, now: Date.now(), startedAt: S.startedAt, bootAt: S.bootAt, cfg: { cap: CFG.cap, lev: CFG.lev, costPct: CFG.costPct, evalS: CFG.evalMs / 1000 },
    price: S.price, lastTick: S.lastTick, ch24, dataOk: S.dataOk, lastErr: S.lastErr, estado,
    active: rowOf(S.active), pending: rowOf(S.pending), votes: S.votes, votesTf: S.votesTf, bias: S.bias,
    ranking: S.ranking.slice(0, 12).map(rowOf), combos: S.ranking.length, lastTour: S.lastTour,
    acc: { start: a.start, bal: a.bal, eq, peak: a.peak, mdd: a.mdd, fees: a.fees, pos: a.pos, nTrades: a.trades.length, wins: a.trades.filter(t => t.net > 0).length },
    trades: a.trades.slice(0, 200), logs: S.logs.slice(0, 80), reports: S.reports,
    parcial: S.win ? summarize(S.win, Date.now()) : null, eqHist,
    btc0: a.eqHist.length ? a.eqHist[0][2] : null,
  };
}
const PUB = path.join(__dirname, 'public');
const files = { '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'], '/lw.js': ['lw.js', 'application/javascript', 'public, max-age=86400'] };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)) };
  try {
    if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok') }
    if (u.pathname === '/api/state') return json(statePayload());
    if (u.pathname === '/api/candles') { const tf = u.searchParams.get('tf') || '5m'; const c = S.candles[tf]; if (!c) return json({ error: 'tf inválido' }, 400); return json({ tf, candles: c.slice(-300) }) }
    if (u.pathname === '/api/report') return json({ reports: S.reports, parcial: S.win ? summarize(S.win, Date.now()) : null, texto: reportText() });
    if (u.pathname === '/relatorio') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end(reportText()) }
    const f = files[u.pathname];
    if (f) { res.writeHead(200, { 'content-type': f[1], 'cache-control': f[2] }); return fs.createReadStream(path.join(PUB, f[0])).pipe(res) }
    res.writeHead(404); res.end('não encontrado');
  } catch (e) { console.error(e); json({ error: e.message }, 500) }
});

/* ---------------- inicialização ---------------- */
async function boot() {
  server.listen(PORT, () => console.log('Núcleo Trader ouvindo na porta ' + PORT));
  await initRedis();
  const st = await loadState();
  if (st && st.acc) {
    S.startedAt = st.startedAt; S.acc = st.acc; S.logs = st.logs || []; S.reports = st.reports || []; S.win = st.win || null;
    if (S.acc.fees == null) S.acc.fees = 0;
    log(`Servidor reiniciado: retomei a conta (${brl(S.acc.bal)} de saldo, ${S.acc.trades.length} operações, dia ${S.reports.length + 1}).`, 'k');
  } else {
    S.acc = freshAcc();
    log(`Robô iniciado em ${SYMBOL} com ${brl(CFG.cap)} simulados · alavancagem ${CFG.lev}x · taxa ${nf(CFG.costPct, 2)}% por lado (igual à Binance).`, 'k');
  }
  for (;;) {
    try { await loadHistory(); break }
    catch (e) { S.lastErr = e.message; log('Não consegui baixar o histórico da Binance (' + e.message + '). Tento de novo em 15 s.', 's'); await new Promise(r => setTimeout(r, 15000)) }
  }
  const one = S.candles['1m']; S.price = one[one.length - 1].c; S.lastTick = Date.now(); S.dataOk = true;
  log(`Histórico carregado: ${E.TFS.map(t => S.candles[t.id].length + '×' + t.id).join(', ')}.`);
  if (!S.win) S.win = newWindow(S.startedAt);
  if (!S.acc.eqHist.length) S.acc.eqHist.push([Date.now(), S.acc.bal, S.price]);
  runTournament(true);
  if (S.acc.pos) {
    const r = S.ranking.find(x => x.key === S.acc.pos.key);
    if (r) S.active = r;
    log(`Retomei a posição aberta de ${S.acc.pos.dir > 0 ? 'compra' : 'venda'} a ${fmtPx(S.acc.pos.entry)}.`, 'k');
  }
  updateVotes(); save(true);
  setTimeout(poll, 1000);
  setInterval(() => { if (S.ranking.length && Date.now() - S.lastTour > CFG.evalMs * 2) runTournament(false) }, 15000);
  // o plano grátis do Render dorme sem acessos; o próprio robô se acessa a cada 10 min
  const ext = process.env.RENDER_EXTERNAL_URL;
  if (ext) setInterval(() => fetch(ext + '/health').catch(() => { }), 10 * 60e3);
}
process.on('SIGTERM', async () => { try { await save(true) } finally { process.exit(0) } });
boot();
