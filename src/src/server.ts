import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { initDb } from './services/db.js';
import { fetchStockChart } from './services/market-data.js';
import { fetchGlobalMacro, fetchFredSeriesWithChart } from './services/fetchers/macro.js';
import { 
  fetchMassiveAll, 
  fetchMassiveEarningsCalendar, 
  fetchMassiveAnalystConsensus,
  fetchMassiveReferenceData,
} from './services/fetchers/provider-massive-api.js';
import { fetchEdgarFilingsForSymbol, getCIKFromTicker } from './services/fetchers/edgar.js';
import {
  fetchRedditMentions,
  fetchTwitterMentions,
  detectMentionSpike,
  detectMultipleSpikes,
  detectUnknownSpikes,
} from './services/fetchers/social.js';
import { calculateAllIndicators } from './services/analysis/indicators.js';

const dbPath = (() => {
  const raw = process.env.DB_PATH;
  const resolved = raw ? path.resolve(raw) : path.resolve(process.cwd(), 'data', 'stocks.sqlite');
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return resolved;
})();

const db = new Database(dbPath);
initDb(db);

const server = new McpServer({ name: 'stocks-mcp-server', version: '0.1.0' });

// 1. FRED에서 거시 경제 데이터 가져오기 (차트 포함)
server.registerTool(
  'get_fred_data',
  {
    title: 'Fetch FRED Macro Economic Data',
    description: 'FRED API에서 거시 경제 지표 데이터와 차트를 가져옵니다. 주요 지표를 자동으로 갱신하고, 특정 시리즈의 상세 데이터와 차트를 제공합니다.',
    inputSchema: {
      action: z.enum(['refresh_all', 'get_series']).describe('refresh_all: 모든 주요 지표 갱신, get_series: 특정 시리즈 데이터 및 차트 조회'),
      seriesId: z.string().optional().describe('시리즈 ID (action이 get_series일 때 필수, 예: CPIAUCSL, UNRATE, GDP 등)'),
      startDate: z.string().optional().describe('시작 날짜 (YYYY-MM-DD 형식, 기본값: 1년 전)'),
      endDate: z.string().optional().describe('종료 날짜 (YYYY-MM-DD 형식, 기본값: 오늘)'),
    },
  },
  async ({ action, seriesId, startDate, endDate }) => {
    const fredKey = process.env.FRED_API_KEY;
    if (!fredKey) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'FRED_API_KEY가 설정되지 않았습니다.' }, null, 2) }],
        structuredContent: { error: 'FRED_API_KEY가 설정되지 않았습니다.' },
      };
    }

    if (action === 'refresh_all') {
      // 모든 주요 지표 갱신
      const res = await fetchGlobalMacro(db);
    const summary = {
        updated: res.updated,
        source: res.source,
        results: res.results,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
    } else if (action === 'get_series') {
      // 특정 시리즈 데이터 및 차트 조회
      if (!seriesId) {
    return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'seriesId가 필요합니다.' }, null, 2) }],
          structuredContent: { error: 'seriesId가 필요합니다.' },
        };
      }

      const result = await fetchFredSeriesWithChart(seriesId, fredKey, startDate, endDate);
      
      const responseText = result.error 
        ? JSON.stringify(result, null, 2)
        : `${result.title} (${result.seriesId})\n` +
          `단위: ${result.units}\n` +
          `주기: ${result.frequency}\n` +
          `최신 값: ${result.latestValue} (${result.latestDate})\n` +
          `데이터 포인트: ${result.dataPoints}개\n` +
          `차트 URL: ${result.chartUrl}\n` +
          `차트 이미지: ${result.chartImageUrl}\n\n` +
          `최근 데이터 (최근 10개):\n` +
          result.chartData.slice(-10).map((d: any) => `${d.date}: ${d.value}`).join('\n');
      
    return {
        content: [{ type: 'text', text: responseText }],
        structuredContent: result,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ error: '잘못된 action입니다.' }, null, 2) }],
      structuredContent: { error: '잘못된 action입니다.' },
    };
  }
);

// 2. EDGAR에서 SEC 공시 가져오기
server.registerTool(
  'get_edgar_data',
  {
    title: 'Fetch SEC Filings from EDGAR',
    description: 'EDGAR API에서 특정 종목의 SEC 공시를 가져와 DB에 저장합니다. CIK가 없으면 Massive.com에서 먼저 참조 데이터를 가져옵니다.',
    inputSchema: {
      symbol: z.string().min(1).describe('종목 심볼 (예: AAPL, MSFT 등)'),
      formTypes: z.array(z.string()).optional().describe('공시 유형 배열 (기본값: ["10-K", "10-Q", "8-K", "DEF 14A"])'),
    },
  },
  async ({ symbol, formTypes }) => {
    // CIK가 없으면 Massive.com에서 참조 데이터 먼저 가져오기
    let cik = await getCIKFromTicker(symbol, db);
    
    if (!cik && process.env.MASSIVE_API_KEY) {
      try {
        console.log(`[EDGAR] CIK를 찾을 수 없어 Massive.com에서 참조 데이터를 가져옵니다: ${symbol}`);
        await fetchMassiveReferenceData(symbol, db);
        // 다시 CIK 조회
        cik = await getCIKFromTicker(symbol, db);
      } catch (err: any) {
        console.warn(`[EDGAR] Massive.com 참조 데이터 가져오기 실패: ${err?.message}`);
      }
    }
    
    const result = await fetchEdgarFilingsForSymbol(
      symbol,
      formTypes || ['10-K', '10-Q', '8-K', 'DEF 14A'],
      db
    );
    
    // CIK를 찾지 못한 경우 더 명확한 안내 메시지 추가
    const resultWithSuggestion: any = result;
    if (result.error && result.error.includes('CIK not found')) {
      resultWithSuggestion.suggestion = `CIK를 찾기 위해 다음 중 하나를 시도하세요:
1. get_massive_data("${symbol}") - Massive.com에서 참조 데이터(CIK 포함) 가져오기
2. .env 파일에 MASSIVE_API_KEY가 올바르게 설정되어 있는지 확인
3. EDGAR_USER_AGENT 환경변수가 올바른 형식인지 확인 (예: "CompanyName contact@email.com")`;
    }
    
    return {
      content: [{ type: 'text', text: JSON.stringify(resultWithSuggestion, null, 2) }],
      structuredContent: resultWithSuggestion,
    };
  }
);

// 3. Massive에서 주가 관련 데이터 가져오기 (차트 포함)
server.registerTool(
  'get_massive_data',
  {
    title: 'Fetch Stock Data from Massive.com',
    description: 'Massive.com API에서 종목의 모든 주가 관련 데이터(가격/참조/기업행위/기술지표/옵션/실적 캘린더/분석가 합의 등)와 차트를 가져옵니다. 개별 종목 또는 주요 지수(S&P 500, 다우존스, 나스닥)를 지원합니다.',
    inputSchema: {
      symbol: z.string().min(1).describe('종목 심볼 또는 지수 (예: AAPL, MSFT, SPY, DIA, QQQ, ^GSPC, ^DJI, ^IXIC)'),
      includeChart: z.boolean().optional().default(true).describe('차트 데이터 포함 여부'),
      chartDays: z.number().optional().default(365).describe('차트 데이터 기간 (일수)'),
      includeEarnings: z.boolean().optional().default(false).describe('실적 캘린더 포함 여부'),
      includeAnalyst: z.boolean().optional().default(false).describe('분석가 합의 포함 여부'),
      massiveIndicators: z.array(z.string()).optional().default(['SMA_5', 'SMA_10', 'SMA_20', 'SMA_60', 'SMA_120', 'SMA_200', 'EMA_5', 'EMA_10', 'EMA_20', 'EMA_60', 'EMA_120', 'EMA_200', 'MACD', 'RSI']).describe('Massive.com에서 가져올 기술적 지표 목록 (예: ["RSI", "MACD"])'),
    },
  },
  async ({ symbol, includeChart, chartDays, includeEarnings, includeAnalyst, massiveIndicators }) => {
    if (!process.env.MASSIVE_API_KEY) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'MASSIVE_API_KEY가 설정되지 않았습니다.' }, null, 2) }],
        structuredContent: { error: 'MASSIVE_API_KEY가 설정되지 않았습니다.' },
      };
    }

    try {
      // 기본 주가 데이터 가져오기
      const results = await fetchMassiveAll(symbol, db, massiveIndicators); // Pass indicators to fetchMassiveAll
      
      // 차트 데이터 포함
      let chart = null;
      if (includeChart) {
        chart = await fetchStockChart(symbol, db, chartDays || 365);
      }

      // 실적 캘린더 포함
      let earnings = null;
      if (includeEarnings) {
        try {
          earnings = await fetchMassiveEarningsCalendar(symbol, db);
        } catch (err: any) {
          earnings = { error: err.message };
        }
      }

      // 분석가 합의 포함
      let analyst = null;
      if (includeAnalyst) {
        try {
          analyst = await fetchMassiveAnalystConsensus(symbol, db);
        } catch (err: any) {
          analyst = { error: err.message };
        }
      }

      const combinedResults = {
        ...results,
        ...(chart && { chart }),
        ...(earnings && { earnings }),
        ...(analyst && { analyst }),
      };

      // 텍스트 요약 생성
      const summaryParts = [
        `종목: ${symbol}`,
        results.reference ? `회사명: ${results.reference.company_name || 'N/A'}` : '',
        chart ? `최신 가격: $${chart.latestPrice?.toFixed(2)} (${chart.latestDate})` : '',
        chart ? `차트 URL: ${chart.chartUrl}` : '',
        results.priceHistory ? `가격 데이터: ${results.priceHistory.count}개` : '',
        results.options ? `옵션 체인: ${results.options.count}개` : '',
        earnings ? `실적 캘린더: ${earnings.count || 0}개` : '',
        analyst ? `분석가 합의: ${analyst.rating_count || 0}명` : '',
      ].filter(Boolean);

      return {
        content: [{ type: 'text', text: summaryParts.join('\n') + '\n\n' + JSON.stringify(combinedResults, null, 2) }],
        structuredContent: combinedResults,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        structuredContent: { error: err.message },
      };
    }
  }
);

// 4. 로컬에서 기술적 보조지표 계산
server.registerTool(
  'calculate_local_indicators',
  {
    title: 'Calculate Local Technical Indicators',
    description: 'Massive.com에서 제공하지 않는 다양한 기술적 보조지표를 로컬 데이터베이스의 시세 데이터를 기반으로 계산합니다.',
    inputSchema: {
      symbol: z.string().min(1).describe('종목 심볼 (예: AAPL, MSFT 등)'),
    },
  },
  async ({ symbol }) => {
    try {
      const indicators = calculateAllIndicators(symbol, db);
      return {
        content: [{ type: 'text', text: JSON.stringify(indicators, null, 2) }],
        structuredContent: indicators,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        structuredContent: { error: err.message },
      };
    }
  }
);

// 5. 소셜 미디어 감정 분석 및 언급량 추적
server.registerTool(
  'get_social_sentiment',
  {
    title: 'Fetch Social Media Sentiment',
    description: 'Reddit(WSB) 및 Twitter/X에서 종목 언급량과 감정을 분석합니다. 언급량 급증 탐지 기능을 포함합니다.',
    inputSchema: {
      action: z.enum(['get_mentions', 'detect_spike', 'detect_all_spikes', 'detect_unknown_spikes']).describe('get_mentions: 언급 조회, detect_spike: 특정 종목 급증 탐지, detect_all_spikes: 여러 종목 급증 탐지, detect_unknown_spikes: 심볼 없이 자동 급증 탐지'),
      symbol: z.string().optional().describe('종목 심볼 (get_mentions 또는 detect_spike일 때 필요)'),
      symbols: z.array(z.string()).optional().describe('종목 심볼 배열 (detect_all_spikes일 때 필요)'),
      platform: z.enum(['reddit', 'twitter', 'both']).optional().default('reddit').describe('플랫폼 선택'),
      subreddit: z.string().optional().default('wallstreetbets').describe('Reddit 서브레딧 (기본값: wallstreetbets)'),
      limit: z.number().optional().default(100).describe('가져올 포스트 수 (기본값: 100)'),
      days: z.number().optional().default(7).describe('급증 탐지 기간 (일수, 기본값: 7일)'),
      minSpikeRatio: z.number().optional().describe('급증으로 판단할 최소 배수 (기본값: 2.0)'),
      minMentions: z.number().optional().describe('급증으로 판단할 최소 언급 수 (기본값: 5)'),
    },
  },
  async ({ action, symbol, symbols, platform, subreddit, limit, days, minSpikeRatio, minMentions }) => {
    try {
      if (action === 'get_mentions') {
        if (!symbol) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'symbol이 필요합니다.' }, null, 2) }],
            structuredContent: { error: 'symbol이 필요합니다.' },
          };
        }

        const results: any = {};

        if (platform === 'reddit' || platform === 'both') {
          results.reddit = await fetchRedditMentions(symbol, subreddit, limit, db);
        }

        if (platform === 'twitter' || platform === 'both') {
          results.twitter = await fetchTwitterMentions(symbol, limit, db);
        }

        const summary = [
          `종목: ${symbol.toUpperCase()}`,
          results.reddit ? `Reddit 언급: ${results.reddit.count}개 (감정: ${results.reddit.sentiment?.label || 'N/A'})` : '',
          results.reddit?.fallbackTrending ? 'Reddit 결과가 없어서 WSB 인기 종목을 함께 제공합니다.' : '',
          results.twitter ? `Twitter 언급: ${results.twitter.count}개 (감정: ${results.twitter.sentiment?.label || 'N/A'})` : '',
        ].filter(Boolean).join('\n');

        return {
          content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(results, null, 2) }],
          structuredContent: results,
        };
      } else if (action === 'detect_spike') {
        if (!symbol) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'symbol이 필요합니다.' }, null, 2) }],
            structuredContent: { error: 'symbol이 필요합니다.' },
          };
        }

        const platforms = platform === 'both' ? ['reddit', 'twitter'] : [platform];
        const results: any = {};

        for (const plat of platforms) {
          try {
            results[plat] = await detectMentionSpike(symbol, plat, days, db);
          } catch (err: any) {
            results[plat] = { error: err.message };
          }
        }

        const spikeDetected = Object.values(results).some((r: any) => r.spikeDetected);
        const summary = [
          `종목: ${symbol.toUpperCase()}`,
          spikeDetected ? '⚠️ 언급량 급증 감지!' : '언급량 정상',
          ...Object.entries(results).map(([plat, data]: [string, any]) => {
            if (data.error) return `${plat}: 오류`;
            return `${plat}: 현재 ${data.currentMentions}개 (평균: ${data.avgMentions.toFixed(1)}개, 비율: ${data.spikeRatio.toFixed(2)}x)`;
          }),
        ].join('\n');

        return {
          content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(results, null, 2) }],
          structuredContent: results,
        };
      } else if (action === 'detect_all_spikes') {
        if (!symbols || symbols.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'symbols 배열이 필요합니다.' }, null, 2) }],
            structuredContent: { error: 'symbols 배열이 필요합니다.' },
          };
        }

        const platforms = platform === 'both' ? ['reddit', 'twitter'] : [platform];
        const allResults: any = {};

        for (const plat of platforms) {
          try {
            allResults[plat] = await detectMultipleSpikes(symbols, plat, days, db);
          } catch (err: any) {
            allResults[plat] = { error: err.message };
          }
        }

        const summary = [
          `스캔한 종목: ${symbols.length}개`,
          ...Object.entries(allResults).map(([plat, data]: [string, any]) => {
            if (data.error) return `${plat}: 오류`;
            return `${plat}: ${data.spikesDetected}개 급증 감지`;
          }),
          '',
          '급증 종목 (상위 10개):',
          ...Object.values(allResults)
            .flatMap((data: any) => data.spikes || [])
            .slice(0, 10)
            .map((spike: any) => `- ${spike.symbol}: ${spike.spikeRatio.toFixed(2)}x (${spike.currentMentions}개)`),
        ].join('\n');

        return {
          content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(allResults, null, 2) }],
          structuredContent: allResults,
        };
      } else if (action === 'detect_unknown_spikes') {
        const platforms = platform === 'both' ? ['reddit', 'twitter'] : [platform];
        const allResults: any = {};

        for (const plat of platforms) {
          try {
            allResults[plat] = await detectUnknownSpikes(plat, days, db, {
              minMentions,
              minSpikeRatio,
            });
          } catch (err: any) {
            allResults[plat] = { error: err.message };
          }
        }

        const summaryParts: string[] = [
          `자동 급증 탐지 (최근 ${days ?? 7}일)`,
          ...Object.entries(allResults).map(([plat, data]: [string, any]) => {
            if (data.error) return `${plat}: 오류 - ${data.error}`;
            return `${plat}: ${data.spikesDetected}개 급증 감지 (스캔 ${data.totalScanned}개)`;
          }),
          '',
          '급증 종목 (상위 10개):',
        ];

        const spikesList = Object.values(allResults)
          .flatMap((data: any) => data.spikes || [])
          .slice(0, 10)
          .map((spike: any) => {
            const ratio = Number.isFinite(spike.spikeRatio)
              ? spike.spikeRatio.toFixed(2)
              : '∞';
            return `- ${spike.symbol}: ${ratio}x (${spike.currentMentions}개), 감정: ${spike.sentiment?.label ?? 'N/A'}`;
          });

        if (spikesList.length === 0) {
          summaryParts.push('- 급증 종목 없음');
        } else {
          summaryParts.push(...spikesList);
        }

        return {
          content: [{ type: 'text', text: summaryParts.join('\n') + '\n\n' + JSON.stringify(allResults, null, 2) }],
          structuredContent: allResults,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ error: '잘못된 action입니다.' }, null, 2) }],
        structuredContent: { error: '잘못된 action입니다.' },
      };
    } catch (err: any) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        structuredContent: { error: err.message },
    };
    }
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
