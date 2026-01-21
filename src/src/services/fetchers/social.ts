import type { Database } from 'better-sqlite3';
import axios from 'axios';

// 간단한 감정 분석 (긍정/부정/중립 키워드 기반)
const POSITIVE_KEYWORDS = [
  'moon', 'rocket', 'bullish', 'buy', 'long', 'hold', 'diamond hands',
  'to the moon', 'pump', 'surge', 'rally', 'gain', 'profit', 'win',
  'great', 'amazing', 'love', 'best', 'strong', 'up', 'rise', 'soar'
];

const NEGATIVE_KEYWORDS = [
  'crash', 'dump', 'bearish', 'sell', 'short', 'paper hands', 'drop',
  'fall', 'loss', 'fail', 'bad', 'terrible', 'worst', 'weak', 'down',
  'plunge', 'sink', 'decline', 'bear', 'red', 'panic', 'fear'
];

function analyzeSentiment(text: string): { score: number; label: string } {
  const lowerText = text.toLowerCase();
  let positiveCount = 0;
  let negativeCount = 0;

  POSITIVE_KEYWORDS.forEach(keyword => {
    if (lowerText.includes(keyword)) positiveCount++;
  });

  NEGATIVE_KEYWORDS.forEach(keyword => {
    if (lowerText.includes(keyword)) negativeCount++;
  });

  const total = positiveCount + negativeCount;
  if (total === 0) {
    return { score: 0, label: 'neutral' };
  }

  const score = (positiveCount - negativeCount) / total; // -1 to 1
  let label = 'neutral';
  if (score > 0.2) label = 'positive';
  else if (score < -0.2) label = 'negative';

  return { score, label };
}

// Reddit API를 통한 WSB 서브레딧 데이터 가져오기
export async function fetchRedditMentions(
  symbol: string,
  subreddit: string = 'wallstreetbets',
  limit: number = 100,
  db?: Database
) {
  try {
    // Reddit JSON API 사용 (인증 불필요, 제한적)
    const url = `https://www.reddit.com/r/${subreddit}/search.json`;
    const params = {
      q: symbol,
      limit,
      sort: 'new',
      restrict_sr: 1,
    };

    const { data } = await axios.get(url, { 
      params,
      headers: {
        'User-Agent': 'stocks-mcp-server/1.0',
      },
      timeout: 10000,
    });

    const posts = data?.data?.children || [];
    const mentions: any[] = [];

    for (const post of posts) {
      const postData = post.data;
      if (!postData) continue;

      const fullText = `${postData.title || ''} ${postData.selftext || ''}`.trim();
      const sentiment = analyzeSentiment(fullText);

      const mention = {
        id: `reddit_${postData.id}`,
        symbol: symbol.toUpperCase(),
        platform: 'reddit',
        post_id: postData.id,
        author: postData.author,
        title: postData.title,
        content: postData.selftext?.substring(0, 1000) || '',
        url: `https://reddit.com${postData.permalink}`,
        upvotes: postData.ups || 0,
        comments: postData.num_comments || 0,
        sentiment_score: sentiment.score,
        sentiment_label: sentiment.label,
        created_at: Math.floor(postData.created_utc),
        collected_at: Math.floor(Date.now() / 1000),
      };

      mentions.push(mention);

      // DB에 저장
      if (db) {
        try {
          db.prepare(`
            INSERT OR REPLACE INTO social_mentions(
              id, symbol, platform, post_id, author, title, content, url,
              upvotes, comments, sentiment_score, sentiment_label, created_at, collected_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            mention.id,
            mention.symbol,
            mention.platform,
            mention.post_id,
            mention.author,
            mention.title,
            mention.content,
            mention.url,
            mention.upvotes,
            mention.comments,
            mention.sentiment_score,
            mention.sentiment_label,
            mention.created_at,
            mention.collected_at
          );
        } catch (err) {
          console.warn(`[social] DB 저장 실패: ${(err as any)?.message}`);
        }
      }
    }

    // 일별 트렌드 업데이트
    if (db && mentions.length > 0) {
      updateMentionTrends(symbol, 'reddit', mentions, db);
    }

  let fallbackTrending: any[] | null = null;
  if (mentions.length === 0 && subreddit.toLowerCase() === 'wallstreetbets') {
    try {
      const { data: trending } = await axios.get('https://tradestie.com/api/v1/apps/reddit', {
        timeout: 10000,
      });
      if (Array.isArray(trending) && trending.length > 0) {
        fallbackTrending = trending.slice(0, 20);
      }
    } catch (err) {
      console.warn(`[social] Reddit fallback trending 실패: ${(err as any)?.message}`);
    }
  }

    return {
      symbol: symbol.toUpperCase(),
      platform: 'reddit',
      subreddit,
      count: mentions.length,
      mentions: mentions.slice(0, 20), // 최근 20개만 반환
      sentiment: calculateAverageSentiment(mentions),
    fallbackTrending,
    };
  } catch (err: any) {
    return {
      symbol: symbol.toUpperCase(),
      platform: 'reddit',
      error: err.message,
      count: 0,
    };
  }
}

// Twitter/X API를 통한 데이터 가져오기 (선택적, API 키 필요)
export async function fetchTwitterMentions(
  symbol: string,
  limit: number = 100,
  db?: Database
) {
  // Twitter API v2는 Bearer Token이 필요합니다
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  
  if (!bearerToken) {
    return {
      symbol: symbol.toUpperCase(),
      platform: 'twitter',
      error: 'TWITTER_BEARER_TOKEN이 설정되지 않았습니다.',
      count: 0,
    };
  }

  try {
    const url = 'https://api.twitter.com/2/tweets/search/recent';
    const params = {
      query: `$${symbol.toUpperCase()} -is:retweet lang:en`,
      max_results: Math.min(limit, 100),
      'tweet.fields': 'created_at,public_metrics,author_id',
    };

    const { data } = await axios.get(url, {
      params,
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
      },
      timeout: 10000,
    });

    const tweets = data?.data || [];
    const mentions: any[] = [];

    for (const tweet of tweets) {
      const sentiment = analyzeSentiment(tweet.text);
      const metrics = tweet.public_metrics || {};

      const mention = {
        id: `twitter_${tweet.id}`,
        symbol: symbol.toUpperCase(),
        platform: 'twitter',
        post_id: tweet.id,
        author: tweet.author_id,
        title: null,
        content: tweet.text,
        url: `https://twitter.com/i/web/status/${tweet.id}`,
        upvotes: metrics.like_count || 0,
        comments: metrics.reply_count || 0,
        sentiment_score: sentiment.score,
        sentiment_label: sentiment.label,
        created_at: Math.floor(new Date(tweet.created_at).getTime() / 1000),
        collected_at: Math.floor(Date.now() / 1000),
      };

      mentions.push(mention);

      if (db) {
        try {
          db.prepare(`
            INSERT OR REPLACE INTO social_mentions(
              id, symbol, platform, post_id, author, title, content, url,
              upvotes, comments, sentiment_score, sentiment_label, created_at, collected_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            mention.id,
            mention.symbol,
            mention.platform,
            mention.post_id,
            mention.author,
            mention.title,
            mention.content,
            mention.url,
            mention.upvotes,
            mention.comments,
            mention.sentiment_score,
            mention.sentiment_label,
            mention.created_at,
            mention.collected_at
          );
        } catch (err) {
          console.warn(`[social] DB 저장 실패: ${(err as any)?.message}`);
        }
      }
    }

    if (db && mentions.length > 0) {
      updateMentionTrends(symbol, 'twitter', mentions, db);
    }

    return {
      symbol: symbol.toUpperCase(),
      platform: 'twitter',
      count: mentions.length,
      mentions: mentions.slice(0, 20),
      sentiment: calculateAverageSentiment(mentions),
    };
  } catch (err: any) {
    return {
      symbol: symbol.toUpperCase(),
      platform: 'twitter',
      error: err.message,
      count: 0,
    };
  }
}

// 일별 트렌드 업데이트
function updateMentionTrends(
  symbol: string,
  platform: string,
  mentions: any[],
  db: Database
) {
  const today = new Date().toISOString().slice(0, 10);
  
  // 오늘 날짜의 언급들만 필터링
  const todayMentions = mentions.filter(m => {
    const mentionDate = new Date(m.created_at * 1000).toISOString().slice(0, 10);
    return mentionDate === today;
  });

  if (todayMentions.length === 0) return;

  const totalUpvotes = todayMentions.reduce((sum, m) => sum + (m.upvotes || 0), 0);
  const totalComments = todayMentions.reduce((sum, m) => sum + (m.comments || 0), 0);
  const avgSentiment = calculateAverageSentiment(todayMentions).score;

  db.prepare(`
    INSERT OR REPLACE INTO mention_trends(
      symbol, platform, date, mention_count, avg_sentiment, total_upvotes, total_comments
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol.toUpperCase(),
    platform,
    today,
    todayMentions.length,
    avgSentiment,
    totalUpvotes,
    totalComments
  );
}

// 평균 감정 계산
function calculateAverageSentiment(mentions: any[]): { score: number; label: string } {
  if (mentions.length === 0) {
    return { score: 0, label: 'neutral' };
  }

  const avgScore = mentions.reduce((sum, m) => sum + (m.sentiment_score || 0), 0) / mentions.length;
  let label = 'neutral';
  if (avgScore > 0.2) label = 'positive';
  else if (avgScore < -0.2) label = 'negative';

  return { score: avgScore, label };
}

// 언급량 급증 탐지
export async function detectMentionSpike(
  symbol: string,
  platform: string,
  days: number = 7,
  db: Database
): Promise<{
  symbol: string;
  platform: string;
  spikeDetected: boolean;
  currentMentions: number;
  avgMentions: number;
  spikeRatio: number;
  sentiment: { score: number; label: string };
  trend: any[];
}> {
  const today = new Date();
  const trend: any[] = [];

  // 최근 N일간의 트렌드 데이터 가져오기
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);

    const row = db.prepare(`
      SELECT * FROM mention_trends
      WHERE symbol = ? AND platform = ? AND date = ?
    `).get(symbol.toUpperCase(), platform, dateStr) as any;

    if (row) {
      trend.push({
        date: row.date,
        mention_count: row.mention_count,
        avg_sentiment: row.avg_sentiment,
        total_upvotes: row.total_upvotes,
        total_comments: row.total_comments,
      });
    } else {
      trend.push({
        date: dateStr,
        mention_count: 0,
        avg_sentiment: 0,
        total_upvotes: 0,
        total_comments: 0,
      });
    }
  }

  trend.reverse(); // 오래된 것부터 정렬

  const currentMentions = trend[trend.length - 1]?.mention_count || 0;
  const pastMentions = trend.slice(0, -1).map(t => t.mention_count);
  const avgMentions = pastMentions.length > 0
    ? pastMentions.reduce((a, b) => a + b, 0) / pastMentions.length
    : 0;

  const spikeRatio = avgMentions > 0 ? currentMentions / avgMentions : 0;
  const spikeDetected = spikeRatio >= 2.0; // 2배 이상 증가 시 급증으로 판단

  const recentSentiment = trend.slice(-3).map(t => t.avg_sentiment);
  const avgSentiment = recentSentiment.length > 0
    ? recentSentiment.reduce((a, b) => a + b, 0) / recentSentiment.length
    : 0;

  let sentimentLabel = 'neutral';
  if (avgSentiment > 0.2) sentimentLabel = 'positive';
  else if (avgSentiment < -0.2) sentimentLabel = 'negative';

  return {
    symbol: symbol.toUpperCase(),
    platform,
    spikeDetected,
    currentMentions,
    avgMentions,
    spikeRatio,
    sentiment: { score: avgSentiment, label: sentimentLabel },
    trend,
  };
}

// 여러 종목의 언급량 급증 탐지
export async function detectMultipleSpikes(
  symbols: string[],
  platform: string,
  days: number = 7,
  db: Database
) {
  const results = await Promise.all(
    symbols.map(symbol => detectMentionSpike(symbol, platform, days, db))
  );

  // 급증이 감지된 종목만 필터링 및 정렬
  const spikes = results
    .filter(r => r.spikeDetected)
    .sort((a, b) => b.spikeRatio - a.spikeRatio);

  return {
    platform,
    totalScanned: symbols.length,
    spikesDetected: spikes.length,
    spikes: spikes.slice(0, 10), // 상위 10개만 반환
  };
}

// 심볼 목록 없이 자동으로 급증 종목 탐지
export async function detectUnknownSpikes(
  platform: string,
  days: number = 7,
  db: Database,
  options?: {
    minMentions?: number;
    minSpikeRatio?: number;
  }
) {
  const minMentions = options?.minMentions ?? 5;
  const minSpikeRatio = options?.minSpikeRatio ?? 2.0;

  const dates: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  if (dates.length === 0) {
    return {
      platform,
      days,
      totalScanned: 0,
      spikesDetected: 0,
      spikes: [],
    };
  }

  const placeholders = dates.map(() => '?').join(', ');

  const rows = db
    .prepare(
      `
      SELECT symbol, date, mention_count, avg_sentiment, total_upvotes, total_comments
      FROM mention_trends
      WHERE platform = ?
        AND date IN (${placeholders})
    `
    )
    .all(platform, ...dates) as Array<{
      symbol: string;
      date: string;
      mention_count: number;
      avg_sentiment: number | null;
      total_upvotes: number;
      total_comments: number;
    }>;

  if (!rows.length) {
    return {
      platform,
      days,
      totalScanned: 0,
      spikesDetected: 0,
      spikes: [],
    };
  }

  const symbolMap = new Map<
    string,
    Map<
      string,
      {
        mention_count: number;
        avg_sentiment: number | null;
        total_upvotes: number;
        total_comments: number;
      }
    >
  >();

  for (const row of rows) {
    const sym = row.symbol.toUpperCase();
    if (!symbolMap.has(sym)) {
      symbolMap.set(sym, new Map());
    }
    symbolMap.get(sym)!.set(row.date, {
      mention_count: row.mention_count ?? 0,
      avg_sentiment: row.avg_sentiment ?? 0,
      total_upvotes: row.total_upvotes ?? 0,
      total_comments: row.total_comments ?? 0,
    });
  }

  const spikes: Array<{
    symbol: string;
    platform: string;
    spikeDetected: boolean;
    currentMentions: number;
    avgMentions: number;
    spikeRatio: number;
    sentiment: { score: number; label: string };
    trend: Array<{
      date: string;
      mention_count: number;
      avg_sentiment: number;
      total_upvotes: number;
      total_comments: number;
    }>;
  }> = [];

  for (const [symbol, dateMap] of symbolMap.entries()) {
    const trend = dates.map((date) => {
      const entry = dateMap.get(date);
      return {
        date,
        mention_count: entry?.mention_count ?? 0,
        avg_sentiment: entry?.avg_sentiment ?? 0,
        total_upvotes: entry?.total_upvotes ?? 0,
        total_comments: entry?.total_comments ?? 0,
      };
    });

    const currentMentions = trend[trend.length - 1]?.mention_count ?? 0;
    if (currentMentions < minMentions) continue;

    const pastMentions = trend.slice(0, -1).map((t) => t.mention_count);
    const avgMentions =
      pastMentions.length > 0
        ? pastMentions.reduce((a, b) => a + b, 0) / pastMentions.length
        : 0;

    const spikeRatio =
      avgMentions > 0 ? currentMentions / avgMentions : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(spikeRatio) && avgMentions === 0 && currentMentions < minMentions * 2) {
      // 평균이 0이고 현재 언급량이 낮으면 건너뜀
      continue;
    }

    if (spikeRatio < minSpikeRatio && Number.isFinite(spikeRatio)) continue;

    const recentSentiment = trend.slice(-3).map((t) => t.avg_sentiment);
    const avgSentiment =
      recentSentiment.length > 0
        ? recentSentiment.reduce((a, b) => a + b, 0) / recentSentiment.length
        : 0;

    let sentimentLabel = 'neutral';
    if (avgSentiment > 0.2) sentimentLabel = 'positive';
    else if (avgSentiment < -0.2) sentimentLabel = 'negative';

    spikes.push({
      symbol,
      platform,
      spikeDetected: true,
      currentMentions,
      avgMentions,
      spikeRatio,
      sentiment: { score: avgSentiment, label: sentimentLabel },
      trend,
    });
  }

  const sortedSpikes = spikes.sort((a, b) => {
    const ratioA = Number.isFinite(a.spikeRatio) ? a.spikeRatio : Number.MAX_SAFE_INTEGER;
    const ratioB = Number.isFinite(b.spikeRatio) ? b.spikeRatio : Number.MAX_SAFE_INTEGER;
    if (ratioB !== ratioA) return ratioB - ratioA;
    return b.currentMentions - a.currentMentions;
  });

  return {
    platform,
    days,
    totalScanned: symbolMap.size,
    spikesDetected: sortedSpikes.length,
    spikes: sortedSpikes.slice(0, 20), // 상위 20개 반환
  };
}

