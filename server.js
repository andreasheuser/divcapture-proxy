const express = require('express');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/rate/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toLowerCase();
  try {
    const response = await fetch(`https://www.roundhillinvestments.com/etf/${ticker}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    const html = await response.text();
    let rate = null;
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const script of scriptMatches) {
      const rateMatch = script.match(/"distributionRate"\s*:\s*"?([\d.]+)"?/) ||
                        script.match(/"distribution_rate"\s*:\s*"?([\d.]+)"?/) ||
                        script.match(/distributionRate['"]\s*:\s*['"]([\d.]+)/);
      if (rateMatch) { rate = parseFloat(rateMatch[1]); break; }
    }
    if (!rate) {
      try {
        const apiResp = await fetch(`https://www.roundhillinvestments.com/api/etf/${ticker}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        if (apiResp.ok) {
          const apiData = await apiResp.json();
          rate = apiData.distributionRate || apiData.distribution_rate || apiData.rate || null;
        }
      } catch(e) {}
    }
    res.json({
      ticker: ticker.toUpperCase(),
      distributionRate: rate,
      htmlLength: html.length,
      status: response.status,
      scriptCount: scriptMatches.length,
      scriptSample: scriptMatches.slice(0, 3).map(s => s.slice(0, 300))
    });
  } catch (e) {
    res.status(500).json({ error: e.message, ticker });
  }
});

app.get('/rates', async (req, res) => {
  const tickers = (req.query.tickers || 'hoow,xdte,aapw').split(',');
  const results = {};
  for (const ticker of tickers) {
    try {
      const response = await fetch(`https://www.roundhillinvestments.com/etf/${ticker.trim().toLowerCase()}/`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
      });
      const html = await response.text();
      let rate = null;
      const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
      for (const s of scripts) {
        const m = s.match(/"distributionRate"\s*:\s*"?([\d.]+)"?/) ||
                  s.match(/distributionRate['"]\s*:\s*['"]([\d.]+)/);
        if (m) { rate = parseFloat(m[1]); break; }
      }
      results[ticker.trim().toUpperCase()] = rate;
    } catch(e) {
      results[ticker.trim().toUpperCase()] = null;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  res.json({ rates: results, timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.listen(process.env.PORT || 3000);
