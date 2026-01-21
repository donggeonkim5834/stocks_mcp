import type { Database } from 'better-sqlite3';
import axios from 'axios';

const EDGAR_BASE = 'https://data.sec.gov';

function getEdgarHeaders() {
  const userAgent = process.env.EDGAR_USER_AGENT || 'stocks-mcp-server contact@example.com';
  // SEC는 User-Agent에 실제 회사명과 이메일을 요구합니다
  if (!userAgent.includes('@')) {
    console.warn('[EDGAR] Warning: EDGAR_USER_AGENT should include email address (e.g., "CompanyName contact@example.com")');
  }
  return {
    'User-Agent': userAgent,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  };
}

export async function getCompanyByCIK(cik: string) {
  const padded = cik.padStart(10, '0');
  const { data } = await axios.get(
    `${EDGAR_BASE}/cgi-bin/browse-edgar?CIK=${padded}&owner=exclude&action=getcompany&type=&dateb=&count=100`,
    { headers: getEdgarHeaders() }
  );
  return data;
}

let cachedTickerMap: Map<string, string> | null = null;
async function ensureTickerMap(): Promise<Map<string, string>> {
  if (cachedTickerMap) return cachedTickerMap;
  cachedTickerMap = new Map();
  try {
    // SEC company_tickers.json은 객체 형태로 반환 (키는 인덱스, 값은 {ticker, cik_str, title})
    // URL 확인: https://www.sec.gov/files/company_tickers.json (HTTPS 사용 필수)
    const { data } = await axios.get(`https://www.sec.gov/files/company_tickers.json`, { 
      headers: getEdgarHeaders(),
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500 // 403도 일단 시도
    });
    
    if (data && typeof data === 'object') {
      // SEC API는 객체로 반환: { "0": {ticker: "AAPL", cik_str: "320193", ...}, "1": {...}, ... }
      for (const key of Object.keys(data)) {
        const item = (data as any)[key];
        if (!item) continue;
        
        const ticker = String(item?.ticker ?? '').trim().toUpperCase();
        const cik = String(item?.cik_str ?? item?.cik ?? '').trim();
        
        if (ticker && cik) {
          // CIK를 10자리로 패딩 (앞에 0 추가)
          const paddedCik = cik.padStart(10, '0');
          cachedTickerMap.set(ticker, paddedCik);
        }
      }
    }
  } catch (err: any) {
    const errorMsg = err?.response?.status === 403 
      ? '403 Forbidden - User-Agent 헤더가 올바르지 않거나 SEC 정책 위반. EDGAR_USER_AGENT 환경변수를 확인하세요.'
      : err?.message ?? String(err);
    console.warn('[EDGAR] failed to load company_tickers.json:', errorMsg);
    
    // 403 에러인 경우 대체 방법 시도: 직접 submissions API 사용
    if (err?.response?.status === 403) {
      console.warn('[EDGAR] SEC API 접근이 제한되었습니다. Massive.com을 통해 CIK를 먼저 수집하세요.');
    }
  }
  return cachedTickerMap;
}

export async function getCIKFromTicker(symbol: string, db?: Database): Promise<string | null> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return null;

  // 1순위: DB의 ticker_mapping 테이블에서 조회
  if (db) {
    try {
      const row = db
        .prepare(`SELECT cik FROM ticker_mapping WHERE symbol=? AND cik IS NOT NULL AND cik != '' LIMIT 1`)
        .get(sym) as { cik?: string } | undefined;
      if (row?.cik) {
        const cik = String(row.cik).trim().padStart(10, '0');
        if (cik && cik !== '0000000000') return cik;
      }
    } catch (err: any) {
      console.warn('[EDGAR] DB lookup failed:', err?.message);
    }
  }

  // 2순위: DB의 massive_reference_data에서 조회 (Massive.com에서 가져온 데이터)
  if (db) {
    try {
      const row = db
        .prepare(`SELECT cik FROM massive_reference_data WHERE symbol=? AND cik IS NOT NULL AND cik != '' LIMIT 1`)
        .get(sym) as { cik?: string } | undefined;
      if (row?.cik) {
        const cik = String(row.cik).trim().padStart(10, '0');
        if (cik && cik !== '0000000000') {
          // DB에 저장 (나중을 위해)
          try {
            db.prepare(`REPLACE INTO ticker_mapping(symbol, cik, updated_at) VALUES(?, ?, datetime('now'))`).run(sym, cik);
          } catch {}
          return cik;
        }
      }
    } catch (err: any) {
      console.warn('[EDGAR] massive_reference_data lookup failed:', err?.message);
    }
  }

  // 3순위: SEC API에서 조회
  try {
    const map = await ensureTickerMap();
    const cik = map.get(sym);
    if (cik && cik !== '0000000000') {
      // DB에 저장 (나중을 위해)
      if (db) {
        try {
          db.prepare(`REPLACE INTO ticker_mapping(symbol, cik, updated_at) VALUES(?, ?, datetime('now'))`).run(sym, cik);
        } catch {}
      }
      return cik;
    }
  } catch (err: any) {
    console.warn('[EDGAR] SEC API lookup failed:', err?.message);
  }

  return null;
}

export async function fetchCompanyFilings(
  cik: string,
  formType?: string,
  startDate?: string,
  count: number = 100
) {
  const padded = cik.padStart(10, '0');
  const params: Record<string, string> = {
    owner: 'exclude',
    action: 'getcompany',
    type: formType ?? '',
    count: String(count),
  };
  if (startDate) params.dateb = startDate;

  const { data } = await axios.get(`${EDGAR_BASE}/cgi-bin/browse-edgar`, {
    params,
    headers: getEdgarHeaders(),
  });
  return data;
}

export async function fetchFilingContent(accessionNumber: string, cik: string) {
  const padded = cik.padStart(10, '0');
  const docId = accessionNumber.replace(/-/g, '');
  const url = `${EDGAR_BASE}/files/data/${padded}/${docId}/${accessionNumber}-index.json`;
  try {
    const { data } = await axios.get(url, { headers: getEdgarHeaders() });
    return data;
  } catch {
    return null;
  }
}

export async function fetchEdgarFilingsForSymbol(
  symbol: string,
  formTypes: string[] = ['10-K', '10-Q', '8-K', 'DEF 14A'],
  db?: Database
) {
  const cik = await getCIKFromTicker(symbol, db);
  if (!cik) {
    // CIK를 찾지 못했을 때 상세한 디버깅 정보 제공
    const sym = symbol.trim().toUpperCase();
    let debugInfo = `Symbol: ${sym}\n`;
    
    if (db) {
      try {
        const tickerMapping = db.prepare(`SELECT * FROM ticker_mapping WHERE symbol=?`).get(sym);
        const massiveRef = db.prepare(`SELECT cik FROM massive_reference_data WHERE symbol=?`).get(sym);
        debugInfo += `DB ticker_mapping: ${tickerMapping ? JSON.stringify(tickerMapping) : 'not found'}\n`;
        debugInfo += `DB massive_reference_data: ${massiveRef ? JSON.stringify(massiveRef) : 'not found'}\n`;
      } catch {}
    }
    
    return { 
      count: 0, 
      error: `CIK not found for symbol ${sym}. Try fetching reference data from Massive.com first using get_massive_stock_data(${sym}).`,
      debug: debugInfo
    };
  }

  const filings: any[] = [];

  for (const formType of formTypes) {
    try {
      const data = await fetchCompanyFilings(cik, formType);
      filings.push({ raw: data, formType });
    } catch (err) {
      console.warn('[EDGAR] browse filings failed', formType, (err as any)?.message ?? err);
    }
  }

  let companyName = '';
  const paddedCik = cik.padStart(10, '0');
  try {
    const { data } = await axios.get(`${EDGAR_BASE}/submissions/CIK${paddedCik}.json`, {
      headers: getEdgarHeaders(),
      timeout: 10000
    });
    companyName = data?.name || '';
    if (data?.filings?.recent) {
      const recent = data.filings.recent;
      const dates = recent.filingDate || [];
      const forms = recent.form || [];
      const accessions = recent.accessionNumber || [];
      const descriptions = recent.description || [];
      for (let i = 0; i < dates.length; i++) {
        if (!formTypes.length || formTypes.includes(forms[i])) {
          filings.push({
            cik: paddedCik,
            accessionNumber: accessions[i],
            filingDate: dates[i],
            formType: forms[i],
            description: descriptions[i] || '',
            companyName,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[EDGAR] submissions API failed', (err as any)?.message ?? err);
  }

  if (db && filings.length) {
    const insert = db.prepare(`
      REPLACE INTO edgar_filings(
        cik, accession_number, filing_date, form_type, company_name, document_url, summary_text
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((rows: any[]) => {
      for (const f of rows) {
        const accession = f.accessionNumber || '';
        const url = accession
          ? `${EDGAR_BASE}/cgi-bin/viewer?action=view&cik=${paddedCik}&accession_number=${accession}&xbrl_type=v`
          : null;
        insert.run(
          paddedCik,
          accession,
          f.filingDate || null,
          f.formType || null,
          f.companyName || companyName,
          url,
          f.description || ''
        );
      }
    });
    tx(
      filings.filter((f) => f.accessionNumber)
    );
  }

  const validFilings = filings.filter((f) => f.accessionNumber);
  return { 
    count: validFilings.length, 
    cik: paddedCik,
    companyName: companyName || 'Unknown',
    filings: validFilings.map(f => ({
      formType: f.formType,
      filingDate: f.filingDate,
      description: f.description,
      accessionNumber: f.accessionNumber
    }))
  };
}
