import type { Database } from 'better-sqlite3';
import axios from 'axios';
import { massiveRateLimiter } from '../../utils/rateLimiter.js';

const MASSIVE_API_BASE = 'https://api.massive.com/v1'; // 실제 엔드포인트 확인 필요
const API_KEY = process.env.MASSIVE_API_KEY || '';

async function massiveRequest(endpoint: string, params: Record<string, any> = {}) {
  if (!API_KEY) throw new Error('MASSIVE_API_KEY not set');
  await massiveRateLimiter.acquire();
  const { data } = await axios.get(`${MASSIVE_API_BASE}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    params
  });
  return data;
}

// 2번째 사진 기준: EOD 가격 데이터 (2년 과거)
export async function fetchMassivePriceHistory(
  symbol: string,
  startDate?: string,
  endDate?: string,
  db?: Database
) {
  const end = endDate || new Date().toISOString().slice(0, 10);
  const start = startDate || new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 2년 전

  const data = await massiveRequest('/eod/prices', { symbol, start_date: start, end_date: end });

  if (db && data?.data) {
    const insert = db.prepare(`
      REPLACE INTO massive_price_history(symbol, date, open, high, low, close, volume, adjusted_close)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((rows: any[]) => {
      for (const r of rows) {
        insert.run(
          symbol,
          r.date || r.timestamp?.slice(0, 10),
          r.open, r.high, r.low, r.close, r.volume || 0,
          r.adjusted_close || r.close
        );
      }
    });
    tx(data.data);
  }

  return { count: data?.data?.length || 0, start, end };
}

// 참조 데이터 (ISIN/CUSIP/FIGI, 섹터, 시가총액 등)
export async function fetchMassiveReferenceData(symbol: string, db?: Database) {
  const data = await massiveRequest('/reference/symbol', { symbol });

  if (db && data) {
    // CIK 정규화 (10자리 패딩)
    const normalizedCik = data.cik ? String(data.cik).trim().padStart(10, '0') : null;
    
    const insert = db.prepare(`
      REPLACE INTO massive_reference_data(
        symbol, isin, cusip, figi, cik, sector, industry, exchange,
        market_cap, shares_outstanding, data_json, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    insert.run(
      symbol,
      data.isin || null, 
      data.cusip || null, 
      data.figi || null, 
      normalizedCik,
      data.sector || null, 
      data.industry || null, 
      data.exchange || null,
      data.market_cap || null, 
      data.shares_outstanding || null,
      JSON.stringify(data)
    );

    // 티커 매핑 테이블에도 저장 (CIK가 있을 때만)
    if (normalizedCik && normalizedCik !== '0000000000') {
      try {
        const mappingInsert = db.prepare(`
          REPLACE INTO ticker_mapping(symbol, cik, isin, cusip, figi, updated_at)
          VALUES(?, ?, ?, ?, ?, datetime('now'))
        `);
        mappingInsert.run(
          symbol, 
          normalizedCik, 
          data.isin || null, 
          data.cusip || null, 
          data.figi || null
        );
      } catch (err: any) {
        console.warn('[Massive] ticker_mapping insert failed:', err?.message);
      }
    }
  }

  return data;
}

// 기업 행위 (분할, 배당, 티커 변경 등)
export async function fetchMassiveCorporateActions(symbol: string, db?: Database) {
  const data = await massiveRequest('/corporate-actions', { symbol });

  if (db && data?.data) {
    const insert = db.prepare(`
      REPLACE INTO corporate_actions(symbol, action_date, action_type, details_json)
      VALUES(?, ?, ?, ?)
    `);
    const tx = db.transaction((rows: any[]) => {
      for (const r of rows) {
        insert.run(
          symbol,
          r.date || r.effective_date,
          r.type || r.action_type,
          JSON.stringify(r)
        );
      }
    });
    tx(data.data);
  }

  return { count: data?.data?.length || 0 };
}

// 기술 지표
export async function fetchMassiveTechnicalIndicators(
  symbol: string,
  indicators: string[] = ['RSI', 'MACD', 'SMA_50', 'SMA_200'],
  db?: Database
) {
  const data = await massiveRequest('/technical/indicators', { symbol, indicators: indicators.join(',') });

  if (db && data?.data) {
    const insert = db.prepare(`
      REPLACE INTO technical_indicators(symbol, date, indicator_name, value)
      VALUES(?, ?, ?, ?)
    `);
    const tx = db.transaction((rows: any[]) => {
      for (const row of rows) {
        const date = row.date || row.timestamp?.slice(0, 10);
        for (const ind of indicators) {
          if (row[ind] != null) {
            insert.run(symbol, date, ind, row[ind]);
          }
        }
      }
    });
    tx(data.data || []);
  }

  return { indicators, count: data?.data?.length || 0 };
}

// 옵션 데이터 (IV/OI/Skew)
export async function fetchMassiveOptions(symbol: string, expiry?: string, db?: Database) {
  const params: any = { symbol };
  if (expiry) params.expiry_date = expiry;

  const data = await massiveRequest('/options/chain', params);

  if (db && data?.data) {
    const insert = db.prepare(`
      REPLACE INTO massive_options(
        symbol, expiry_date, option_type, strike, iv, oi, volume,
        last_price, bid, ask, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    const tx = db.transaction((rows: any[]) => {
      for (const r of rows) {
        insert.run(
          symbol,
          r.expiry_date || r.expiry,
          r.type || 'call',
          r.strike,
          r.iv || r.implied_volatility,
          r.open_interest || r.oi,
          r.volume || 0,
          r.last_price || r.price,
          r.bid, r.ask
        );
        if (r.type === 'put' || (r.type === 'call' && r.put_data)) {
          insert.run(
            symbol,
            r.expiry_date || r.expiry,
            'put',
            r.strike,
            r.iv || r.implied_volatility,
            r.open_interest || r.oi,
            r.volume || 0,
            r.last_price || r.price,
            r.bid, r.ask
          );
        }
      }
    });
    tx(data.data || []);
  }

  return { expiries: data?.expiries?.length || 0, count: data?.data?.length || 0 };
}

// 실적 캘린더
export async function fetchMassiveEarningsCalendar(symbol?: string, db?: Database) {
  const params: any = {};
  if (symbol) params.symbol = symbol;

  const data = await massiveRequest('/earnings/calendar', params);

  if (db && data?.data) {
    const insert = db.prepare(`
      REPLACE INTO earnings_calendar(
        symbol, report_date, fiscal_period, eps_actual, eps_estimate, eps_surprise,
        revenue_actual, revenue_estimate, conference_call_time
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((rows: any[]) => {
      for (const r of rows) {
        insert.run(
          r.symbol || r.ticker,
          r.report_date || r.date,
          r.fiscal_period,
          r.eps_actual, r.eps_estimate, r.eps_surprise,
          r.revenue_actual, r.revenue_estimate,
          r.conference_call_time || r.cc_time
        );
      }
    });
    tx(data.data || []);
  }

  return { count: data?.data?.length || 0 };
}

// 애널리스트 컨센서스
export async function fetchMassiveAnalystConsensus(symbol: string, db?: Database) {
  const data = await massiveRequest('/analyst/consensus', { symbol });

  if (db && data) {
    const insert = db.prepare(`
      REPLACE INTO analyst_consensus(
        symbol, updated_at, rating_count, rating_avg, price_target, consensus_json
      ) VALUES(?, datetime('now'), ?, ?, ?, ?)
    `);
    insert.run(
      symbol,
      data.rating_count || 0,
      data.rating_avg || data.average_rating,
      data.price_target || data.target_price,
      JSON.stringify(data)
    );
  }

  return data;
}

// 공매도 데이터
export async function fetchMassiveShortInterest(symbol: string, db?: Database) {
  const data = await massiveRequest('/short-interest', { symbol });

  if (db && data?.data) {
    const insert = db.prepare(`
      REPLACE INTO short_interest(symbol, date, short_interest, short_ratio)
      VALUES(?, ?, ?, ?)
    `);
    const tx = db.transaction((rows: any[]) => {
      for (const r of rows) {
        insert.run(
          symbol,
          r.date || r.settlement_date,
          r.short_interest, r.short_ratio
        );
      }
    });
    tx(data.data || []);
  }

  return { count: data?.data?.length || 0 };
}

// 거래소 캘린더
export async function fetchMassiveMarketCalendar(exchange: string = 'NASDAQ', db?: Database) {
  const data = await massiveRequest('/market/calendar', { exchange });

  if (db && data?.data) {
    const insert = db.prepare(`
      REPLACE INTO market_calendar(date, is_trading_day, market_status, session_open, session_close)
      VALUES(?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((rows: any[]) => {
      for (const r of rows) {
        insert.run(
          r.date,
          r.is_trading_day ? 1 : 0,
          r.status || r.market_status,
          r.session_open, r.session_close
        );
      }
    });
    tx(data.data || []);
  }

  return { count: data?.data?.length || 0 };
}

// 통합: 모든 데이터 가져오기
export async function fetchMassiveAll(symbol: string, db: Database, massiveIndicators?: string[]) {
  const results: any = {};
  try {
    results.priceHistory = await fetchMassivePriceHistory(symbol, undefined, undefined, db);
    results.reference = await fetchMassiveReferenceData(symbol, db);
    results.corporateActions = await fetchMassiveCorporateActions(symbol, db);
    // Pass massiveIndicators to fetchMassiveTechnicalIndicators
    results.technical = await fetchMassiveTechnicalIndicators(symbol, massiveIndicators, db);
    results.options = await fetchMassiveOptions(symbol, undefined, db);
    results.earnings = await fetchMassiveEarningsCalendar(symbol, db);
    results.analyst = await fetchMassiveAnalystConsensus(symbol, db);
    results.shortInterest = await fetchMassiveShortInterest(symbol, db);
  } catch (err: any) {
    results.error = err.message;
  }
  return results;
}
