import type { Database } from 'better-sqlite3';
import {
  SMA, EMA, MACD, RSI, BollingerBands, Stochastic, OBV, ADX, ATR, IchimokuCloud, VWAP, CCI, PSAR, WilliamsR, MFI, ROC, TRIX, ADL
} from 'technicalindicators';

// Helper to structure input for the library
const toInput = (data: any[]) => {
  const input = {
    open: data.map(d => d.open),
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: data.map(d => d.close),
    volume: data.map(d => d.volume),
    timestamp: data.map(d => d.ts),
  };
  return input;
};

export function calculateAllIndicators(symbol: string, db: Database) {
  const rows = db.prepare(`
    SELECT ts, open, high, low, close, volume 
    FROM price_history 
    WHERE symbol = ? 
    ORDER BY ts ASC
  `).all(symbol) as any[];

  if (rows.length < 52) { // Ichimoku and other indicators need a longer period
    return { error: 'Not enough historical data to calculate indicators. Minimum 52 data points required.' };
  }

  const input = toInput(rows);

  // Calculate all verified indicators
  const sma = SMA.calculate({ period: 20, values: input.close });
  const ema = EMA.calculate({ period: 20, values: input.close });
  const macd = MACD.calculate({
    values: input.close,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const rsi = RSI.calculate({ period: 14, values: input.close });
  const bollingerbands = BollingerBands.calculate({ period: 20, stdDev: 2, values: input.close });
  const stochastic = Stochastic.calculate({
    period: 14,
    signalPeriod: 3,
    ...input
  });
  const obv = OBV.calculate(input);
  const adx = ADX.calculate({
    period: 14,
    ...input
  });
  const atr = ATR.calculate({
    period: 14,
    ...input
  });
  const ichimoku = IchimokuCloud.calculate({
    conversionPeriod: 9,
    basePeriod: 26,
    spanPeriod: 52,
    displacement: 26,
    ...input
  });
  const psar = PSAR.calculate({ step: 0.02, max: 0.2, ...input });
  const vwap = VWAP.calculate(input);
  const cci = CCI.calculate({ period: 20, ...input });
  const mfi = MFI.calculate({ period: 14, ...input });
  const williamsr = WilliamsR.calculate({ period: 14, ...input });
  const roc = ROC.calculate({ period: 12, values: input.close });
  const trix = TRIX.calculate({ period: 18, values: input.close });
  const adl = ADL.calculate(input);

  return {
    SMA: sma.slice(-5),
    EMA: ema.slice(-5),
    MACD: macd.slice(-5),
    RSI: rsi.slice(-5),
    BollingerBands: bollingerbands.slice(-5),
    Stochastic: stochastic.slice(-5),
    OBV: obv.slice(-5),
    ADX: adx.slice(-5),
    ATR: atr.slice(-5),
    IchimokuCloud: ichimoku.slice(-5),
    PSAR: psar.slice(-5),
    VWAP: vwap.slice(-5),
    CCI: cci.slice(-5),
    MFI: mfi.slice(-5),
    WilliamsR: williamsr.slice(-5),
    ROC: roc.slice(-5),
    TRIX: trix.slice(-5),
    ADL: adl.slice(-5),
  };
}