const express = require('express');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ── ROUNDHILL: Fetch all declarations from last 14 days ──────────
app.get('/roundhill', async (req, res) => {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
    'Accept': 'text/html,application/xhtml+xml',
  };

  const today = new Date();
  const allEtfs = {};

  for (let daysBack = 0; daysBack <= 14; daysBack++) {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];
    const url = `https://www.cboe.com/us/equities/notices/dividends/details/?firm_name=Roundhill+Financial+Inc.&declaration_dt=${dateStr}`;

    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      const html = await resp.text();
      const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

      for (const row of rows) {
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
          .map(c => c[1].replace(/<[^>]+>/g, '').trim());

        if (cells.length >= 6 && cells[0].match(/^[A-Z]{2,5}$/) && cells[2].match(/\d{4}-\d{2}-\d{2}/)) {
          const ticker = cells[0];
          if (!allEtfs[ticker]) {
            allEtfs[ticker] = {
              ticker,
              name:         cells[1],
              exDate:       cells[2],
              recordDate:   cells[3],
              payableDate:  cells[4],
              amount:       parseFloat(cells[5].replace('$', '')),
              declaredDate: dateStr,
            };
          }
        }
      }
    } catch(e) {
      continue;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  const etfs = Object.values(allEtfs).sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (etfs.length > 0) {
    res.json({ count: etfs.length, etfs });
  } else {
    res.status(404).json({ error: 'No Roundhill declarations found in last 14 days' });
  }
});

// ── PRICE FALLBACK: Yahoo Finance for tickers Finnhub doesn't cover ──
app.get('/price/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000)
    });
    const json = await resp.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
    res.json({ ticker, price });
  } catch(e) {
    res.status(500).json({ ticker, price: null, error: e.message });
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(process.env.PORT || 3000);
