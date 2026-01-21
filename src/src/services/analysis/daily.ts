import type { Database } from 'better-sqlite3';

export async function runDailyAnalysis(db: Database) {
  // 전일 미국 증시 변동: SPY, QQQ 기준 변동률 요약
  const spy = summarizeDailyMove(db, 'SPY');
  const qqq = summarizeDailyMove(db, 'QQQ');

  // 인기 섹터(거래량/수익률 상위) 간단 계산: XLF/XLE/XLK/XLV/XLI/XLY
  const sectors = ['XLK','XLF','XLE','XLV','XLI','XLY','XLU','XLB','XLRE','XLC'];
  const sectorMoves = sectors.map((s) => ({ symbol: s, move: summarizeDailyMove(db, s) })).filter((x) => x.move.deltaPct !== null);
  sectorMoves.sort((a,b) => (b.move.deltaPct ?? 0) - (a.move.deltaPct ?? 0));

  const topSectors = sectorMoves.slice(0, 3);

  const plainText = [
    `전일 미국 증시 요약`,
    `- SPY: ${fmtPct(spy.deltaPct)} (${fmt(spy.prevClose)} -> ${fmt(spy.lastClose)})`,
    `- QQQ: ${fmtPct(qqq.deltaPct)} (${fmt(qqq.prevClose)} -> ${fmt(qqq.lastClose)})`,
    `인기 섹터(상승률 상위)`,
    ...topSectors.map((s, i) => `- ${i+1}. ${s.symbol}: ${fmtPct(s.move.deltaPct)}`)
  ].join('\n');

  return { plainText };
}

function summarizeDailyMove(db: Database, symbol: string) {
  const row = db.prepare(`
    SELECT ts, close FROM price_history WHERE symbol=? ORDER BY ts DESC LIMIT 2
  `).all(symbol) as Array<{ ts: number; close: number }>;
  if (row.length < 2) return { lastClose: null, prevClose: null, deltaPct: null };
  const last = row[0].close;
  const prev = row[1].close;
  const deltaPct = prev ? ((last - prev) / prev) * 100 : null;
  return { lastClose: last, prevClose: prev, deltaPct };
}

function fmt(n: number | null) { return n == null ? '-' : n.toFixed(2); }
function fmtPct(p: number | null) { return p == null ? '-' : `${p.toFixed(2)}%`; }

// Notion 게시 기능 제거됨


