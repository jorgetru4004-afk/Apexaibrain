// ═══════════════════════════════════════════════════════════════
//  APEX AI BRAIN — 24/7 Autonomous Stock Trading Server
//  Built clean — no patches, no hardcoded tickers
//  Deploy to Railway.app
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cron      = require('node-cron');
const axios     = require('axios');
const xml2js    = require('xml2js');
const fs        = require('fs');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;

// ── ENVIRONMENT ──
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const ALPACA_KEY      = process.env.ALPACA_KEY_ID     || '';
const ALPACA_SECRET   = process.env.ALPACA_SECRET_KEY || '';
const ALPACA_PAPER    = process.env.ALPACA_PAPER !== 'false';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK   || '';

const ALPACA_BASE = ALPACA_PAPER
  ? 'https://paper-api.alpaca.markets'
  : 'https://api.alpaca.markets';

// ── DATA PERSISTENCE ──
const DATA_DIR      = path.join(__dirname, 'data');
const TRADES_FILE   = path.join(DATA_DIR, 'trades.json');
const PATTERNS_FILE = path.join(DATA_DIR, 'patterns.json');
const ROSTER_FILE   = path.join(DATA_DIR, 'roster.json');

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
  stopLoss:       7,
  takeProfit:     8,
  budget:         200,
  dailyLossLimit: 150,
  maxDailyTrades: 20,
  maxBots:        10,
  minBots:        3,
  cooldownSecs:   90,
};

// ── STATE ──
// Brain always starts fresh — no hardcoded tickers ever
// Roster is rebuilt from market scan on every startup
let tickers      = [];
let tradeJournal = loadJSON(TRADES_FILE,   []);
let patternData  = loadJSON(PATTERNS_FILE, { patterns: {}, totalDecisions: 0 });

let STOCKS       = {};
let bots         = {};
let hist         = {};
let vols         = {};
let sentimentMap = {};
let aiDecisions  = {};
let tickerHealth = {};
let tradeCooldown = {}; // prevents same ticker from trading too fast
let rotationLog  = [];
let newsItems    = [];

let totalPnl    = tradeJournal.reduce((s, t) => s + t.pnl, 0);
let totalTrades = tradeJournal.length;
let totalWins   = tradeJournal.filter(t => t.pnl > 0).length;
let dailyTrades = 0;
let dailyLoss   = 0;
let dailyPnl    = 0;

let alpacaConnected = false;
let lastAnalyzeTime = null;
let lastRotateTime  = null;
let lastScanTime    = null;

// ── COLORS FOR BOTS ──
const BOT_COLORS = [
  '#00f5ff','#a855f7','#00ff88','#fbbf24','#ff6b6b',
  '#06d6a0','#ffb347','#f0abfc','#60a5fa','#fb7185'
];
function nextColor() {
  return BOT_COLORS[tickers.length % BOT_COLORS.length];
}

// ── INIT STOCK ──
function initStock(sym, price, floatM, shortPct, avgVol, sector, color) {
  price = Math.max(0.01, parseFloat(price) || 5);
  STOCKS[sym] = {
    name: sym, price,
    open: price * 0.97,
    prev: price * 0.97,
    float: parseFloat(floatM)  || 50,
    short: parseFloat(shortPct)|| 15,
    avgVol: parseInt(avgVol)   || 2000000,
    color: color || nextColor(),
    sector: sector || 'Discovery',
    change24: 0
  };
  // Build seed price history
  hist[sym] = [];
  let p = price * 0.95;
  for (let i = 0; i < 60; i++) {
    p = Math.max(0.01, p * (1 + (Math.random() - 0.49) * 0.008));
    hist[sym].push(parseFloat(p.toFixed(4)));
  }
  hist[sym].push(price);
  vols[sym] = Math.floor((parseInt(avgVol) || 2000000) * 0.06);
  sentimentMap[sym] = {
    reddit:  Math.floor(Math.random() * 40 + 40),
    twitter: Math.floor(Math.random() * 40 + 40),
    news:    Math.floor(Math.random() * 40 + 40),
    overall: 60
  };
  bots[sym] = {
    on: true, status: 'WATCHING',
    pos: 0, entry: 0, pnl: 0,
    trades: 0, wins: 0, halted: false,
    vwap: price, vS: price, vC: 1,
    dayH: price * 1.01, dayL: price * 0.99,
    orbH: price * 1.005, orbL: price * 0.995, orbSet: false,
    pattern: 'NONE', aiApproved: null,
    allocated: 0, sizingLabel: 'FULL', confidence: 0
  };
  tickerHealth[sym] = { score: 50, noTradeCount: 0 };
  tradeCooldown[sym] = 0;
}

// ── WEBSOCKET ──
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (e) {}
    }
  });
}

wss.on('connection', ws => {
  console.log('📱 Dashboard connected');
  ws.send(JSON.stringify({ type: 'SNAPSHOT', data: getSnapshot() }));
});

function getSnapshot() {
  return {
    tickers, STOCKS, bots, hist, vols, sentimentMap,
    aiDecisions, tickerHealth, rotationLog, newsItems,
    totalPnl, totalTrades, totalWins, dailyTrades, dailyLoss, dailyPnl,
    tradeJournal: tradeJournal.slice(0, 50),
    patternData, SETTINGS, alpacaConnected,
    lastAnalyzeTime, lastRotateTime, lastScanTime,
    serverTime: new Date().toISOString()
  };
}

// ── PRICE SIMULATION ──
function tickPrices() {
  tickers.forEach(sym => {
    const s = STOCKS[sym];
    if (!s) return;
    const chg = (Math.random() - 0.488) * 0.007;
    s.price = Math.max(0.01, parseFloat((s.price * (1 + chg)).toFixed(4)));
    s.change24 = parseFloat(((s.price - s.open) / s.open * 100).toFixed(2));
    hist[sym].push(s.price);
    if (hist[sym].length > 120) hist[sym].shift();
    vols[sym] += Math.floor(Math.random() * 15000 + 2000);
    const b = bots[sym];
    b.vC++; b.vS += s.price;
    b.vwap = parseFloat((b.vS / b.vC).toFixed(4));
    if (s.price > b.dayH) b.dayH = s.price;
    if (s.price < b.dayL) b.dayL = s.price;
    if (!b.orbSet && b.vC === 15) { b.orbH = b.dayH; b.orbL = b.dayL; b.orbSet = true; }
    const sn = sentimentMap[sym];
    sn.reddit  = Math.min(99, Math.max(10, sn.reddit  + Math.floor((Math.random() - 0.5) * 5)));
    sn.twitter = Math.min(99, Math.max(10, sn.twitter + Math.floor((Math.random() - 0.5) * 5)));
    sn.news    = Math.min(99, Math.max(10, sn.news    + Math.floor((Math.random() - 0.5) * 3)));
    sn.overall = Math.round(sn.reddit * 0.3 + sn.twitter * 0.4 + sn.news * 0.3);
    if (b.on && !b.halted) runBotLogic(sym);
  });
  broadcast('PRICES', {
    prices:  Object.fromEntries(tickers.map(s => [s, STOCKS[s]?.price])),
    changes: Object.fromEntries(tickers.map(s => [s, STOCKS[s]?.change24])),
    vols:    Object.fromEntries(tickers.map(s => [s, vols[s]])),
    bots:    Object.fromEntries(tickers.map(s => [s, bots[s]])),
    sent:    sentimentMap,
    totalPnl, totalTrades, totalWins, dailyPnl
  });
}

// ── SIGNALS ──
function getSignals(sym) {
  const h = hist[sym], s = STOCKS[sym], b = bots[sym];
  if (!h || h.length < 14) return {
    rsi: 50, volR: 1, momentum: 50,
    squeeze: 30, sentiment: 60,
    pattern: { name: 'NONE', signal: 'WAIT' }, rr: 2
  };
  let g = 0, l = 0;
  for (let i = h.length - 14; i < h.length; i++) {
    const d = (h[i] - h[i - 1]) || 0;
    if (d > 0) g += d; else l -= d;
  }
  const rsi     = Math.round(100 - 100 / (1 + (g / (l || 0.001))));
  const volR    = parseFloat((vols[sym] / (s.avgVol * 0.06 || 1)).toFixed(1));
  const mom     = Math.min(100, Math.max(0, Math.round(50 + (s.price - s.open) / s.open * 500)));
  const squeeze = Math.min(100, Math.round(s.short * 1.5 + (volR > 2 ? 20 : 0)));
  const sn      = sentimentMap[sym];
  const patterns = ['BREAKOUT', 'BULL FLAG', 'HAMMER', 'ABCD', 'VWAP RECLAIM', 'MOMENTUM'];
  const pi      = rsi < 40 ? 2 : mom > 65 ? 0 : volR > 2 ? 3 : Math.floor(Math.random() * 6);
  return {
    rsi, volR, momentum: mom, squeeze, sentiment: sn.overall,
    pattern: { name: patterns[Math.min(pi, 5)], signal: pi < 5 ? 'BUY' : 'WAIT' },
    rr: parseFloat((SETTINGS.takeProfit / SETTINGS.stopLoss).toFixed(1))
  };
}

function getPositionSize(sym) {
  const conf   = aiDecisions[sym]?.confidence || 50;
  const budget = SETTINGS.budget;
  let pct, label;
  if (conf >= 90)      { pct = 1.00; label = 'FULL'; }
  else if (conf >= 75) { pct = 0.75; label = '75%'; }
  else if (conf >= 60) { pct = 0.50; label = '50%'; }
  else                 { pct = 0.25; label = '25%'; }
  return { dollars: parseFloat((budget * pct).toFixed(2)), pct, label, confidence: conf };
}

// ── BOT LOGIC ──
function runBotLogic(sym) {
  if (dailyTrades >= SETTINGS.maxDailyTrades) return;
  if (dailyLoss   >= SETTINGS.dailyLossLimit) return;
  const s = STOCKS[sym], b = bots[sym];
  if (!s || !b || b.halted) return;
  const sg = getSignals(sym);

  // ── EXIT ──
  if (b.pos > 0) {
    const pct = (s.price - b.entry) / b.entry * 100;
    if (pct <= -SETTINGS.stopLoss || pct >= SETTINGS.takeProfit) {
      const pnl = parseFloat((b.pos * (s.price - b.entry)).toFixed(2));
      b.pnl     += pnl;
      totalPnl   = parseFloat((totalPnl + pnl).toFixed(2));
      dailyPnl   = parseFloat((dailyPnl + pnl).toFixed(2));
      dailyTrades++;
      if (pnl > 0) { b.wins++; totalWins++; }
      else { dailyLoss += Math.abs(pnl); }
      b.trades++; totalTrades++;
      const exitPrice = s.price;
      const entryPrice = b.entry;
      b.pos = 0; b.entry = 0; b.status = 'WATCHING'; b.aiApproved = null;
      const reason = pnl > 0 ? 'TARGET HIT' : 'STOP LOSS';
      const trade  = logTrade(sym, entryPrice, exitPrice, b.allocated, pnl, reason, sg);
      sendDiscordTrade(trade);
      if (ALPACA_KEY && alpacaConnected) {
        placeAlpacaOrder(sym, Math.floor(b.allocated / exitPrice), 'sell').catch(() => {});
      }
      learnFromTrade(sym, trade, aiDecisions[sym]);
      broadcast('TRADE', { trade, bot: bots[sym], totalPnl, totalTrades, totalWins, dailyPnl });
    } else {
      b.status = pct > 0 ? 'RIPPING 🚀' : 'HOLD';
    }
    return;
  }

  // ── COOLDOWN CHECK ──
  const lastTrade = tradeCooldown[sym] || 0;
  if (Date.now() - lastTrade < SETTINGS.cooldownSecs * 1000) {
    b.status = 'COOLDOWN';
    return;
  }

  // ── ENTRY SIGNALS ──
  const signalReady = sg.rsi < 65 && sg.volR > 1.2 && sg.momentum > 48 && s.price > b.vwap * 0.995;
  if (!signalReady) { b.status = 'WATCHING'; return; }

  // ── AI APPROVAL CHECK ──
  const dec = aiDecisions[sym];
  if (!dec || dec.verdict !== 'YES') {
    b.status = dec ? (dec.verdict === 'NO' ? 'AI SKIP' : 'AI ' + dec.verdict) : 'WAITING AI';
    return;
  }

  // ── ENTER POSITION ──
  const sizing    = getPositionSize(sym);
  tradeCooldown[sym] = Date.now();
  b.pos          = Math.max(1, Math.floor(sizing.dollars / s.price));
  b.entry        = s.price;
  b.allocated    = sizing.dollars;
  b.sizingLabel  = sizing.label;
  b.confidence   = sizing.confidence;
  b.status       = 'IN POSITION';
  b.pattern      = sg.pattern.name;
  b.aiApproved   = true;

  console.log(`⚡ ENTRY: ${sym} @ $${s.price} | ${sizing.label} ($${sizing.dollars}) | ${sizing.confidence}% conf`);
  sendDiscordAlert(
    `⚡ **${sym} ENTRY** @ $${s.price.toFixed(4)}\n` +
    `💰 Size: ${sizing.label} ($${sizing.dollars}) · ${sizing.confidence}% confidence\n` +
    `📊 Pattern: ${sg.pattern.name} · RSI: ${sg.rsi} · Vol: ${sg.volR}x`
  );
  if (ALPACA_KEY && alpacaConnected) {
    placeAlpacaOrder(sym, b.pos, 'buy').catch(() => {});
  }
  broadcast('ENTRY', { sym, price: s.price, sizing, bot: bots[sym] });
}

// ── TRADE LOG ──
function logTrade(sym, entry, exit, allocated, pnl, reason, sg) {
  const trade = {
    id:           tradeJournal.length + 1,
    sym, entry, exit, allocated, pnl, reason,
    pattern:      sg?.pattern?.name || '—',
    sentiment:    sentimentMap[sym]?.overall || 0,
    aiVerdict:    aiDecisions[sym]?.verdict  || '—',
    aiConf:       aiDecisions[sym]?.confidence || 0,
    date:         new Date().toLocaleDateString(),
    time:         new Date().toLocaleTimeString()
  };
  tradeJournal.unshift(trade);
  if (tradeJournal.length > 500) tradeJournal.pop();
  saveJSON(TRADES_FILE, tradeJournal);
  return trade;
}

// ── PATTERN LEARNING ──
function learnFromTrade(sym, trade, aiDec) {
  if (!aiDec) return;
  const key = `${trade.pattern}_${aiDec.verdict}`;
  if (!patternData.patterns[key]) {
    patternData.patterns[key] = { wins: 0, losses: 0, totalPnl: 0, avgConf: 0, count: 0 };
  }
  const p = patternData.patterns[key];
  p.count++;
  if (trade.pnl > 0) p.wins++; else p.losses++;
  p.totalPnl = parseFloat((p.totalPnl + trade.pnl).toFixed(2));
  p.avgConf  = parseFloat(((p.avgConf * (p.count - 1) + (aiDec.confidence || 0)) / p.count).toFixed(1));
  patternData.totalDecisions++;
  saveJSON(PATTERNS_FILE, patternData);
}

// ── CLAUDE AI BRAIN ──
async function askAI(sym) {
  if (!ANTHROPIC_KEY) {
    aiDecisions[sym] = {
      verdict: 'ERROR', confidence: 0, sym,
      reason: 'No API key — add ANTHROPIC_API_KEY in Railway variables',
      time: new Date().toLocaleTimeString()
    };
    broadcast('AI_DECISION', { sym, decision: aiDecisions[sym] });
    return;
  }
  const s   = STOCKS[sym], sg = getSignals(sym), b = bots[sym];
  if (!s) return;
  const chg = ((s.price - s.open) / s.open * 100).toFixed(2);

  // Include pattern learning in prompt
  const history = Object.entries(patternData.patterns)
    .filter(([k]) => k.includes(sg.pattern.name))
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v.wins}W/${v.losses || 0}L avg $${v.count > 0 ? (v.totalPnl / v.count).toFixed(2) : '0'}`)
    .join(', ') || 'No history yet';

  const prompt =
    `You are an elite penny stock trading AI. Analyze and give a JSON decision only.\n\n` +
    `Ticker: ${sym} | Sector: ${s.sector}\n` +
    `Price: $${s.price.toFixed(4)} (${chg}% today)\n` +
    `RSI: ${sg.rsi} | Volume: ${sg.volR}x avg | Momentum: ${sg.momentum}/100\n` +
    `Short Float: ${s.short}% | Float: ${s.float}M shares\n` +
    `Pattern: ${sg.pattern.name} | VWAP: ${s.price > b.vwap ? 'ABOVE ✅' : 'BELOW ⚠️'}\n` +
    `Sentiment: ${sg.sentiment}/100 | Squeeze Score: ${sg.squeeze}/100\n` +
    `Bot Win Rate: ${b.trades > 0 ? Math.round(b.wins / b.trades * 100) : 'N/A'}% (${b.trades} trades)\n` +
    `Pattern History: ${history}\n\n` +
    `Respond ONLY with JSON: {"verdict":"YES" or "NO","confidence":0-100,"reason":"2-3 sentences max","entry":${s.price.toFixed(4)},"stop":price,"target":price,"risk":"LOW or MEDIUM or HIGH","timeframe":"1-5min or 5-15min or 15-60min"}`;

  // Set thinking state
  aiDecisions[sym] = { verdict: 'THINKING', confidence: 0, sym, reason: 'Analyzing...', time: new Date().toLocaleTimeString() };
  broadcast('AI_DECISION', { sym, decision: aiDecisions[sym] });

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    });

    const txt   = resp.data?.content?.[0]?.text || '{}';
    const clean = txt.replace(/```json|```/g, '').trim();
    const dec   = JSON.parse(clean);
    dec.sym     = sym;
    dec.time    = new Date().toLocaleTimeString();
    aiDecisions[sym] = dec;

    console.log(`🧠 ${sym}: ${dec.verdict} (${dec.confidence}%) — ${dec.reason?.slice(0, 60)}`);
    broadcast('AI_DECISION', { sym, decision: dec });

    if (dec.verdict === 'YES') {
      sendDiscordAlert(
        `🧠 **AI APPROVED: ${sym}**\n` +
        `💡 ${dec.reason}\n` +
        `🎯 Entry $${dec.entry} · Stop $${dec.stop} · Target $${dec.target}\n` +
        `📊 ${dec.confidence}% confidence · Risk: ${dec.risk} · TF: ${dec.timeframe}`
      );
    }
  } catch (e) {
    console.error(`AI error ${sym}:`, e.message);
    aiDecisions[sym] = {
      verdict: 'ERROR', confidence: 0, sym,
      reason: 'API error — ' + e.message.slice(0, 80),
      time: new Date().toLocaleTimeString()
    };
    broadcast('AI_DECISION', { sym, decision: aiDecisions[sym] });
  }
}

async function analyzeAll() {
  if (!tickers.length) return;
  console.log(`🧠 Analyzing ${tickers.length} tickers...`);
  lastAnalyzeTime = new Date();
  for (const sym of [...tickers]) {
    // Skip re-analysis if decision is fresh (under 4 min old) and bot is not in a position
    const dec = aiDecisions[sym];
    const age = dec ? (Date.now() - new Date('1970-01-01 ' + dec.time).getTime()) : 99999;
    const b   = bots[sym];
    if (dec && dec.verdict !== 'ERROR' && dec.verdict !== 'THINKING' && b && b.pos === 0 && age < 240000) {
      continue; // decision still fresh — skip API call
    }
    await askAI(sym);
    await sleep(600);
  }
  broadcast('ANALYZE_COMPLETE', { count: tickers.length, time: lastAnalyzeTime });
}

// ── MARKET DISCOVERY ──
async function scanMarket(scanType) {
  if (!ANTHROPIC_KEY) return [];
  lastScanTime = new Date();
  const existing = tickers.length ? `Currently tracking: ${tickers.join(', ')}. Find different ones.` : 'No current positions.';
  const scanFocus = {
    full:      'top 5 penny stock opportunities right now — mix of momentum, catalyst, squeeze, and AI sector plays',
    momentum:  '5 high momentum penny stocks with volume spikes and strong price action today',
    catalyst:  '5 penny stocks with fresh catalysts — FDA approval, DoD contract, earnings beat, partnership announcement',
    squeeze:   '5 heavily shorted penny stocks primed for a squeeze right now',
    gapper:    '5 penny stocks gapping up significantly today with volume confirmation',
  };

  const prompt =
    `You are an elite penny stock scanner. ${existing}\n` +
    `Find: ${scanFocus[scanType] || scanFocus.full}\n\n` +
    `Return ONLY a JSON array (no text before or after):\n` +
    `[{"sym":"TICKER","name":"Company Name","price":float,"float":float,"short":float,` +
    `"sector":"sector","score":0-100,"catalyst":"specific reason why NOW",` +
    `"ai_verdict":"YES" or "WATCH","confidence":0-100,` +
    `"entry":float,"stop":float,"target":float}]`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    });

    const txt     = resp.data?.content?.[0]?.text || '[]';
    const results = JSON.parse(txt.replace(/```json|```/g, '').trim());
    broadcast('DISCOVERY_RESULTS', { results, scanType });

    // Auto-add YES picks that aren't already tracked
    for (const r of results) {
      if (r.ai_verdict === 'YES' && !tickers.includes(r.sym) && tickers.length < SETTINGS.maxBots) {
        addTicker(r);
        await sleep(300);
      }
    }
    return results;
  } catch (e) {
    console.error('Scan error:', e.message);
    return [];
  }
}

// ── ROSTER MANAGEMENT ──
function addTicker(disc) {
  const sym = (disc.sym || '').toUpperCase().trim();
  if (!sym || tickers.includes(sym)) return;
  if (tickers.length >= SETTINGS.maxBots) return;

  initStock(
    sym,
    disc.price  || (Math.random() * 8 + 0.5).toFixed(3),
    disc.float  || (Math.random() * 60 + 5).toFixed(1),
    disc.short  || (Math.random() * 30 + 5).toFixed(1),
    Math.floor(Math.random() * 8e6 + 500000),
    disc.sector || 'Discovery',
    nextColor()
  );

  tickers.push(sym);

  // Pre-load AI decision if we have one
  if (disc.ai_verdict) {
    aiDecisions[sym] = {
      sym,
      verdict:    disc.ai_verdict,
      confidence: disc.confidence || 70,
      reason:     disc.catalyst   || 'AI-discovered setup',
      entry:      disc.entry,
      stop:       disc.stop,
      target:     disc.target,
      time:       new Date().toLocaleTimeString()
    };
  }

  addRotationLog('ADD', sym, (disc.catalyst || 'AI selected').slice(0, 60));
  saveJSON(ROSTER_FILE, tickers);

  console.log(`➕ Added ${sym} | $${STOCKS[sym].price} | ${disc.catalyst?.slice(0, 50) || ''}`);
  sendDiscordAlert(
    `➕ **NEW BOT: ${sym}**\n` +
    `📊 ${disc.catalyst || 'AI-selected setup'}\n` +
    `💰 Entry $${disc.entry} · Target $${disc.target} · Conf: ${disc.confidence || 70}%`
  );

  broadcast('TICKER_ADDED', {
    sym,
    stock: STOCKS[sym],
    bot:   bots[sym],
    hist:  hist[sym],
    sent:  sentimentMap[sym]
  });
}

function dropTicker(sym, reason) {
  if (!tickers.includes(sym)) return false;
  if (tickers.length <= SETTINGS.minBots) return false;
  if (bots[sym]?.pos > 0) return false; // never drop open position

  tickers = tickers.filter(s => s !== sym);
  delete STOCKS[sym]; delete bots[sym];   delete hist[sym];
  delete vols[sym];   delete sentimentMap[sym];
  delete aiDecisions[sym]; delete tickerHealth[sym];
  delete tradeCooldown[sym];

  addRotationLog('REMOVE', sym, reason);
  saveJSON(ROSTER_FILE, tickers);

  console.log(`➖ Dropped ${sym}: ${reason}`);
  sendDiscordAlert(`➖ **DROPPED: ${sym}**\n❌ ${reason}`);
  broadcast('TICKER_REMOVED', { sym, reason });
  return true;
}

function addRotationLog(action, sym, reason) {
  rotationLog.unshift({
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    action, sym, reason
  });
  if (rotationLog.length > 100) rotationLog.pop();
}

// ── HEALTH SCORING ──
function scoreHealth() {
  tickers.forEach(sym => {
    const b  = bots[sym], s = STOCKS[sym];
    if (!b || !s) return;
    const chg = (s.price - s.open) / s.open * 100;
    const sg  = getSignals(sym);
    const wr  = b.trades > 0 ? b.wins / b.trades : 0.5;
    const act = b.trades > 0 ? Math.min(1, b.trades / 5) : 0.3;
    const sig = (sg.momentum + sg.sentiment + sg.squeeze) / 300;
    const mom = chg > 3 ? 1 : chg > 0 ? 0.6 : chg > -3 ? 0.3 : 0.1;
    const aiB = aiDecisions[sym]?.verdict === 'YES' ? 0.2 : aiDecisions[sym]?.verdict === 'NO' ? -0.2 : 0;
    const score = Math.max(0, Math.min(100,
      Math.round((wr * 0.3 + act * 0.25 + sig * 0.25 + mom * 0.15 + aiB) * 100)
    ));
    if (!tickerHealth[sym]) tickerHealth[sym] = { score: 50, noTradeCount: 0 };
    tickerHealth[sym].score = score;
    tickerHealth[sym].noTradeCount = b.trades === 0
      ? (tickerHealth[sym].noTradeCount || 0) + 1
      : 0;
  });
}

// ── AUTO ROTATE ──
async function rotateRoster() {
  if (!tickers.length) return;
  console.log('🔄 Rotating roster...');
  lastRotateTime = new Date();
  scoreHealth();

  const toDrop = [];
  tickers.slice().forEach(sym => {
    const h = tickerHealth[sym], b = bots[sym];
    if (!b || b.pos > 0) return; // never drop open position
    const aiNo  = aiDecisions[sym]?.verdict === 'NO' && (h?.noTradeCount || 0) > 5;
    const dead  = (h?.noTradeCount || 0) > 15 && b.trades === 0;
    const poor  = b.trades >= 5 && (b.wins / b.trades) < 0.35;
    if ((aiNo || dead || poor) && tickers.length - toDrop.length > SETTINGS.minBots) {
      toDrop.push({
        sym,
        reason: dead ? 'No activity — dropped for fresh pick'
               : poor ? 'Win rate below 35% — replaced'
               : 'AI kept rejecting — swapped out'
      });
    }
  });

  for (const d of toDrop) {
    dropTicker(d.sym, d.reason);
    await sleep(400);
  }

  // Find replacements if we dropped any or roster is thin
  if (toDrop.length > 0 || tickers.length < SETTINGS.minBots) {
    const needed = Math.max(toDrop.length, SETTINGS.minBots - tickers.length);
    await findReplacements(needed);
  }

  broadcast('ROSTER_UPDATE', {
    tickers, tickerHealth, rotationLog,
    STOCKS, bots, hist
  });
}

async function findReplacements(count) {
  if (!ANTHROPIC_KEY || count <= 0) return;
  const prompt =
    `Find ${count} replacement penny stock(s) to trade right now. ` +
    `${tickers.length ? `Currently tracking: ${tickers.join(', ')}. Pick different ones.` : ''} ` +
    `Need high momentum setups with active catalysts. ` +
    `Return ONLY JSON array: [{"sym":"TICKER","name":"Company","price":float,"float":float,` +
    `"short":float,"sector":"sector","score":0-100,"catalyst":"reason","ai_verdict":"YES",` +
    `"confidence":0-100,"entry":float,"stop":float,"target":float}]`;
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    });
    const txt  = resp.data?.content?.[0]?.text || '[]';
    const list = JSON.parse(txt.replace(/```json|```/g, '').trim());
    for (const r of list) {
      if (!tickers.includes(r.sym) && tickers.length < SETTINGS.maxBots) {
        addTicker(r);
        await sleep(300);
      }
    }
  } catch (e) { console.error('Replacement error:', e.message); }
}

// ── NEWS FEED ──
async function fetchNews() {
  const parser = new xml2js.Parser({ explicitArray: false });
  const feeds  = [
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GME,AMC,BBAI,MARA&region=US&lang=en-US',
  ];
  const results = [];
  for (const url of feeds) {
    try {
      const resp   = await axios.get(url, { timeout: 8000 });
      const parsed = await parser.parseStringPromise(resp.data);
      const items  = parsed?.rss?.channel?.item || [];
      const arr    = Array.isArray(items) ? items : [items];
      arr.slice(0, 8).forEach(item => {
        const title    = item.title || '';
        const matchSym = tickers.find(s => title.toUpperCase().includes(s));
        const impact   = title.match(/surge|spike|FDA|DoD|contract|beat|squeeze|short|gap/i) ? 'HIGH' : 'MEDIUM';
        results.push({
          sym:      matchSym || 'MARKET',
          headline: title,
          impact,
          time:     new Date().toLocaleTimeString(),
          link:     item.link || ''
        });
      });
    } catch (e) { /* RSS unavailable */ }
  }
  if (results.length > 0) {
    newsItems = results.concat(newsItems).slice(0, 30);
    broadcast('NEWS', { items: newsItems });
    results
      .filter(n => n.impact === 'HIGH' && n.sym !== 'MARKET')
      .forEach(n => sendDiscordAlert(`📰 **${n.sym} CATALYST** — ${n.headline}`));
  }
}

// ── ALPACA ──
async function testAlpaca() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  try {
    const resp = await axios.get(`${ALPACA_BASE}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID':     ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET
      }
    });
    alpacaConnected = true;
    const portfolio = parseFloat(resp.data.portfolio_value).toFixed(2);
    console.log(`✅ Alpaca connected — $${portfolio} portfolio | ${ALPACA_PAPER ? 'PAPER' : 'LIVE'}`);
    sendDiscordAlert(
      `✅ **Alpaca Connected**\n` +
      `💰 Portfolio: $${portfolio}\n` +
      `📊 Mode: ${ALPACA_PAPER ? '🟡 PAPER TRADING' : '🔴 LIVE TRADING'}`
    );
    broadcast('ALPACA_STATUS', { connected: true, portfolio, paper: ALPACA_PAPER });
  } catch (e) {
    console.log('⚠️ Alpaca:', e.message);
    alpacaConnected = false;
  }
}

async function placeAlpacaOrder(sym, qty, side) {
  if (!alpacaConnected || !ALPACA_KEY || qty < 1) return;
  try {
    const resp = await axios.post(`${ALPACA_BASE}/v2/orders`, {
      symbol: sym, qty, side,
      type: 'market', time_in_force: 'day'
    }, {
      headers: {
        'APCA-API-KEY-ID':     ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET,
        'Content-Type':        'application/json'
      }
    });
    console.log(`📋 Alpaca ${side} ${qty}x ${sym} — order ${resp.data.id}`);
  } catch (e) { console.error('Alpaca order error:', e.message); }
}

// ── DISCORD ──
async function sendDiscordAlert(message) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await axios.post(DISCORD_WEBHOOK, {
      username:   '🧠 APEX AI BRAIN',
      embeds: [{
        description: message,
        color:       0x00ffff,
        timestamp:   new Date().toISOString(),
        footer: { text: `APEX AI BRAIN · ${ALPACA_PAPER ? 'PAPER' : 'LIVE'} · ${tickers.length} bots` }
      }]
    });
  } catch (e) { /* rate limited */ }
}

async function sendDiscordTrade(trade) {
  const win = trade.pnl > 0;
  const wr  = totalTrades > 0 ? Math.round(totalWins / totalTrades * 100) : 0;
  await sendDiscordAlert(
    `${win ? '✅' : '❌'} **${trade.sym} ${trade.reason}**\n` +
    `💰 P&L: ${win ? '+' : ''}\$${trade.pnl.toFixed(2)} · Conf: ${trade.aiConf}%\n` +
    `📊 Pattern: ${trade.pattern} · Sentiment: ${trade.sentiment}/100\n` +
    `📈 Today: ${dailyPnl >= 0 ? '+' : ''}\$${dailyPnl.toFixed(2)} · All-time: $${totalPnl.toFixed(2)} · ${wr}% WR`
  );
}

// ── DAILY REPORT ──
async function sendDailyReport() {
  const wr = totalTrades > 0 ? Math.round(totalWins / totalTrades * 100) : 0;
  const topPatterns = Object.entries(patternData.patterns)
    .filter(([, v]) => v.count >= 3)
    .sort(([, a], [, b]) => (b.wins / b.count) - (a.wins / a.count))
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${Math.round(v.wins / v.count * 100)}% WR`)
    .join(', ') || 'Building data...';

  await sendDiscordAlert(
    `📊 **DAILY REPORT — ${new Date().toLocaleDateString()}**\n\n` +
    `💰 Today: ${dailyPnl >= 0 ? '+' : ''}\$${dailyPnl.toFixed(2)}\n` +
    `📈 All-Time P&L: ${totalPnl >= 0 ? '+' : ''}\$${totalPnl.toFixed(2)}\n` +
    `🎯 Win Rate: ${wr}% (${totalWins}W / ${totalTrades - totalWins}L)\n` +
    `🤖 Active Bots: ${tickers.length}\n` +
    `🧠 Top Patterns: ${topPatterns}\n` +
    `📊 Mode: ${ALPACA_PAPER ? '🟡 PAPER' : '🔴 LIVE'}`
  );
  dailyTrades = 0; dailyLoss = 0; dailyPnl = 0;
}

// ── WEEKLY REVIEW ──
async function weeklyReview() {
  if (!ANTHROPIC_KEY || Object.keys(patternData.patterns).length < 5) return;
  const summary = Object.entries(patternData.patterns)
    .slice(0, 15)
    .map(([k, v]) => `${k}: ${v.wins}W/${v.losses || 0}L avgPnL $${v.count > 0 ? (v.totalPnl / v.count).toFixed(2) : '0'} avgConf ${v.avgConf}%`)
    .join('\n');
  const prompt =
    `You are an AI trading coach. Review this bot's pattern data and give 3 specific actionable insights in under 150 words:\n${summary}`;
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    });
    const insight = resp.data?.content?.[0]?.text || '';
    await sendDiscordAlert(`🧠 **WEEKLY BRAIN REVIEW**\n\n${insight}`);
    broadcast('PATTERN_INSIGHT', { insight, patternData });
  } catch (e) { console.error('Weekly review error:', e.message); }
}

// ── HELPERS ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SCHEDULES ──
setInterval(tickPrices, 3000);                          // Price tick every 3s
setInterval(analyzeAll, 300000);                        // AI analyze every 5 min
setInterval(rotateRoster, 300000);                      // Rotate every 5 min
setInterval(() => scanMarket('full'), 600000);          // Full scan every 10 min
setInterval(fetchNews, 300000);                         // News every 5 min

// Pre-market scan 4am ET weekdays
cron.schedule('0 4 * * 1-5', async () => {
  console.log('⏰ Pre-market scan...');
  await sendDiscordAlert('⏰ **PRE-MARKET SCAN** — 4:00am ET · AI hunting gappers and catalysts...');
  await scanMarket('gapper');
  await sleep(1000);
  await scanMarket('catalyst');
  await sleep(1000);
  await analyzeAll();
  await sendDiscordAlert('✅ **PRE-MARKET COMPLETE** — Bots armed for open');
}, { timezone: 'America/New_York' });

// Daily report 4:05pm ET weekdays
cron.schedule('5 16 * * 1-5', sendDailyReport, { timezone: 'America/New_York' });

// Weekly review Sunday 8pm ET
cron.schedule('0 20 * * 0', weeklyReview, { timezone: 'America/New_York' });

// Reset daily counters midnight
cron.schedule('0 0 * * *', () => {
  dailyTrades = 0; dailyLoss = 0; dailyPnl = 0;
  console.log('🌙 Daily counters reset');
}, { timezone: 'America/New_York' });

// ── REST API ──
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running', tickers: tickers.length,
    totalPnl, totalTrades, totalWins, dailyPnl,
    alpacaConnected, lastAnalyzeTime, lastRotateTime,
    uptime: process.uptime()
  });
});

app.get('/api/trades',   (req, res) => res.json({ trades: tradeJournal.slice(0, 100), totalPnl, totalTrades, totalWins }));
app.get('/api/patterns', (req, res) => res.json(patternData));

app.post('/api/settings', (req, res) => {
  Object.assign(SETTINGS, req.body);
  broadcast('SETTINGS', SETTINGS);
  res.json({ ok: true, settings: SETTINGS });
});

app.post('/api/add-ticker', (req, res) => {
  const sym = (req.body.sym || '').toUpperCase().trim();
  if (!sym || tickers.includes(sym)) return res.json({ ok: false, reason: 'Already tracking or invalid' });
  addTicker({ sym, price: 5, float: 50, short: 15, sector: 'Manual', catalyst: 'Manually added', ai_verdict: 'WATCH', confidence: 50 });
  res.json({ ok: true, tickers });
});

app.post('/api/remove-ticker', (req, res) => {
  const ok = dropTicker(req.body.sym, req.body.reason || 'Manually removed');
  res.json({ ok, tickers });
});

app.post('/api/analyze-now', async (req, res) => {
  res.json({ ok: true });
  await analyzeAll();
});

app.post('/api/rotate-now', async (req, res) => {
  res.json({ ok: true });
  await rotateRoster();
});

app.post('/api/scan-now', async (req, res) => {
  const type = req.body.type || 'full';
  res.json({ ok: true });
  const results = await scanMarket(type);
  lastScanTime = new Date();
  broadcast('ROSTER_UPDATE', { tickers, tickerHealth, rotationLog, STOCKS, bots, hist });
});

// ── START ──
server.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║       APEX AI BRAIN  v2.0            ║');
  console.log('║       24/7 Autonomous Trading        ║');
  console.log(`║       Port: ${PORT}                      ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log(`🧠 Claude AI:  ${ANTHROPIC_KEY ? '✅ Connected' : '❌ No API key'}`);
  console.log(`📊 Alpaca:     ${ALPACA_KEY    ? '⏳ Testing...' : '❌ No credentials'}`);
  console.log(`💬 Discord:    ${DISCORD_WEBHOOK ? '✅ Connected' : '❌ No webhook'}`);
  console.log(`⚙️  Mode:       ${ALPACA_PAPER ? 'PAPER TRADING' : '🔴 LIVE TRADING'}`);
  console.log('');

  await testAlpaca();
  await fetchNews();
  await sleep(1500);

  // Brain picks its own tickers — no hardcoded defaults ever
  console.log('🔍 Brain scanning market for opportunities...');
  await scanMarket('full');
  await sleep(1500);
  await scanMarket('momentum');
  await sleep(1500);
  await scanMarket('catalyst');
  await sleep(1000);
  await analyzeAll();

  sendDiscordAlert(
    `🚀 **APEX AI BRAIN v2.0 ONLINE**\n` +
    `🤖 ${tickers.length} bots selected by AI: ${tickers.join(', ') || 'Scanning...'}\n` +
    `🧠 Claude: ${ANTHROPIC_KEY ? '✅' : '❌'} · Alpaca: ${alpacaConnected ? '✅ ' + (ALPACA_PAPER ? 'PAPER' : 'LIVE') : '❌'}\n` +
    `⏰ Analyze: 2min · Rotate: 5min · Scan: 10min · Pre-market: 4am ET`
  );

  console.log('✅ Boot complete — brain is hunting');
});

process.on('uncaughtException',  e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', e => console.error('Unhandled:', e?.message || e));
