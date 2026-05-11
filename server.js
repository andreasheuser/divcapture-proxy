const express = require('express');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Fetch a single ticker's distribution rate from Roundhill
app.get('/rate/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toLowerCase();
  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    await page.goto(`https://www.roundhillinvestments.com/etf/${ticker}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await page.waitForSelector('body', { timeout: 10000 });

    const data = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const distMatch = bodyText.match(/Distribution Rate[\s\S]{0,100}?(\d+\.?\d+)%/i);
      const rate = distMatch ? parseFloat(distMatch[1]) : null;
      const idx = bodyText.toLowerCase().indexOf('distribution rate');
      const context = idx > -1 ? bodyText.slice(Math.max(0, idx - 20), idx + 150) : 'not found';
      return { rate, context, bodyLength: bodyText.length };
    });

    await browser.close();
    res.json({
      ticker: ticker.toUpperCase(),
      distributionRate: data.rate,
      context: data.context,
      bodyLength: data.bodyLength
    });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: e.message, ticker });
  }
});

// Fetch multiple tickers at once
app.get('/rates', async (req, res) => {
  const tickers = (req.query.tickers || 'hoow,xdte,qdte,aapw,nvdw,tslw').split(',');
  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const results = {};
    for (const ticker of tickers) {
      try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        await page.goto(`https://www.roundhillinvestments.com/etf/${ticker.trim().toLowerCase()}/`, {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await page.waitForSelector('body', { timeout: 10000 });

        const data = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          const distMatch = bodyText.match(/Distribution Rate[\s\S]{0,100}?(\d+\.?\d+)%/i);
          return { rate: distMatch ? parseFloat(distMatch[1]) : null };
        });

        results[ticker.trim().toUpperCase()] = data.rate;
        await page.close();
      } catch (e) {
        results[ticker.trim().toUpperCase()] = null;
      }
    }

    await browser.close();
    res.json({ rates: results, timestamp: new Date().toISOString() });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(process.env.PORT || 3000);
