import type { Database } from 'better-sqlite3';
import {
  fetchMassivePriceHistory,
  fetchMassiveReferenceData,
  fetchMassiveOptions,
} from './fetchers/provider-massive-api.js';

function normalizedSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

export async function fetchTickerSnapshot(symbol: string, db: Database) {
  const sym = normalizedSymbol(symbol);
  let data: any = null;

  if (process.env.MASSIVE_API_KEY) {
    try {
      const refData = await fetchMassiveReferenceData(sym, db);
      if (refData) data = { source: 'massive', ...refData };
    } catch (err) {
      console.warn('[market.fetchTickerSnapshot] massive reference failed', (err as any)?.message ?? err);
    }
  }

  db.prepare(`REPLACE INTO ticker_snapshot(symbol, data_json, updated_at) VALUES(?, ?, datetime('now'))`).run(
    sym,
    JSON.stringify(data ?? {})
  );

  return { symbol: sym, data };
}

export async function fetchPriceHistory(symbol: string, range: string, db: Database) {
  const sym = normalizedSymbol(symbol);
  const insert = db.prepare(
    `REPLACE INTO price_history(symbol, ts, open, high, low, close, volume)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  );

  let rowsWritten = 0;
  if (process.env.MASSIVE_API_KEY) {
    try {
      await fetchMassivePriceHistory(sym, undefined, undefined, db);
      const rows = db
        .prepare(
          `SELECT date, open, high, low, close, volume
             FROM massive_price_history
            WHERE symbol = ?
            ORDER BY date DESC
            LIMIT 500`
        )
        .all(sym) as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;

      const tx = db.transaction((list: typeof rows) => {
        for (const row of list) {
          const ts = Math.floor(new Date(row.date).getTime() / 1000);
          insert.run(sym, ts, row.open, row.high, row.low, row.close, row.volume ?? 0);
        }
      });
      tx(rows);
      rowsWritten = rows.length;
      if (rowsWritten) {
        return {
          count: rowsWritten,
          summary: { start: rows.at(-1)?.date ?? null, end: rows.at(0)?.date ?? null, range },
        };
      }
    } catch (err) {
      console.warn('[market.fetchPriceHistory] massive price failed', (err as any)?.message ?? err);
    }
  }

  return { count: rowsWritten, summary: { start: null, end: null, range } };
}

export async function fetchOptionChain(symbol: string, db: Database) {
  const sym = normalizedSymbol(symbol);

  if (!process.env.MASSIVE_API_KEY) {
    return { summary: { expiries: 0 } };
  }

  try {
    const result = await fetchMassiveOptions(sym, undefined, db);
    const rows = db
      .prepare(
        `SELECT expiry_date, option_type, strike, last_price, bid, ask, volume, oi, iv
           FROM massive_options
          WHERE symbol = ?`
      )
      .all(sym) as Array<{
        expiry_date: string;
        option_type: string;
        strike: number;
        last_price: number;
        bid: number | null;
        ask: number | null;
        volume: number | null;
        oi: number | null;
        iv: number | null;
      }>;

    const insert = db.prepare(
      `REPLACE INTO option_chain(
        symbol, quote_date, option_type, expiration, strike,
        bid, ask, last, volume, open_interest, iv, delta, gamma, theta, vega
      ) VALUES(?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const tx = db.transaction((list: typeof rows) => {
      for (const row of list) {
        insert.run(
          sym,
          row.option_type === 'put' ? 'P' : 'C',
          row.expiry_date,
          row.strike,
          row.bid ?? null,
          row.ask ?? null,
          row.last_price ?? null,
          row.volume ?? null,
          row.oi ?? null,
          row.iv ?? null,
          null,
          null,
          null,
          null
        );
      }
    });
    tx(rows);

    const expiryCount = new Set(rows.map((r) => r.expiry_date)).size;
    return { summary: { expiries: expiryCount, total: result?.count ?? rows.length } };
  } catch (err) {
    console.warn('[market.fetchOptionChain] massive options failed', (err as any)?.message ?? err);
    return { summary: { expiries: 0 } };
  }
}

export async function fetchTickerNews(_symbol: string, _db: Database) {
  return { count: 0 };
}

// 주요 지수 심볼 매핑
const INDEX_SYMBOLS: Record<string, string> = {
  'SPY': 'S&P 500',
  '^GSPC': 'S&P 500',
  'DIA': '다우존스',
  '^DJI': '다우존스',
  'DJI': '다우존스',
  'QQQ': '나스닥',
  '^IXIC': '나스닥',
  'IXIC': '나스닥',
};

// 주가 차트 데이터 가져오기
export async function fetchStockChart(
  symbol: string,
  db: Database,
  days: number = 365
) {
  const sym = normalizedSymbol(symbol);
  
  // 먼저 데이터가 있는지 확인하고 없으면 가져오기
  if (process.env.MASSIVE_API_KEY) {
    try {
      await fetchMassivePriceHistory(sym, undefined, undefined, db);
    } catch (err) {
      console.warn('[market.fetchStockChart] massive price fetch failed', (err as any)?.message ?? err);
    }
  }

  // massive_price_history에서 데이터 가져오기
  const rows = db
    .prepare(
      `SELECT date, open, high, low, close, volume, adjusted_close
         FROM massive_price_history
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(sym, days) as Array<{
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      adjusted_close: number | null;
    }>;

  if (rows.length === 0) {
    // price_history에서도 시도
    const priceRows = db
      .prepare(
        `SELECT datetime(ts, 'unixepoch') as date, open, high, low, close, volume
           FROM price_history
          WHERE symbol = ?
          ORDER BY ts DESC
          LIMIT ?`
      )
      .all(sym, days) as Array<{
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }>;

    if (priceRows.length === 0) {
      return {
        symbol: sym,
        name: INDEX_SYMBOLS[sym] || sym,
        error: '데이터를 찾을 수 없습니다. 먼저 get_stock_data 또는 get_massive_stock_data를 호출하여 데이터를 가져오세요.',
        chartUrl: getChartUrl(sym),
      };
    }

    // price_history 데이터를 차트 형식으로 변환
    const chartData = priceRows
      .reverse()
      .map((row) => ({
        date: row.date.split(' ')[0], // 날짜만 추출
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        adjustedClose: row.close,
      }));

    const latest = priceRows[0];
    return {
      symbol: sym,
      name: INDEX_SYMBOLS[sym] || sym,
      latestPrice: latest.close,
      latestDate: latest.date.split(' ')[0],
      dataPoints: chartData.length,
      chartData: chartData.slice(-100), // 최근 100개만 반환
      chartUrl: getChartUrl(sym),
      dataRange: {
        start: chartData[0]?.date || null,
        end: chartData[chartData.length - 1]?.date || null,
      },
    };
  }

  // 차트 데이터 구조화
  const chartData = rows
    .reverse()
    .map((row) => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      adjustedClose: row.adjusted_close || row.close,
    }));

  const latest = rows[rows.length - 1];
  const first = rows[0];

  return {
    symbol: sym,
    name: INDEX_SYMBOLS[sym] || sym,
    latestPrice: latest.close,
    latestDate: latest.date,
    dataPoints: chartData.length,
    chartData: chartData.slice(-100), // 최근 100개만 반환
    chartUrl: getChartUrl(sym),
    dataRange: {
      start: first.date,
      end: latest.date,
    },
  };
}

// 차트 URL 생성 (TradingView, Yahoo Finance 등)
function getChartUrl(symbol: string): string {
  const sym = normalizedSymbol(symbol);
  // TradingView 차트 URL
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
}
