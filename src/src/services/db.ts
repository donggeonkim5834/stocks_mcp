import type { Database } from 'better-sqlite3';

export function initDb(db: Database) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS ticker_snapshot (
      symbol TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_history (
      symbol TEXT NOT NULL,
      ts INTEGER NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      PRIMARY KEY(symbol, ts)
    );
    CREATE TABLE IF NOT EXISTS option_chain (
      symbol TEXT NOT NULL,
      expiry TEXT NOT NULL,
      type TEXT NOT NULL,
      strike REAL NOT NULL,
      last REAL, bid REAL, ask REAL, volume INTEGER, open_interest INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(symbol, expiry, type, strike)
    );
    CREATE TABLE IF NOT EXISTS news (
      symbol TEXT,
      id TEXT NOT NULL,
      title TEXT,
      url TEXT,
      source TEXT,
      published_at TEXT,
      PRIMARY KEY(id)
    );
    CREATE TABLE IF NOT EXISTS macro_indicators (
      key TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value REAL,
      source TEXT,
      PRIMARY KEY(key, ts)
    );
    CREATE TABLE IF NOT EXISTS sector_flow (
      date TEXT PRIMARY KEY,
      top_sectors_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS massive_price_history (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      adjusted_close REAL,
      PRIMARY KEY(symbol, date)
    );
    CREATE TABLE IF NOT EXISTS massive_reference_data (
      symbol TEXT PRIMARY KEY,
      isin TEXT, cusip TEXT, figi TEXT, cik TEXT,
      sector TEXT, industry TEXT, exchange TEXT,
      market_cap REAL, shares_outstanding INTEGER,
      data_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS corporate_actions (
      symbol TEXT NOT NULL,
      action_date TEXT NOT NULL,
      action_type TEXT NOT NULL,
      details_json TEXT,
      PRIMARY KEY(symbol, action_date, action_type)
    );
    CREATE TABLE IF NOT EXISTS technical_indicators (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      indicator_name TEXT NOT NULL,
      value REAL,
      PRIMARY KEY(symbol, date, indicator_name)
    );
    CREATE TABLE IF NOT EXISTS earnings_calendar (
      symbol TEXT NOT NULL,
      report_date TEXT NOT NULL,
      fiscal_period TEXT,
      eps_actual REAL, eps_estimate REAL, eps_surprise REAL,
      revenue_actual REAL, revenue_estimate REAL,
      conference_call_time TEXT,
      PRIMARY KEY(symbol, report_date)
    );
    CREATE TABLE IF NOT EXISTS analyst_consensus (
      symbol TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      rating_count INTEGER,
      rating_avg REAL,
      price_target REAL,
      consensus_json TEXT,
      PRIMARY KEY(symbol, updated_at)
    );
    CREATE TABLE IF NOT EXISTS edgar_filings (
      cik TEXT NOT NULL,
      accession_number TEXT NOT NULL,
      filing_date TEXT NOT NULL,
      form_type TEXT,
      company_name TEXT,
      document_url TEXT,
      summary_text TEXT,
      PRIMARY KEY(cik, accession_number)
    );
    CREATE TABLE IF NOT EXISTS ticker_mapping (
      symbol TEXT PRIMARY KEY,
      cik TEXT, isin TEXT, cusip TEXT, figi TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_calendar (
      date TEXT PRIMARY KEY,
      is_trading_day INTEGER,
      market_status TEXT,
      session_open TEXT,
      session_close TEXT
    );
    CREATE TABLE IF NOT EXISTS short_interest (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      short_interest REAL,
      short_ratio REAL,
      PRIMARY KEY(symbol, date)
    );
    CREATE TABLE IF NOT EXISTS massive_options (
      symbol TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      option_type TEXT NOT NULL,
      strike REAL NOT NULL,
      iv REAL, oi INTEGER, volume INTEGER,
      last_price REAL, bid REAL, ask REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(symbol, expiry_date, option_type, strike)
    );
    CREATE TABLE IF NOT EXISTS social_mentions (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      platform TEXT NOT NULL,
      post_id TEXT NOT NULL,
      author TEXT,
      title TEXT,
      content TEXT,
      url TEXT,
      upvotes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      sentiment_score REAL,
      sentiment_label TEXT,
      created_at INTEGER NOT NULL,
      collected_at INTEGER NOT NULL,
      UNIQUE(platform, post_id)
    );
    CREATE TABLE IF NOT EXISTS mention_trends (
      symbol TEXT NOT NULL,
      platform TEXT NOT NULL,
      date TEXT NOT NULL,
      mention_count INTEGER DEFAULT 0,
      avg_sentiment REAL,
      total_upvotes INTEGER DEFAULT 0,
      total_comments INTEGER DEFAULT 0,
      PRIMARY KEY(symbol, platform, date)
    );
    CREATE INDEX IF NOT EXISTS idx_social_mentions_symbol ON social_mentions(symbol, created_at);
    CREATE INDEX IF NOT EXISTS idx_social_mentions_platform ON social_mentions(platform, created_at);
    CREATE INDEX IF NOT EXISTS idx_mention_trends_symbol ON mention_trends(symbol, date);
  `);
}


