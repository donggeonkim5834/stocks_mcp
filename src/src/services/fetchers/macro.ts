import type { Database } from 'better-sqlite3';
import axios from 'axios';

// 주요 FRED 시리즈 ID 목록 (일별/주별/월별)
const FRED_SERIES = {
  // 미국 지표
  'US_CPI': 'CPIAUCSL', // 소비자물가지수
  'US_UNEMPLOYMENT': 'UNRATE', // 실업률
  'US_GDP': 'GDP', // 국내총생산
  'US_FED_FUNDS': 'FEDFUNDS', // 연준 기준금리
  'US_10Y_TREASURY': 'DGS10', // 10년 국채 수익률
  'US_2Y_TREASURY': 'DGS2', // 2년 국채 수익률
  'US_DOLLAR_INDEX': 'DTWEXBGS', // 달러 지수
  'US_CONSUMER_SENTIMENT': 'UMCSENT', // 소비자 심리
  // 글로벌
  'GLOBAL_OIL_PRICE': 'DCOILWTICO', // WTI 유가
  'GLOBAL_GOLD_PRICE': 'GOLDAMGBD228NLBM', // 금 가격
};

// 일별로 FRED 데이터 수집 (날짜별 저장)
export async function fetchFredDaily(
  seriesId: string,
  key: string,
  fredKey: string,
  db: Database,
  startDate?: string,
  endDate?: string
) {
  const start = startDate || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end = endDate || new Date().toISOString().slice(0, 10);

  const url = `https://api.stlouisfed.org/fred/series/observations`;
  const params: any = {
    series_id: seriesId,
    api_key: fredKey,
    file_type: 'json',
    observation_start: start,
    observation_end: end,
    frequency: 'd' // 일별
  };

  try {
    const { data } = await axios.get(url, { params });
    const observations = data.observations || [];

    const insert = db.prepare(`
      REPLACE INTO macro_indicators(key, ts, value, source)
      VALUES(?, ?, ?, 'FRED')
    `);

    const tx = db.transaction((rows: any[]) => {
      for (const o of rows) {
        if (o.value !== '.' && o.value != null) {
          const ts = Math.floor(new Date(o.date).getTime() / 1000);
          insert.run(key, ts, parseFloat(o.value));
        }
      }
    });

    tx(observations);
    return { count: observations.length, key, start, end };
  } catch (err: any) {
    return { count: 0, error: err.message, key };
  }
}

// FRED 시리즈 정보와 차트 데이터 가져오기
export async function fetchFredSeriesWithChart(
  seriesId: string,
  fredKey: string,
  startDate?: string,
  endDate?: string
) {
  const start = startDate || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end = endDate || new Date().toISOString().slice(0, 10);

  try {
    // 시리즈 메타데이터 가져오기
    const seriesUrl = `https://api.stlouisfed.org/fred/series`;
    const seriesParams: any = {
      series_id: seriesId,
      api_key: fredKey,
      file_type: 'json'
    };
    const { data: seriesData } = await axios.get(seriesUrl, { params: seriesParams });
    const seriesInfo = seriesData.seriess?.[0];

    // 시계열 데이터 가져오기
    const obsUrl = `https://api.stlouisfed.org/fred/series/observations`;
    const obsParams: any = {
      series_id: seriesId,
      api_key: fredKey,
      file_type: 'json',
      observation_start: start,
      observation_end: end
    };
    const { data: obsData } = await axios.get(obsUrl, { params: obsParams });
    const observations = obsData.observations || [];

    // 차트용 데이터 구조화
    const chartData = observations
      .filter((o: any) => o.value !== '.' && o.value != null)
      .map((o: any) => ({
        date: o.date,
        value: parseFloat(o.value),
        timestamp: Math.floor(new Date(o.date).getTime() / 1000)
      }));

    // FRED 공식 차트 URL 생성
    const chartUrl = `https://fred.stlouisfed.org/series/${seriesId}`;
    const chartImageUrl = `https://fred.stlouisfed.org/graph/fredgraph.png?id=${seriesId}`;

    return {
      seriesId,
      title: seriesInfo?.title || seriesId,
      units: seriesInfo?.units || '',
      frequency: seriesInfo?.frequency || '',
      seasonalAdjustment: seriesInfo?.seasonal_adjustment || '',
      lastUpdated: seriesInfo?.last_updated || '',
      observationStart: seriesInfo?.observation_start || '',
      observationEnd: seriesInfo?.observation_end || '',
      chartUrl,
      chartImageUrl,
      dataRange: { start, end },
      dataPoints: chartData.length,
      chartData: chartData.slice(-100), // 최근 100개 데이터포인트만 반환 (전체 데이터는 너무 클 수 있음)
      latestValue: chartData.length > 0 ? chartData[chartData.length - 1].value : null,
      latestDate: chartData.length > 0 ? chartData[chartData.length - 1].date : null
    };
  } catch (err: any) {
    return { 
      seriesId, 
      error: err.message,
      chartUrl: `https://fred.stlouisfed.org/series/${seriesId}`,
      chartImageUrl: `https://fred.stlouisfed.org/graph/fredgraph.png?id=${seriesId}`
    };
  }
}

// 모든 주요 거시지표 일별 수집
export async function fetchGlobalMacro(db: Database, source?: string) {
  const fredKey = process.env.FRED_API_KEY;
  const teKey = process.env.TRADING_ECONOMICS_KEY;
  let totalCount = 0;
  const results: any[] = [];

  if (fredKey) {
    // FRED에서 모든 주요 시리즈 수집
    for (const [key, seriesId] of Object.entries(FRED_SERIES)) {
      try {
        const result = await fetchFredDaily(seriesId, key, fredKey, db);
        totalCount += result.count;
        results.push(result);
      } catch (err: any) {
        results.push({ key, error: err.message });
      }
    }
  }

  // TradingEconomics (선택)
  if (teKey) {
    try {
      const { data } = await axios.get(`https://api.tradingeconomics.com/indicators/PMI?c=${teKey}&format=json`);
      const insert = db.prepare(`REPLACE INTO macro_indicators(key, ts, value, source) VALUES(?,?,?,?)`);
      const tx = db.transaction((rows: any[]) => {
        for (const r of rows) {
          const key = `PMI_${r.Country || r.Category || 'GLOBAL'}`;
          const ts = r.LastUpdate ? Math.floor(new Date(r.LastUpdate).getTime()/1000) : Math.floor(Date.now()/1000);
          const val = r.LatestValue ?? r.Value ?? null;
          if (val != null) insert.run(key, ts, Number(val), 'TradingEconomics');
        }
      });
      tx(data || []);
      totalCount += (data || []).length;
    } catch {}
  }

  return { updated: totalCount, source: source || 'auto', results };
}
