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
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
    });
    const html = await response.text();
    const match = html.match(/(\d+\.?\d+)%/g);
    res.json({ ticker: ticker.toUpperCase(), html_length: html.length, rates_found: match?.slice(0,10) || [], status: response.status });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(process.env.PORT || 3000);
