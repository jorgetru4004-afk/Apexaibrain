# 🧠 APEX AI BRAIN — 24/7 Trading Server

Deploy to Railway.app and your bots run around the clock — phone off, bots on.

---

## 🚀 DEPLOYMENT (15 minutes, free to start)

### Step 1 — GitHub
1. Go to github.com → New repository → name it `ApexAIBrain`
2. Upload ALL files from this folder (drag and drop)
3. Click **Commit changes**

### Step 2 — Railway
1. Go to **railway.app** → Sign up with GitHub (free)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `ApexAIBrain` repo
4. Railway auto-detects Node.js and deploys — takes ~2 minutes

### Step 3 — Environment Variables
In Railway dashboard → your project → **Variables** tab, add:

| Variable | Value | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | sk-ant-... | ✅ Yes |
| `ALPACA_KEY_ID` | PKxxxxxxxx | For live trading |
| `ALPACA_SECRET_KEY` | xxxxxxxxxx | For live trading |
| `ALPACA_PAPER` | true | true = paper, false = live |
| `DISCORD_WEBHOOK` | https://discord.com/api/webhooks/... | For alerts |
| `SHEETS_WEBHOOK` | https://script.google.com/... | For trade logging |

### Step 4 — Get your URL
Railway gives you a URL like: `https://apexaibrain-production.up.railway.app`

Open that URL on your phone — it's your live dashboard connected to the server.

---

## 📱 USING THE DASHBOARD

- **Open the Railway URL** on any device — phone, laptop, anywhere
- The dashboard auto-connects to your server via WebSocket
- Green badge = **🖥️ SERVER MODE** — all AI runs on the server, phone can be off
- If you open the HTML file directly (not the Railway URL), it runs in local simulation mode

---

## 🔔 DISCORD SETUP

1. Open Discord → your server → any channel
2. Click ⚙️ Edit Channel → Integrations → Webhooks → New Webhook
3. Copy the webhook URL
4. Paste it as `DISCORD_WEBHOOK` in Railway variables

You'll get alerts for:
- Every trade entry and exit with P&L
- AI decisions (YES approved)
- New tickers added / dropped
- Pre-market scan results (4am ET)
- Daily summary at 4pm ET
- Weekly pattern review insights

---

## ⏰ AUTOMATIC SCHEDULE

| Action | Frequency |
|---|---|
| AI analyzes all tickers | Every 2 minutes |
| Roster health check | Every 5 minutes |
| Full market scan | Every 10 minutes |
| Fetch real news | Every 5 minutes |
| Pre-market scanner | 4:00am ET weekdays |
| Daily P&L report to Discord | 4:05pm ET weekdays |
| Weekly pattern review | Sunday 8pm ET |

---

## 💰 COSTS

| Item | Cost |
|---|---|
| Railway.app (Hobby plan) | $5/month |
| Anthropic Claude API | ~$4-8/month |
| Alpaca trading | FREE |
| **Total** | **~$10/month** |

Railway free tier: 500 hours/month. Upgrade to Hobby ($5/mo) for unlimited 24/7 uptime.

---

## 📊 DATA PERSISTENCE

All data survives server restarts:
- `data/trades.json` — full trade history
- `data/patterns.json` — AI pattern learning data  
- `data/roster.json` — current ticker list

---

## ⚠️ IMPORTANT — PAPER TRADING FIRST

Keep `ALPACA_PAPER=true` until you hit:
- ✅ 50+ paper trades
- ✅ 60%+ win rate
- ✅ Positive overall P&L

Only then change to `ALPACA_PAPER=false` for real money.
