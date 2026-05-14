const express = require('express');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
  'Accept': 'text/html,application/xhtml+xml',
};

// ── ROUNDHILL: Fetch all declarations from last 14 days ──────────
app.get('/roundhill', async (req, res) => {
  const today = new Date();
  const allEtfs = {};

  for (let daysBack = 0; daysBack <= 14; daysBack++) {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];
    const url = `https://www.cboe.com/us/equities/notices/dividends/details/?firm_name=Roundhill+Financial+Inc.&declaration_dt=${dateStr}`;

    try {
      const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      const html = await resp.text();
      const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

      for (const row of rows) {
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
          .map(c => c[1].replace(/<[^>]+>/g, '').trim());
        if (cells.length >= 6 && cells[0].match(/^[A-Z]{2,5}$/) && cells[2].match(/\d{4}-\d{2}-\d{2}/)) {
          if (!allEtfs[cells[0]]) {
            allEtfs[cells[0]] = {
              ticker: cells[0], name: cells[1],
              exDate: cells[2], recordDate: cells[3],
              payableDate: cells[4], amount: parseFloat(cells[5].replace('$', '')),
              declaredDate: dateStr,
            };
          }
        }
      }
    } catch(e) { continue; }
    await new Promise(r => setTimeout(r, 100));
  }

  const etfs = Object.values(allEtfs).sort((a, b) => a.ticker.localeCompare(b.ticker));
  etfs.length > 0
    ? res.json({ count: etfs.length, etfs })
    : res.status(404).json({ error: 'No Roundhill declarations found in last 14 days' });
});

// ── YIELDMAX: Fetch latest Group 1 and Group 2 from GlobeNewsWire ─
app.get('/yieldmax', async (req, res) => {
  try {
    // Step 1: Get the YieldMax tag page to find the latest announcement URLs
    const tagPage = await fetch('https://www.globenewswire.com/search/tag/yieldmax', {
      headers: HEADERS, signal: AbortSignal.timeout(10000)
    });
    const tagHtml = await tagPage.text();

    // Find all YieldMax distribution announcement URLs from last 7 days
    const urlMatches = [...tagHtml.matchAll(/href="(\/news-release\/202[0-9]\/\d{2}\/\d{2}\/[^"]*yieldmax[^"]*group[^"]*etfs[^"]*\.html)"/gi)];
    const urls = [...new Set(urlMatches.map(m => 'https://www.globenewswire.com' + m[1]))];

    const results = { group1: null, group2: null };

    // Step 2: Fetch each URL and parse the distribution table
    for (const url of urls.slice(0, 10)) { // check last 10 URLs max
      try {
        const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        const html = await resp.text();

        // Determine if Group 1 or Group 2
        const isGroup1 = /group\s*1/i.test(html) && !/group\s*2/i.test(html.slice(0, 5000));
        const isGroup2 = /group\s*2/i.test(html.slice(0, 5000));
        const isUpdate = /UPDATE/i.test(html.slice(0, 2000));

        // Parse distribution table
        const etfs = parseDistributionTable(html, url);
        if (!etfs.length) continue;

        // Extract ex-date and pay-date
        const exMatch  = html.match(/Ex\.\s*&amp;\s*Record Date[:\s]*([A-Z][a-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
        const payMatch = html.match(/Payment Date[:\s]*([A-Z][a-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
        const exDate   = exMatch  ? parseDate(exMatch[1])  : null;
        const payDate  = payMatch ? parseDate(payMatch[1]) : null;

        const data = { etfs, exDate, payDate, url, isUpdate };

        // Prefer UPDATE over original for Group 1
        if (isGroup1 && (!results.group1 || isUpdate)) results.group1 = data;
        if (isGroup2 && !results.group2) results.group2 = data;

        if (results.group1 && results.group2) break;
      } catch(e) { continue; }
      await new Promise(r => setTimeout(r, 200));
    }

    res.json({
      group1: results.group1,
      group2: results.group2,
      fetchedAt: new Date().toISOString()
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse distribution table from GlobeNewsWire HTML
function parseDistributionTable(html, url) {
  const etfs = [];
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim());

    // Valid row: ticker (2-5 uppercase letters) + dollar amount
    if (cells.length >= 4) {
      const ticker = cells[0].replace(/\*/g,'').trim();
      const amountCell = cells.find(c => /^\$[\d.]+$/.test(c.trim()));
      const rateCell   = cells.find(c => /^[\d.]+%$/.test(c.trim()));

      if (ticker.match(/^[A-Z]{2,5}$/) && amountCell) {
        etfs.push({
          ticker,
          amount: parseFloat(amountCell.replace('$','')),
          rate:   rateCell ? parseFloat(rateCell.replace('%','')) : null,
        });
      }
    }
  }
  return etfs;
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : d.toISOString().split('T')[0];
}

// ── PRICE FALLBACK: Yahoo Finance ────────────────────────────────
app.get('/price/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
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
