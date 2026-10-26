'use strict';
// Cérebro do Núcleo Trader: indicadores, estratégias e backtest (mesma lógica da versão de navegador).

const TFS = [
  { id: '1m', ms: 60e3 }, { id: '3m', ms: 180e3 }, { id: '5m', ms: 300e3 },
  { id: '15m', ms: 900e3 }, { id: '1h', ms: 3600e3 }, { id: '4h', ms: 14400e3 },
];
const TFMS = Object.fromEntries(TFS.map(t => [t.id, t.ms]));

// Versões do robô. v1 = a original. As outras atacam o que os relatórios mostraram:
// operar demais em gráfico curto (taxa come tudo), vender a descoberto num mercado em alta
// e escolher estratégia "sortuda" no histórico (sobreajuste).
const MODES = {
  v1: { nome: 'v1 original', tfs: ['1m', '3m', '5m', '15m', '1h'], longOnly: false, trend: false, oos: false, feePct: 0.1, evalS: 60 },
  v2: { nome: 'v2 só compra, sem 1m/3m, validação fora da amostra', tfs: ['5m', '15m', '1h', '4h'], longOnly: true, trend: false, oos: true, feePct: 0.1, evalS: 3600 },
  v3: { nome: 'v3 = v2 + filtro de tendência (EMA 200 do 1h)', tfs: ['5m', '15m', '1h', '4h'], longOnly: true, trend: true, oos: true, feePct: 0.1, evalS: 3600 },
  v4: { nome: 'v4 = v3 com taxa paga em BNB (0,075%)', tfs: ['5m', '15m', '1h', '4h'], longOnly: true, trend: true, oos: true, feePct: 0.075, evalS: 3600 },
};
const RISKS = [
  { id: 'c', nome: 'stop curto', sl: 1.5, tp: 2.0 },
  { id: 'l', nome: 'stop longo', sl: 2.5, tp: 5.0 },
];
const WARM = 60;
const clip = v => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));

function ema(a, p) { const n = a.length, o = new Array(n).fill(NaN); let s = 0; while (s < n && !Number.isFinite(a[s])) s++; if (s + p > n) return o; let sum = 0; for (let j = s; j < s + p; j++) sum += a[j]; let e = sum / p; o[s + p - 1] = e; const k = 2 / (p + 1); for (let i = s + p; i < n; i++) { e = a[i] * k + e * (1 - k); o[i] = e } return o }
function sma(a, p) { const n = a.length, o = new Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p } return o }
function rsi(a, p) { const n = a.length, o = new Array(n).fill(NaN); let g = 0, l = 0; const val = () => g + l === 0 ? 50 : (l === 0 ? 100 : 100 - 100 / (1 + g / l)); for (let i = 1; i < n; i++) { const d = a[i] - a[i - 1], up = d > 0 ? d : 0, dn = d < 0 ? -d : 0; if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; o[i] = val() } } else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; o[i] = val() } } return o }
function boll(a, p, k) { const m = sma(a, p), n = a.length, up = new Array(n).fill(NaN), lo = new Array(n).fill(NaN); for (let i = p - 1; i < n; i++) { let v = 0; for (let j = i - p + 1; j <= i; j++) v += (a[j] - m[i]) ** 2; const sd = Math.sqrt(v / p); up[i] = m[i] + k * sd; lo[i] = m[i] - k * sd } return { mid: m, up, lo } }
function macdF(a) { const f = ema(a, 12), s = ema(a, 26), m = a.map((_, i) => f[i] - s[i]), sig = ema(m, 9); return { m, s: sig, h: m.map((v, i) => v - sig[i]) } }
function donch(h, l, p) { const n = h.length, up = new Array(n).fill(NaN), lo = new Array(n).fill(NaN); for (let i = p; i < n; i++) { let mx = -Infinity, mn = Infinity; for (let j = i - p; j < i; j++) { if (h[j] > mx) mx = h[j]; if (l[j] < mn) mn = l[j] } up[i] = mx; lo[i] = mn } return { up, lo } }
function atrF(c, p) { const n = c.length, o = new Array(n).fill(NaN); let a = 0; for (let i = 1; i < n; i++) { const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); if (i <= p) { a += tr; if (i === p) { a /= p; o[i] = a } } else { a = (a * (p - 1) + tr) / p; o[i] = a } } return o }

function makeInd(c) {
  const close = c.map(x => x.c), high = c.map(x => x.h), low = c.map(x => x.l), vol = c.map(x => x.v), cache = {};
  const memo = (k, f) => cache[k] || (cache[k] = f());
  return {
    c, close, high, low, vol,
    ema: p => memo('e' + p, () => ema(close, p)), rsi: p => memo('r' + p, () => rsi(close, p)),
    bb: (p, k) => memo('b' + p + '_' + k, () => boll(close, p, k)), macd: () => memo('m', () => macdF(close)),
    don: p => memo('d' + p, () => donch(high, low, p)), atr: p => memo('a' + p, () => atrF(c, p)), vsma: p => memo('v' + p, () => sma(vol, p)),
  };
}

function votes(I, i) {
  const a = I.atr(14)[i] || 1e-12, c = I.close[i], b = I.bb(20, 2), d = I.don(20), m = I.macd(), va = I.vsma(20)[i];
  return {
    tend: clip((I.ema(9)[i] - I.ema(21)[i]) / a),
    mom: clip(m.h[i] / (a * 0.3)),
    forca: clip((I.rsi(14)[i] - 50) / 25),
    bandas: clip(b.up[i] > b.lo[i] ? ((c - b.lo[i]) / (b.up[i] - b.lo[i]) - 0.5) * 2 : 0),
    romp: clip(d.up[i] > d.lo[i] ? (c - (d.up[i] + d.lo[i]) / 2) / ((d.up[i] - d.lo[i]) / 2) : 0),
    volume: clip(Math.sign(c - I.c[i].o) * (va > 0 ? I.vol[i] / va - 1 : 0)),
  };
}

const cross = (a, b, i) => (a[i - 1] <= b[i - 1] && a[i] > b[i]) ? 1 : (a[i - 1] >= b[i - 1] && a[i] < b[i]) ? -1 : null;
const crossMid = (x, m, i) => (x[i - 1] - m[i - 1]) * (x[i] - m[i]) < 0;
const STRATS = [
  { id: 'ema5', nome: 'Cruzamento EMA 5/20', fam: 'tendência', f: [5, 20], sig: (I, i) => cross(I.ema(5), I.ema(20), i) },
  { id: 'ema9', nome: 'Cruzamento EMA 9/21', fam: 'tendência', f: [9, 21], sig: (I, i) => cross(I.ema(9), I.ema(21), i) },
  { id: 'ema12', nome: 'Cruzamento EMA 12/50', fam: 'tendência', f: [12, 50], sig: (I, i) => cross(I.ema(12), I.ema(50), i) },
  { id: 'macd', nome: 'MACD 12/26/9', fam: 'momento', sig: (I, i) => { const m = I.macd(); return cross(m.m, m.s, i) } },
  { id: 'rsi30', nome: 'RSI 14 reversão 30/70', fam: 'reversão', sig: (I, i) => { const r = I.rsi(14); if (r[i] < 30) return 1; if (r[i] > 70) return -1; if ((r[i - 1] - 50) * (r[i] - 50) < 0) return 0; return null } },
  { id: 'rsi25', nome: 'RSI 14 reversão 25/75', fam: 'reversão', sig: (I, i) => { const r = I.rsi(14); if (r[i] < 25) return 1; if (r[i] > 75) return -1; if ((r[i - 1] - 50) * (r[i] - 50) < 0) return 0; return null } },
  { id: 'bbrev', nome: 'Bollinger reversão', fam: 'reversão', sig: (I, i) => { const b = I.bb(20, 2), c = I.close; if (c[i] < b.lo[i]) return 1; if (c[i] > b.up[i]) return -1; if (crossMid(c, b.mid, i)) return 0; return null } },
  { id: 'bbbrk', nome: 'Bollinger rompimento', fam: 'rompimento', sig: (I, i) => { const b = I.bb(20, 2), c = I.close; if (c[i] > b.up[i]) return 1; if (c[i] < b.lo[i]) return -1; if (crossMid(c, b.mid, i)) return 0; return null } },
  { id: 'don20', nome: 'Canal Donchian 20', fam: 'rompimento', sig: (I, i) => { const d = I.don(20), c = I.close; if (c[i] > d.up[i]) return 1; if (c[i] < d.lo[i]) return -1; return null } },
  { id: 'don55', nome: 'Canal Donchian 55', fam: 'rompimento', sig: (I, i) => { const d = I.don(55), c = I.close; if (c[i] > d.up[i]) return 1; if (c[i] < d.lo[i]) return -1; return null } },
  { id: 'cons', nome: 'Consenso de indicadores', fam: 'votação', sig: (I, i) => { const v = votes(I, i); const a = (v.tend + v.mom + v.forca + v.bandas + v.romp) / 5; if (a > 0.55) return 1; if (a < -0.55) return -1; if (Math.abs(a) < 0.12) return 0; return null } },
];

// Filtro de tendência: só compra quando o último candle FECHADO de 1h está acima da EMA 200 do 1h.
function makeTrend(c1h, I1h) {
  if (!c1h || c1h.length < 210) return () => true;
  const I = I1h || makeInd(c1h), e = I.ema(200), H = 3600e3;
  return t => {
    let lo = 0, hi = c1h.length - 1, k = -1;               // último candle com fechamento <= t
    while (lo <= hi) { const m = (lo + hi) >> 1; if (c1h[m].t + H <= t) { k = m; lo = m + 1 } else hi = m - 1 }
    return k >= 0 && Number.isFinite(e[k]) && c1h[k].c > e[k];
  };
}

// o = { I, from, to, longOnly, allowLong, ms }
function backtest(c, st, risk, cost, o = {}) {
  const to = o.to == null ? c.length : o.to, from = Math.max(WARM, o.from == null ? WARM : o.from);
  if (to - from < 30) return null;
  const I = o.I || makeInd(c), atr = I.atr(14), ms = o.ms || 0;
  let eq = 1, peak = 1, mdd = 0, pos = 0, entry = 0, sl = 0, tp = 0, trades = 0, wins = 0;
  const close = px => { const r = pos * (px - entry) / entry; eq *= (1 + r) * (1 - cost); trades++; if (r > cost * 2) wins++; pos = 0; if (eq > peak) peak = eq; const dd = 1 - eq / peak; if (dd > mdd) mdd = dd };
  for (let i = from; i < to - 1; i++) {
    if (pos) {
      const b = c[i]; let x = null;
      if (pos > 0) { if (b.l <= sl) x = sl; else if (b.h >= tp) x = tp } else { if (b.h >= sl) x = sl; else if (b.l <= tp) x = tp }
      if (x !== null) close(x);
    }
    let s = st.sig(I, i); if (s === null) continue;
    if (o.longOnly && s === -1) s = 0;
    if (s === 1 && o.allowLong && !pos && !o.allowLong(c[i].t + ms)) continue;
    const px = c[i + 1].o;
    if (s === 0) { if (pos) close(px) }
    else if (s !== pos) { if (pos) close(px); const a = atr[i]; if (!(a > 0)) continue; pos = s; entry = px; eq *= (1 - cost); sl = px - s * risk.sl * a; tp = px + s * risk.tp * a }
  }
  if (pos) close(c[to - 1].c);
  const days = Math.max((c[to - 1].t - c[from].t) / 864e5, 1 / 24);
  const perDay = eq > 0 ? Math.pow(eq, 1 / days) - 1 : -1;
  const score = trades < 3 ? -999 : perDay * 100 - 0.1 * mdd * 100;
  return { ret: eq - 1, perDay, mdd, trades, win: trades ? wins / trades : 0, days, score };
}

// o = { tfs, longOnly, allowLong, oos, Is: {tf: I}, ranges: {tf: {from, to}} }
function tournament(candles, cost, o = {}) {
  const res = [], tfs = o.tfs || TFS.slice(0, 5).map(t => t.id);
  for (const tf of tfs) {
    const c = candles[tf]; if (!c) continue;
    const r = (o.ranges && o.ranges[tf]) || { from: Math.max(0, c.length - 500), to: c.length };
    if (r.to - Math.max(WARM, r.from) < 60) continue;
    const I = (o.Is && o.Is[tf]) || makeInd(c);
    const base = { I, from: r.from, to: r.to, longOnly: o.longOnly, allowLong: o.allowLong, ms: TFMS[tf] };
    const split = r.to - Math.floor((r.to - Math.max(WARM, r.from)) * 0.3);
    for (const st of STRATS) for (const rk of RISKS) {
      const full = backtest(c, st, rk, cost, base); if (!full) continue;
      let score = full.score, oos = null;
      if (o.oos) {   // validação: precisa ir bem no histórico todo E nos últimos 30% que ela "não viu" sozinha
        oos = backtest(c, st, rk, cost, { ...base, from: split });
        score = (full.trades < 6 || !oos || oos.trades < 2) ? -999 : Math.min(full.perDay, oos.perDay) * 100 - 0.1 * full.mdd * 100;
      }
      res.push({ key: tf + '|' + st.id + '|' + rk.id, tf, st, rk, ...full, score, oos: oos && { perDay: oos.perDay, trades: oos.trades } });
    }
  }
  res.sort((a, b) => b.score - a.score);
  return res;
}

module.exports = { TFS, TFMS, MODES, RISKS, STRATS, WARM, makeInd, makeTrend, votes, backtest, tournament };
