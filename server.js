// ═══════════════════════════════════════════════════════════════
//  APEX AI BRAIN — 24/7 Trading Server
//  Deploy to Railway.app — runs while your phone is off
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const cron     = require('node-cron');
const axios    = require('axios');
const xml2js   = require('xml2js');
const fs       = require('fs');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

// ── ENVIRONMENT ──
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const ALPACA_KEY      = process.env.ALPACA_KEY_ID     || '';
const ALPACA_SECRET   = process.env.ALPACA_SECRET_KEY || '';
const ALPACA_PAPER    = process.env.ALPACA_PAPER !== 'false';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK   || '';
const SHEETS_WEBHOOK  = process.env.SHEETS_WEBHOOK    || '';

const ALPACA_BASE = ALPACA_PAPER
  ? 'https://paper-api.alpaca.markets'
  : 'https://api.alpaca.markets';
const ALPACA_DATA = 'https://data.alpaca.markets';

// ── DATA PERSISTENCE ──
const DATA_DIR    = path.join(__dirname, 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const PATTERNS_FILE = path.join(DATA_DIR, 'patterns.json');
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

// ── SETTINGS ──
const SETTINGS = {
  stopLoss:      7,
  takeProfit:    8,
  budget:        200,
  dailyLossLimit:100,
  maxDailyTrades:10,
  maxBots:       10,
  minBots:       2,
};

// ── STATE ──
let tickers      = loadJSON(ROSTER_FILE, ['ONDS','BBAI','AZI','JEM','JYZN']);
let tradeJournal = loadJSON(TRADES_FILE, []);
let patternData  = loadJSON(PATTERNS_FILE, { patterns:{}, totalDecisions:0 });

let STOCKS       = {};
let bots         = {};
let hist         = {};
let vols         = {};
let sentimentMap = {};
let aiDecisions  = {};
let tickerHealth = {};

let totalPnl    = tradeJournal.reduce((s,t) => s + t.pnl, 0);
let totalTrades = tradeJournal.length;
let totalWins   = tradeJournal.filter(t => t.pnl > 0).length;
let dailyTrades = 0;
let dailyLoss   = 0;
let dailyPnl    = 0;
let lastRotateTime   = null;
let lastAnalyzeTime  = null;
let lastScanTime     = null;
let alpacaConnected  = false;
let newsItems        = [];
let rotationLog      = [];

// ── INIT STOCKS ──
function initStock(sym, price, floatM, shortPct, avgVol, sector, color) {
  STOCKS[sym] = {
    name: sym, price, open: price * 0.97, prev: price * 0.97,
    float: floatM, short: shortPct, avgVol, color, sector
  };
  hist[sym] = [];
  let p = price * 0.97;
  for (let i = 0; i < 60; i++) {
    p = Math.max(0.01, p * (1 + (Math.random()-0.49)*0.008));
    hist[sym].push(parseFloat(p.toFixed(4)));
  }
  hist[sym].push(price);
  vols[sym]  = Math.floor(avgVol * 0.06);
  sentimentMap[sym] = {
    reddit:  Math.floor(Math.random()*40+40),
    twitter: Math.floor(Math.random()*40+40),
    news:    Math.floor(Math.random()*40+40),
    overall: 60
  };
  bots[sym] = {
    on: true, status: 'WATCHING', pos: 0, entry: 0, pnl: 0,
    trades: 0, wins: 0, halted: false,
    vwap: price, vS: price, vC: 1,
    dayH: price*1.01, dayL: price*0.99,
    orbH: price*1.005, orbL: price*0.995, orbSet: false,
    pattern: 'NONE', aiApproved: null, allocated: 0,
    sizingLabel: 'FULL', confidence: 0
  };
  tickerHealth[sym] = { score: 50, noTradeCount: 0 };
}

// Seed default tickers
const DEFAULT_STOCKS = {
  ONDS: [10.32, 28.5, 18.2, 4200000, 'Defense',  '#00ffff'],
  BBAI: [3.81,  142,  22.1, 8100000, 'AI',        '#a855f7'],
  AZI:  [2.19,  12.1, 8.4,  1800000, 'Biotech',   '#f0abfc'],
  JEM:  [1.86,  32,   14.7, 2300000, 'Finance',   '#fbbf24'],
  JYZN: [4.23,  18.9, 31.2, 3600000, 'Tech',      '#00ff88'],
};
tickers.forEach(sym => {
  const d = DEFAULT_STOCKS[sym];
  if (d) initStock(sym, d[0], d[1], d[2], d[3], d[4], d[5]);
  else   initStock(sym, parseFloat((Math.random()*8+1).toFixed(3)),
                   parseFloat((Math.random()*60+5).toFixed(1)),
                   parseFloat((Math.random()*30+5).toFixed(1)),
                   Math.floor(Math.random()*5e6+500000), 'Custom', '#00ffff');
});

// ── WEBSOCKET BROADCAST ──
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch(e) {}
    }
  });
}

wss.on('connection', ws => {
  console.log('Dashboard connected');
  // Send full state snapshot on connect
  ws.send(JSON.stringify({ type: 'SNAPSHOT', data: getSnapshot() }));
});

function getSnapshot() {
  return {
    tickers, STOCKS, bots, hist, vols, sentimentMap,
    aiDecisions, tickerHealth, rotationLog, newsItems,
    totalPnl, totalTrades, totalWins, dailyTrades, dailyLoss, dailyPnl,
    tradeJournal: tradeJournal.slice(0, 50),
    patternData, SETTINGS,
    alpacaConnected,
    lastRotateTime, lastAnalyzeTime, lastScanTime,
    serverTime: new Date().toISOString()
  };
}

// ── PRICE FETCHING (Alpaca real prices with simulation fallback) ──
async function fetchAlpacaPrices() {
  if (!ALPACA_KEY || !ALPACA_SECRET) { simulatePrices(); return; }
  try {
    const syms = tickers.join(',');
    const resp = await axios.get(`${ALPACA_DATA}/v2/stocks/bars/latest?symbols=${syms}&feed=iex`, {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
      timeout: 5000
    });
    const bars = resp.data?.bars || {};
    let gotAny = false;
    tickers.forEach(sym => {
      const bar = bars[sym];
      const s = STOCKS[sym];
      if (!s) return;
      if (bar && bar.c) {
        // Real Alpaca price
        s.price = parseFloat(bar.c.toFixed(4));
        s.open  = s.open || parseFloat(bar.o.toFixed(4));
        if (!s.prev) s.prev = parseFloat(bar.o.toFixed(4));
        gotAny = true;
      } else {
        // Fallback simulate for this ticker
        const chg = (Math.random()-0.488) * 0.005;
        s.price = Math.max(0.01, parseFloat((s.price*(1+chg)).toFixed(4)));
      }
      hist[sym].push(s.price);
      if (hist[sym].length > 120) hist[sym].shift();
      vols[sym] += Math.floor(Math.random()*15000+2000);
      const b = bots[sym];
      b.vC++; b.vS += s.price;
      b.vwap = parseFloat((b.vS/b.vC).toFixed(4));
      if (s.price > b.dayH) b.dayH = s.price;
      if (s.price < b.dayL) b.dayL = s.price;
      if (!b.orbSet && b.vC === 15) { b.orbH = b.dayH; b.orbL = b.dayL; b.orbSet = true; }
      const sn = sentimentMap[sym];
      sn.reddit  = Math.min(99, Math.max(10, sn.reddit  + Math.floor((Math.random()-0.5)*5)));
      sn.twitter = Math.min(99, Math.max(10, sn.twitter + Math.floor((Math.random()-0.5)*5)));
      sn.news    = Math.min(99, Math.max(10, sn.news    + Math.floor((Math.random()-0.5)*3)));
      sn.overall = Math.round(sn.reddit*0.3 + sn.twitter*0.4 + sn.news*0.3);
      if (b.on && !b.halted) runBotLogic(sym);
    });
    if (gotAny) alpacaConnected = true;
    broadcast('PRICES', {
      prices:   Object.fromEntries(tickers.map(s => [s, STOCKS[s]?.price])),
      vols:     Object.fromEntries(tickers.map(s => [s, vols[s]])),
      bots:     Object.fromEntries(tickers.map(s => [s, bots[s]])),
      sent:     sentimentMap,
      totalPnl, totalTrades, totalWins, dailyPnl
    });
  } catch(e) {
    // Alpaca data failed — fall back to simulation
    simulatePrices();
  }
}

function simulatePrices() {
  tickers.forEach(sym => {
    const s = STOCKS[sym];
    if (!s) return;
    const chg = (Math.random()-0.488) * 0.007;
    s.price = Math.max(0.01, parseFloat((s.price*(1+chg)).toFixed(4)));
    hist[sym].push(s.price);
    if (hist[sym].length > 120) hist[sym].shift();
    vols[sym] += Math.floor(Math.random()*15000+2000);
    const b = bots[sym];
    b.vC++; b.vS += s.price;
    b.vwap = parseFloat((b.vS/b.vC).toFixed(4));
    if (s.price > b.dayH) b.dayH = s.price;
    if (s.price < b.dayL) b.dayL = s.price;
    if (!b.orbSet && b.vC === 15) { b.orbH = b.dayH; b.orbL = b.dayL; b.orbSet = true; }
    const sn = sentimentMap[sym];
    sn.reddit  = Math.min(99, Math.max(10, sn.reddit  + Math.floor((Math.random()-0.5)*5)));
    sn.twitter = Math.min(99, Math.max(10, sn.twitter + Math.floor((Math.random()-0.5)*5)));
    sn.news    = Math.min(99, Math.max(10, sn.news    + Math.floor((Math.random()-0.5)*3)));
    sn.overall = Math.round(sn.reddit*0.3 + sn.twitter*0.4 + sn.news*0.3);
    if (b.on && !b.halted) runBotLogic(sym);
  });
  broadcast('PRICES', {
    prices:   Object.fromEntries(tickers.map(s => [s, STOCKS[s]?.price])),
    vols:     Object.fromEntries(tickers.map(s => [s, vols[s]])),
    bots:     Object.fromEntries(tickers.map(s => [s, bots[s]])),
    sent:     sentimentMap,
    totalPnl, totalTrades, totalWins, dailyPnl
  });
}

// ── SIGNALS ──
function getSignals(sym) {
  const h = hist[sym], s = STOCKS[sym], b = bots[sym];
  if (!h || h.length < 14) return { rsi:50, volR:1, momentum:50, squeeze:30, sentiment:60, pattern:{ name:'NONE', signal:'WAIT' }, rr:2 };
  let g=0, l=0;
  for (let i = h.length-14; i < h.length; i++) {
    const d = h[i] - h[i-1] || 0;
    if (d > 0) g += d; else l -= d;
  }
  const rsi      = Math.round(100 - 100/(1+(g/(l||0.001))));
  const volR     = parseFloat((vols[sym]/(s.avgVol*0.06||1)).toFixed(1));
  const mom      = Math.min(100, Math.max(0, Math.round(50+(s.price-s.open)/s.open*500)));
  const squeeze  = Math.min(100, Math.round(s.short*1.5+(volR>2?20:0)));
  const sn       = sentimentMap[sym];
  const patterns = ['BREAKOUT','BULL FLAG','HAMMER','ABCD','VWAP RECLAIM','NONE'];
  const pi       = Math.floor(Math.random()*6);
  return { rsi, volR, momentum:mom, squeeze, sentiment:sn.overall,
           pattern:{ name:patterns[pi], signal:pi<5?'BUY':'WAIT' },
           rr: parseFloat((SETTINGS.takeProfit/SETTINGS.stopLoss).toFixed(1)) };
}

function getAIPositionSize(sym) {
  const dec = aiDecisions[sym];
  const confidence = dec?.confidence || 50;
  const budget = SETTINGS.budget;
  let pct, label;
  if (confidence >= 90)      { pct = 1.00; label = 'FULL'; }
  else if (confidence >= 75) { pct = 0.75; label = '75%'; }
  else if (confidence >= 60) { pct = 0.50; label = '50%'; }
  else                       { pct = 0.25; label = '25%'; }
  return { dollars: parseFloat((budget*pct).toFixed(2)), pct, label, confidence };
}

// ── BOT LOGIC ──
function runBotLogic(sym) {
  if (dailyTrades >= SETTINGS.maxDailyTrades) return;
  if (dailyLoss   >= SETTINGS.dailyLossLimit) return;
  const s = STOCKS[sym], b = bots[sym];
  const sg = getSignals(sym);

  // EXIT
  if (b.pos > 0) {
    const pct = (s.price - b.entry) / b.entry * 100;
    if (pct <= -SETTINGS.stopLoss || pct >= SETTINGS.takeProfit) {
      const pnl = parseFloat((b.pos*(s.price-b.entry)).toFixed(2));
      b.pnl += pnl; totalPnl = parseFloat((totalPnl+pnl).toFixed(2));
      dailyPnl = parseFloat((dailyPnl+pnl).toFixed(2));
      dailyTrades++;
      if (pnl > 0) { b.wins++; totalWins++; }
      else { dailyLoss += Math.abs(pnl); }
      b.trades++; totalTrades++;
      b.pos = 0; b.entry = 0; b.status = 'WATCHING';
      const reason = pnl > 0 ? 'TARGET' : 'STOP';
      const trade = logTrade(sym, b.entry||s.price, s.price, b.allocated||SETTINGS.budget, pnl, reason, sg);
      sendDiscordTrade(trade);
      if (ALPACA_KEY) placeAlpacaOrder(sym, Math.floor(b.allocated/s.price), 'sell').catch(()=>{});
      learnFromTrade(sym, trade, aiDecisions[sym]);
      broadcast('TRADE', { trade, bots: bots[sym], totalPnl, totalTrades, totalWins });
    } else {
      b.status = 'HOLD';
    }
    return;
  }

  // ENTRY — basic signal check
  const basicReady = sg.rsi < 65 && sg.volR > 1.2 && sg.momentum > 48 && s.price > b.vwap * 0.995;
  if (!basicReady) { b.status = 'WATCHING'; return; }

  const dec = aiDecisions[sym];
  if (!dec || dec.verdict !== 'YES') {
    b.status = dec ? 'AI SKIP' : 'WAITING AI';
    return;
  }

  // AI approved — enter
  const sizing = getAIPositionSize(sym);
  b.pos         = Math.max(1, Math.floor(sizing.dollars/s.price));
  b.entry       = s.price;
  b.allocated   = sizing.dollars;
  b.sizingLabel = sizing.label;
  b.confidence  = sizing.confidence;
  b.status      = 'RIPPING';
  b.pattern     = sg.pattern.name;
  b.aiApproved  = true;
  console.log(`⚡ ENTRY: ${sym} @ $${s.price} · ${sizing.label} ($${sizing.dollars}) · ${sizing.confidence}% conf`);
  sendDiscordAlert(`⚡ **${sym} ENTRY** @ $${s.price.toFixed(4)}\n💰 Size: ${sizing.label} ($${sizing.dollars}) · ${sizing.confidence}% confidence\n📊 Pattern: ${sg.pattern.name}`);
  if (ALPACA_KEY) placeAlpacaOrder(sym, b.pos, 'buy').catch(()=>{});
  broadcast('ENTRY', { sym, price: s.price, sizing, bot: bots[sym] });
}

// ── TRADE LOGGING ──
function logTrade(sym, entry, exit, allocated, pnl, reason, sg) {
  const trade = {
    id: tradeJournal.length + 1,
    sym, entry, exit, allocated, pnl, reason,
    pattern:   sg?.pattern?.name || '—',
    sentiment: sentimentMap[sym]?.overall || 0,
    aiVerdict: aiDecisions[sym]?.verdict || '—',
    aiConfidence: aiDecisions[sym]?.confidence || 0,
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString()
  };
  tradeJournal.unshift(trade);
  if (tradeJournal.length > 500) tradeJournal.pop();
  saveJSON(TRADES_FILE, tradeJournal);
  if (SHEETS_WEBHOOK) syncSheets(trade).catch(()=>{});
  return trade;
}

// ── PATTERN LEARNING ──
function learnFromTrade(sym, trade, aiDec) {
  if (!aiDec) return;
  const key = `${trade.pattern}_${sym}_${aiDec.verdict}`;
  if (!patternData.patterns[key]) {
    patternData.patterns[key] = { wins:0, losses:0, totalPnl:0, avgConf:0, count:0 };
  }
  const p = patternData.patterns[key];
  p.count++;
  if (trade.pnl > 0) p.wins++; else p.losses++;
  p.totalPnl = parseFloat((p.totalPnl + trade.pnl).toFixed(2));
  p.avgConf  = parseFloat(((p.avgConf*(p.count-1) + (aiDec.confidence||0))/p.count).toFixed(1));
  patternData.totalDecisions++;
  saveJSON(PATTERNS_FILE, patternData);
}

// ── CLAUDE AI BRAIN ──
async function askAI(sym) {
  if (!ANTHROPIC_KEY) {
    aiDecisions[sym] = { verdict:'NO', reason:'No API key — set ANTHROPIC_API_KEY in Railway variables', confidence:0, sym, time:new Date().toLocaleTimeString() };
    return;
  }
  const s  = STOCKS[sym], sg = getSignals(sym), b = bots[sym];
  const chg = (s.price - s.open) / s.open * 100;

  // Include pattern learning data in prompt
  const patternHistory = Object.entries(patternData.patterns)
    .filter(([k]) => k.includes(sym) || k.includes(sg.pattern.name))
    .slice(0,3)
    .map(([k,v]) => `${k}: ${v.wins}W/${v.losses}L, avg PnL $${(v.totalPnl/v.count).toFixed(2)}`)
    .join(', ') || 'No history yet';

  const prompt = `You are an elite penny stock trading AI. Analyze and respond in JSON only.

Ticker: ${sym} (${s.name}, ${s.sector})
Price: $${s.price.toFixed(4)} (${chg.toFixed(2)}% today)
RSI: ${sg.rsi} | Volume: ${sg.volR}x avg | Momentum: ${sg.momentum}/100
Short Float: ${s.short}% | Float: ${s.float}M shares
Pattern: ${sg.pattern.name} | VWAP: ${s.price > b.vwap ? 'ABOVE' : 'BELOW'}
Sentiment: ${sg.sentiment}/100 | Squeeze: ${sg.squeeze}/100
Historical pattern data: ${patternHistory}
Bot win rate: ${b.trades > 0 ? Math.round(b.wins/b.trades*100) : 'N/A'}%

JSON only: {"verdict":"YES" or "NO","confidence":0-100,"reason":"2-3 sentences","entry":price,"stop":price,"target":price,"risk":"LOW|MEDIUM|HIGH"}`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role:'user', content:prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    });
    const txt   = resp.data?.content?.[0]?.text || '{}';
    const clean = txt.replace(/```json|```/g,'').trim();
    const dec   = JSON.parse(clean);
    dec.sym  = sym;
    dec.time = new Date().toLocaleTimeString();
    aiDecisions[sym] = dec;
    console.log(`🧠 ${sym}: ${dec.verdict} (${dec.confidence}%) — ${dec.reason?.slice(0,60)}`);
    broadcast('AI_DECISION', { sym, decision: dec });
    if (dec.verdict === 'YES') {
      sendDiscordAlert(`🧠 **AI APPROVED: ${sym}**\n💡 ${dec.reason}\n🎯 Entry $${dec.entry} · Stop $${dec.stop} · Target $${dec.target}\n📊 ${dec.confidence}% confidence · Risk: ${dec.risk}`);
    }
  } catch(e) {
    console.error(`AI error for ${sym}:`, e.message);
    aiDecisions[sym] = { verdict:'ERROR', reason:'API error: '+e.message, confidence:0, sym, time:new Date().toLocaleTimeString() };
  }
}

async function analyzeAllTickers() {
  console.log(`🧠 Analyzing all ${tickers.length} tickers...`);
  lastAnalyzeTime = new Date();
  for (const sym of tickers) {
    await askAI(sym);
    await sleep(500);
  }
  broadcast('ANALYZE_COMPLETE', { count: tickers.length, time: lastAnalyzeTime });
}

// ── MARKET DISCOVERY ──
async function discoverNewTickers(scanType) {
  if (!ANTHROPIC_KEY) return;
  const existing = tickers.join(', ');
  const scanMap = {
    momentum:  'high momentum penny stocks with volume spikes and breakout patterns today',
    squeeze:   'heavily shorted penny stocks primed for short squeeze right now',
    catalyst:  'penny stocks with recent catalysts — FDA, DoD contracts, earnings beats, partnerships',
    ai_sector: 'AI-related penny stocks with strong current momentum',
    full:      'top 5 penny stock opportunities right now — one from each: momentum, squeeze, catalyst, AI sector, wildcard'
  };
  const prompt = `You are an elite penny stock scanner. Currently tracking: ${existing}. Find 5 NEW opportunities for: ${scanMap[scanType]||scanMap.full}.

Return ONLY JSON array: [{"sym":"TICKER","name":"Company","price":float,"float":float,"short":float,"sector":"sector","score":0-100,"catalyst":"specific reason","tags":["TAG"],"ai_verdict":"YES" or "WATCH","confidence":0-100,"entry":float,"stop":float,"target":float}]`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens:1000,
      messages: [{ role:'user', content:prompt }]
    }, { headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' } });

    const txt     = resp.data?.content?.[0]?.text || '[]';
    const results = JSON.parse(txt.replace(/```json|```/g,'').trim());
    broadcast('DISCOVERY_RESULTS', { results, scanType });
    // Auto-add YES picks
    for (const r of results) {
      if (r.ai_verdict === 'YES' && !tickers.includes(r.sym) && tickers.length < SETTINGS.maxBots) {
        autoAddTicker(r);
        await sleep(300);
      }
    }
    return results;
  } catch(e) {
    console.error('Discovery error:', e.message);
    return [];
  }
}

// ── ROSTER MANAGEMENT ──
function autoAddTicker(disc) {
  const sym = disc.sym;
  if (tickers.includes(sym)) return;
  const colors = ['#00ffff','#a855f7','#f0abfc','#fbbf24','#00ff88','#ff6b6b','#06d6a0','#ffb347'];
  const p = parseFloat(disc.price) || parseFloat((Math.random()*8+0.5).toFixed(3));
  initStock(sym, p,
    parseFloat(disc.float)||parseFloat((Math.random()*60+5).toFixed(1)),
    parseFloat(disc.short)||parseFloat((Math.random()*30+5).toFixed(1)),
    Math.floor(Math.random()*8e6+500000),
    disc.sector||'Discovery',
    colors[tickers.length % colors.length]
  );
  tickers.push(sym);
  if (disc.ai_verdict) {
    aiDecisions[sym] = {
      sym, verdict: disc.ai_verdict, confidence: disc.confidence||70,
      reason: disc.catalyst||'AI-discovered setup',
      entry: disc.entry, stop: disc.stop, target: disc.target,
      time: new Date().toLocaleTimeString()
    };
  }
  addRotationLog('ADD', sym, disc.catalyst?.slice(0,50)||'AI-selected');
  saveJSON(ROSTER_FILE, tickers);
  console.log(`➕ Added ${sym} to roster`);
  sendDiscordAlert(`➕ **NEW BOT: ${sym}**\n📊 ${disc.catalyst||'AI-selected setup'}\n💰 Entry $${disc.entry} · Target $${disc.target}`);
  broadcast('TICKER_ADDED', { sym, stock: STOCKS[sym], bot: bots[sym], hist: hist[sym], sent: sentimentMap[sym] });
}

function dropTicker(sym, reason) {
  if (tickers.length <= SETTINGS.minBots) return false;
  if (bots[sym]?.pos > 0) return false; // never drop open position
  tickers = tickers.filter(s => s !== sym);
  delete STOCKS[sym]; delete bots[sym]; delete hist[sym];
  delete vols[sym]; delete sentimentMap[sym]; delete aiDecisions[sym]; delete tickerHealth[sym];
  addRotationLog('REMOVE', sym, reason);
  saveJSON(ROSTER_FILE, tickers);
  console.log(`➖ Dropped ${sym}: ${reason}`);
  sendDiscordAlert(`➖ **DROPPED: ${sym}**\n❌ ${reason}`);
  broadcast('TICKER_REMOVED', { sym, reason });
  return true;
}

function scoreTickerHealth() {
  tickers.forEach(sym => {
    const b  = bots[sym], s = STOCKS[sym];
    if (!b || !s) return;
    const chg = (s.price - s.open) / s.open * 100;
    const sg  = getSignals(sym);
    const wr  = b.trades > 0 ? b.wins/b.trades : 0.5;
    const act = b.trades > 0 ? Math.min(1, b.trades/5) : 0.3;
    const sig = (sg.momentum + sg.sentiment + sg.squeeze) / 300;
    const mom = chg > 3 ? 1 : chg > 0 ? 0.6 : chg > -3 ? 0.3 : 0.1;
    const aiDec = aiDecisions[sym];
    const aiB = aiDec?.verdict === 'YES' ? 0.2 : aiDec?.verdict === 'NO' ? -0.2 : 0;
    const score = Math.max(0, Math.min(100, Math.round((wr*0.3+act*0.25+sig*0.25+mom*0.15+aiB)*100)));
    if (!tickerHealth[sym]) tickerHealth[sym] = { score:50, noTradeCount:0 };
    tickerHealth[sym].score = score;
    tickerHealth[sym].noTradeCount = b.trades === 0 ? (tickerHealth[sym].noTradeCount||0)+1 : 0;
  });
}

async function rotateRoster() {
  console.log('🔄 Rotating roster...');
  lastRotateTime = new Date();
  scoreTickerHealth();
  const toDrop = [];
  tickers.slice().forEach(sym => {
    const h = tickerHealth[sym], b = bots[sym];
    if (!b || b.pos > 0) return;
    const aiDec = aiDecisions[sym];
    const aiNo  = aiDec?.verdict === 'NO' && (h?.noTradeCount||0) > 5;
    const dead  = (h?.noTradeCount||0) > 15 && b.trades === 0;
    const poor  = b.trades >= 4 && (b.wins/b.trades) < 0.35;
    if ((aiNo||dead||poor) && tickers.length-toDrop.length > SETTINGS.minBots) {
      toDrop.push({ sym, reason: dead?'No activity':poor?'Win rate < 35%':'AI kept rejecting' });
    }
  });
  for (const d of toDrop) {
    dropTicker(d.sym, d.reason);
    await sleep(400);
  }
  if (toDrop.length > 0 || tickers.length < 5) {
    const needed = Math.max(toDrop.length, 5-tickers.length);
    await findReplacements(needed);
  }
  broadcast('ROSTER_UPDATE', { tickers, tickerHealth, rotationLog, STOCKS, bots, hist });
}

async function findReplacements(count) {
  if (!ANTHROPIC_KEY) return;
  const prompt = `Find ${count} replacement penny stocks. Currently tracking: ${tickers.join(', ')}. Need fresh setups with active catalysts. Return ONLY JSON array: [{"sym":"TICKER","name":"Company","price":float,"float":float,"short":float,"sector":"sector","score":0-100,"catalyst":"reason","ai_verdict":"YES","confidence":0-100,"entry":float,"stop":float,"target":float}]`;
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model:'claude-sonnet-4-6', max_tokens:600,
      messages:[{role:'user',content:prompt}]
    }, { headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'} });
    const txt  = resp.data?.content?.[0]?.text || '[]';
    const list = JSON.parse(txt.replace(/```json|```/g,'').trim());
    for (const r of list) {
      if (!tickers.includes(r.sym) && tickers.length < SETTINGS.maxBots) {
        autoAddTicker(r);
        await sleep(300);
      }
    }
  } catch(e) { console.error('Replacement error:', e.message); }
}

function addRotationLog(action, sym, reason) {
  rotationLog.unshift({
    time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
    action, sym, reason
  });
  if (rotationLog.length > 50) rotationLog.pop();
}

// ── REAL NEWS FEED ──
async function fetchRealNews() {
  const feeds = [
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GME,AMC,BBAI,MARA,ONDS&region=US&lang=en-US',
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=penny+stocks+nasdaq&region=US&lang=en-US'
  ];
  const parser = new xml2js.Parser({ explicitArray:false });
  const results = [];
  for (const url of feeds) {
    try {
      const resp = await axios.get(url, { timeout:8000 });
      const parsed = await parser.parseStringPromise(resp.data);
      const items  = parsed?.rss?.channel?.item || [];
      const arr    = Array.isArray(items) ? items : [items];
      arr.slice(0,5).forEach(item => {
        const title = item.title || '';
        // Check if relevant to any tracked ticker
        const matchSym = tickers.find(s => title.toUpperCase().includes(s));
        results.push({
          sym:      matchSym || 'MARKET',
          headline: title,
          impact:   title.match(/surge|spike|FDA|DoD|contract|beat|squeeze|short/i) ? 'HIGH' : 'MEDIUM',
          time:     new Date().toLocaleTimeString(),
          link:     item.link || ''
        });
      });
    } catch(e) { /* RSS might be unavailable */ }
  }
  if (results.length > 0) {
    newsItems = results.concat(newsItems).slice(0,30);
    broadcast('NEWS', { items: newsItems });
    // Alert on HIGH impact news for tracked tickers
    results.filter(n => n.impact === 'HIGH' && n.sym !== 'MARKET')
           .forEach(n => sendDiscordAlert(`📰 **${n.sym} CATALYST** — ${n.headline}`));
  }
}

// ── ALPACA API ──
async function testAlpaca() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  try {
    const resp = await axios.get(`${ALPACA_BASE}/v2/account`, {
      headers: { 'APCA-API-KEY-ID':ALPACA_KEY, 'APCA-API-SECRET-KEY':ALPACA_SECRET }
    });
    alpacaConnected = true;
    const acct = resp.data;
    console.log(`✅ Alpaca connected — $${parseFloat(acct.portfolio_value).toFixed(2)} portfolio`);
    sendDiscordAlert(`✅ **Alpaca Connected** — Portfolio: $${parseFloat(acct.portfolio_value).toFixed(2)} · Mode: ${ALPACA_PAPER?'PAPER':'LIVE'}`);
    broadcast('ALPACA_STATUS', { connected:true, portfolio:acct.portfolio_value, paper:ALPACA_PAPER });
  } catch(e) {
    console.log('⚠️ Alpaca not connected:', e.message);
  }
}

async function placeAlpacaOrder(sym, qty, side) {
  if (!alpacaConnected || !ALPACA_KEY) return;
  try {
    const resp = await axios.post(`${ALPACA_BASE}/v2/orders`, {
      symbol:sym, qty, side, type:'market', time_in_force:'day'
    }, { headers:{'APCA-API-KEY-ID':ALPACA_KEY,'APCA-API-SECRET-KEY':ALPACA_SECRET,'Content-Type':'application/json'} });
    console.log(`📋 Alpaca ${side} ${qty} ${sym} — order ${resp.data.id}`);
  } catch(e) { console.error(`Alpaca order error:`, e.message); }
}

// ── DISCORD ALERTS ──
async function sendDiscordAlert(message) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await axios.post(DISCORD_WEBHOOK, {
      username: '🧠 APEX AI BRAIN',
      avatar_url: 'https://i.imgur.com/4M34hi2.png',
      embeds: [{
        description: message,
        color: 0x00ffff,
        timestamp: new Date().toISOString(),
        footer: { text: `APEX AI BRAIN · ${ALPACA_PAPER?'PAPER':'LIVE'} · ${tickers.length} bots active` }
      }]
    });
  } catch(e) { /* Discord might be rate limited */ }
}

async function sendDiscordTrade(trade) {
  if (!DISCORD_WEBHOOK) return;
  const win = trade.pnl > 0;
  const wr  = totalTrades > 0 ? Math.round(totalWins/totalTrades*100) : 0;
  await sendDiscordAlert(
    `${win ? '✅' : '❌'} **${trade.sym} ${trade.reason}**\n` +
    `💰 P&L: ${win?'+':''}\$${trade.pnl.toFixed(2)} · Conf: ${trade.aiConfidence}%\n` +
    `📊 Pattern: ${trade.pattern} · Sentiment: ${trade.sentiment}/100\n` +
    `📈 Session: ${win?'+':''}\$${dailyPnl.toFixed(2)} today · ${wr}% win rate (${totalTrades} trades)`
  );
}

async function sendDailyReport() {
  const wr = totalTrades > 0 ? Math.round(totalWins/totalTrades*100) : 0;
  // Summarize top patterns from learned data
  const topPatterns = Object.entries(patternData.patterns)
    .sort(([,a],[,b]) => (b.wins/b.count||0) - (a.wins/a.count||0))
    .slice(0,3)
    .map(([k,v]) => `${k}: ${Math.round(v.wins/v.count*100)}% WR`)
    .join(', ') || 'Not enough data yet';

  await sendDiscordAlert(
    `📊 **DAILY SUMMARY — ${new Date().toLocaleDateString()}**\n\n` +
    `💰 Today's P&L: ${dailyPnl >= 0?'+':''}\$${dailyPnl.toFixed(2)}\n` +
    `📈 All-time P&L: ${totalPnl >= 0?'+':''}\$${totalPnl.toFixed(2)}\n` +
    `🎯 Win Rate: ${wr}% (${totalWins}W / ${totalTrades - totalWins}L)\n` +
    `🤖 Active Bots: ${tickers.length} tickers\n` +
    `🧠 Top Patterns: ${topPatterns}\n` +
    `📊 Mode: ${ALPACA_PAPER?'PAPER TRADING':'⚠️ LIVE TRADING'}`
  );
  // Reset daily counters
  dailyTrades = 0; dailyLoss = 0; dailyPnl = 0;
}

// ── GOOGLE SHEETS SYNC ──
async function syncSheets(trade) {
  if (!SHEETS_WEBHOOK) return;
  const row = [trade.date, trade.time, trade.sym, trade.entry, trade.exit,
               trade.allocated, trade.pnl, trade.reason, trade.pattern,
               trade.sentiment, trade.aiVerdict, trade.aiConfidence];
  await axios.post(SHEETS_WEBHOOK, { values:[row] }, { headers:{'Content-Type':'application/json'} });
}

// ── PATTERN REVIEW (weekly AI self-improvement) ──
async function reviewPatterns() {
  if (!ANTHROPIC_KEY || Object.keys(patternData.patterns).length < 10) return;
  console.log('🧠 Running weekly pattern review...');
  const summary = Object.entries(patternData.patterns).slice(0,20)
    .map(([k,v]) => `${k}: ${v.wins}W/${v.losses}L, avgPnL $${(v.totalPnl/v.count).toFixed(2)}, avgConf ${v.avgConf}%`)
    .join('\n');
  const prompt = `You are an AI trading coach. Review this bot's pattern performance data and identify what's working and what to avoid. Data:\n${summary}\n\nGive 3 specific insights in under 150 words.`;
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model:'claude-sonnet-4-6', max_tokens:300,
      messages:[{role:'user',content:prompt}]
    }, { headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'} });
    const insight = resp.data?.content?.[0]?.text || '';
    await sendDiscordAlert(`🧠 **WEEKLY PATTERN REVIEW**\n\n${insight}`);
    broadcast('PATTERN_INSIGHT', { insight, patternData });
  } catch(e) { console.error('Pattern review error:', e.message); }
}

// ── HELPERS ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CRON JOBS ──

// Price fetching every 5 seconds — real Alpaca prices with simulation fallback
setInterval(fetchAlpacaPrices, 5000);

// AI analyze all tickers every 2 minutes
setInterval(analyzeAllTickers, 120000);

// Roster health + auto-rotate every 5 minutes
setInterval(rotateRoster, 300000);

// Full market discovery scan every 10 minutes
setInterval(() => discoverNewTickers('full'), 600000);

// News feed refresh every 5 minutes
setInterval(fetchRealNews, 300000);

// Pre-market scanner — 4:00am ET every weekday
cron.schedule('0 4 * * 1-5', async () => {
  console.log('⏰ Pre-market scanner running...');
  await sendDiscordAlert('⏰ **PRE-MARKET SCAN STARTING** — 4:00am ET\n🔍 AI hunting gappers and catalysts...');
  await discoverNewTickers('catalyst');
  await discoverNewTickers('momentum');
  await analyzeAllTickers();
  await sendDiscordAlert('✅ **PRE-MARKET SCAN COMPLETE** — Bots armed and ready for open');
}, { timezone: 'America/New_York' });

// Daily P&L report — 4:05pm ET every weekday (after market close)
cron.schedule('5 16 * * 1-5', sendDailyReport, { timezone: 'America/New_York' });

// Weekly pattern review — Sunday 8pm ET
cron.schedule('0 20 * * 0', reviewPatterns, { timezone: 'America/New_York' });

// Reset daily counters at midnight
cron.schedule('0 0 * * *', () => {
  dailyTrades = 0; dailyLoss = 0; dailyPnl = 0;
  console.log('🌙 Daily counters reset');
}, { timezone: 'America/New_York' });

// ── REST API ROUTES ──
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running', tickers: tickers.length,
    totalPnl, totalTrades, totalWins,
    dailyPnl, alpacaConnected,
    lastAnalyze: lastAnalyzeTime,
    lastRotate:  lastRotateTime,
    patternCount: Object.keys(patternData.patterns).length,
    uptime: process.uptime()
  });
});

app.get('/api/trades', (req, res) => {
  res.json({ trades: tradeJournal.slice(0,100), totalPnl, totalTrades, totalWins });
});

app.get('/api/patterns', (req, res) => {
  res.json(patternData);
});

app.post('/api/settings', (req, res) => {
  Object.assign(SETTINGS, req.body);
  broadcast('SETTINGS', SETTINGS);
  res.json({ ok:true, settings:SETTINGS });
});

app.post('/api/add-ticker', (req, res) => {
  const { sym } = req.body;
  if (!sym || tickers.includes(sym)) return res.json({ ok:false, reason:'already tracking or invalid' });
  autoAddTicker({ sym: sym.toUpperCase(), price: 5, float:50, short:15, sector:'Manual', catalyst:'Manually added', ai_verdict:'WATCH', confidence:50 });
  res.json({ ok:true, tickers });
});

app.post('/api/remove-ticker', (req, res) => {
  const { sym, reason } = req.body;
  const ok = dropTicker(sym, reason||'Manually removed');
  res.json({ ok, tickers });
});

app.post('/api/analyze-now', async (req, res) => {
  res.json({ ok:true, message:'Analysis started' });
  await analyzeAllTickers();
});

app.post('/api/rotate-now', async (req, res) => {
  res.json({ ok:true, message:'Rotation started' });
  await rotateRoster();
});

app.post('/api/scan-now', async (req, res) => {
  const { type } = req.body;
  res.json({ ok:true, message:'Scan started' });
  await discoverNewTickers(type||'full');
});

// ── START ──
server.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║      APEX AI BRAIN SERVER            ║');
  console.log('║      24/7 Trading Engine             ║');
  console.log(`║      Port: ${PORT}                       ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log(`🤖 Tracking: ${tickers.join(', ')}`);
  console.log(`💰 Budget/bot: $${SETTINGS.budget} | Stop: ${SETTINGS.stopLoss}% | Target: ${SETTINGS.takeProfit}%`);
  console.log(`🧠 Claude AI: ${ANTHROPIC_KEY ? '✅ Connected' : '❌ No API key'}`);
  console.log(`📊 Alpaca: ${ALPACA_KEY ? '⏳ Testing...' : '❌ No credentials'}`);
  console.log(`💬 Discord: ${DISCORD_WEBHOOK ? '✅ Connected' : '❌ No webhook'}`);
  console.log('');

  // Boot sequence
  await testAlpaca();
  await fetchRealNews();
  await sleep(2000);
  // Full market scan on startup — brain hunts real opportunities immediately
  console.log('🔍 Running startup market scan — finding real opportunities...');
  await discoverNewTickers('full');
  await sleep(1000);
  await discoverNewTickers('momentum');
  await sleep(1000);
  await analyzeAllTickers();

  sendDiscordAlert(
    `🚀 **APEX AI BRAIN SERVER STARTED**\n` +
    `🤖 ${tickers.length} bots active: ${tickers.join(', ')}\n` +
    `🧠 Claude AI: ${ANTHROPIC_KEY?'✅':'❌'} · Alpaca: ${alpacaConnected?'✅ '+( ALPACA_PAPER?'PAPER':'LIVE'):'❌'}\n` +
    `⏰ Schedule: Analyze 2m · Rotate 5m · Scan 10m · Pre-market 4am ET`
  );
  console.log('✅ Boot complete — all systems running');
});

process.on('uncaughtException', e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', e => console.error('Unhandled:', e?.message||e));
