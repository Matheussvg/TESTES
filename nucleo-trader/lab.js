'use strict';
// Laboratório: reproduz o robô INTEIRO (torneio + execução) nos dias passados, sem olhar o futuro.
// A cada hora do período de teste ele escolhe a estratégia só com o que já tinha acontecido
// e opera a hora seguinte. Assim dá para comparar versões com dados reais e com a mesma régua.
const { parentPort, workerData } = require('worker_threads');
const E = require('./engine');

function firstAfter(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t > t) hi = m; else lo = m + 1 } return lo }

function simulate(data, mode, testStart, testEnd, step) {
  const cost = mode.feePct / 100, Is = {};
  for (const tf of mode.tfs) Is[tf] = E.makeInd(data[tf]);
  const trend = mode.trend ? E.makeTrend(data['1h'], E.makeInd(data['1h'])) : null;
  let eq = 1, peak = 1, mdd = 0, pos = null, active = null, pending = null, trades = 0, wins = 0, fees = 0, inMkt = 0;
  const switches = new Set();
  const open = (s, px, i, m) => { const a = Is[m.tf].atr(14)[i]; if (!(a > 0)) return; fees += eq * cost; eq *= (1 - cost); pos = { dir: s, entry: px, sl: px - s * m.rk.sl * a, tp: px + s * m.rk.tp * a, m, openIdx: i + 1 } };
  const close = px => {
    const r = pos.dir * (px - pos.entry) / pos.entry; const g = eq * (1 + r); fees += g * cost; eq = g * (1 - cost);
    trades++; if (r > cost * 2) wins++; pos = null; if (eq > peak) peak = eq; const dd = 1 - eq / peak; if (dd > mdd) mdd = dd;
    if (pending) { active = pending; pending = null }
  };
  for (let T = testStart; T < testEnd; T += step) {
    const ranges = {};
    for (const tf of mode.tfs) { const end = firstAfter(data[tf], T - E.TFMS[tf]); ranges[tf] = { from: Math.max(0, end - 500), to: end } }
    const res = E.tournament(data, cost, { tfs: mode.tfs, longOnly: mode.longOnly, allowLong: trend, oos: mode.oos, Is, ranges });
    const best = res[0], ok = best && best.score > 0;
    if (!pos) { active = ok ? best : null; pending = null } else pending = ok && best.key !== pos.m.key ? best : null;
    if (active) switches.add(active.key);
    if (pos) inMkt += step;
    const m0 = pos ? pos.m : active; if (!m0) continue;
    const tf = m0.tf, arr = data[tf], I = Is[tf], ms = E.TFMS[tf];
    for (let i = firstAfter(arr, T - ms); i < arr.length - 1 && arr[i].t + ms <= T + step; i++) {
      const m = pos ? pos.m : active; if (!m || m.tf !== tf) break;
      const b = arr[i];
      if (pos && i >= pos.openIdx) {
        if (pos.dir > 0) { if (b.l <= pos.sl) close(pos.sl); else if (b.h >= pos.tp) close(pos.tp) }
        else { if (b.h >= pos.sl) close(pos.sl); else if (b.l <= pos.tp) close(pos.tp) }
        if (!pos && (!active || active.tf !== tf)) break;
      }
      const cur = pos ? pos.m : active; if (!cur) break;
      let s = cur.st.sig(I, i); if (s === null) continue;
      if (mode.longOnly && s === -1) s = 0;
      if (s === 1 && trend && !pos && !trend(b.t + ms)) continue;
      const px = arr[i + 1].o;
      if (s === 0) { if (pos) close(px); continue }
      if (pos && pos.dir === s) continue;
      if (pos) { close(px); if (!active || active.tf !== tf) break }
      open(s, px, i, active);
    }
  }
  if (pos) { const arr = data[pos.m.tf]; close(arr[firstAfter(arr, testEnd) - 1].c) }
  const p0 = data['1h'][firstAfter(data['1h'], testStart - 1)].o, p1 = data['1h'][firstAfter(data['1h'], testEnd) - 1].c;
  return { ret: eq - 1, trades, win: trades ? wins / trades : null, fees, mdd, hold: p1 / p0 - 1, inMkt: inMkt / (testEnd - testStart), estrategias: switches.size };
}

const { data, modes, testStart, testEnd, step } = workerData;
const out = {};
for (const sym of Object.keys(data)) {
  out[sym] = {};
  for (const id of modes) { const t0 = Date.now(); out[sym][id] = simulate(data[sym], E.MODES[id], testStart, testEnd, step); out[sym][id].ms = Date.now() - t0 }
}
parentPort.postMessage(out);
