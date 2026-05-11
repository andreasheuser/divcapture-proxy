const express = require('express');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/rate/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const t = ticker.toLowerCase();
  const attempts = [];

  const endpoints = [
    `https://www.roundhillinvestments.com/api/v1/etf/${t}`,
    `https://www.roundhillinvestments.com/api/etfs/${t}`,
    `https://www.roundhillinvestments.com/api/fund/${t}`,
    `https://www.roundhillinvestments.com/api/funds/${t}`,
    `https://www.roundhillinvestments.com/etf/${t}/data.json`,
    `https://www.roundhillinvestments.com/etf/${t}/fund-data`,
    `https://www.roundhillinvestments.com/api/distribution/${t}`,
  ];

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
          'Accept': 'application/json, text/plain, */*',
          'Referer': `https://www.roundhillinvestments.com/etf/${t}/`,
        }
      });
      const text = await resp.text();
      attempts.push({ url, status: resp.status, preview: text.slice(0, 300) });
      if (resp.ok) {
        try {
          const data = JSON.parse(text);
          return res.json({ ticker, found: true, url, data });
        } catch(e) {}
      }
    } catch(e) {
      attempts.push({ url, error: e.message });
    }
  }

  res.json({ ticker, found: false, attempts });
});

app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.listen(process.env.PORT || 3000);
