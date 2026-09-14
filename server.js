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

// ── ROUNDHILL: Cboe scraper (21-day window handles holiday shifts) ─
app.get('/roundhill', async (req, res) => {
  const today = new Date();
  const allEtfs = {};

  for (let daysBack = 0; daysBack <= 21; daysBack++) {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];
    const url = `https://www.cboe.com/us/equities/notices/dividends/details/?declaration_dt=${dateStr}&firm_name=Roundhill+Financial+Inc.`;

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
              source: 'cboe',
            };
          }
        }
      }
    } catch(e) { continue; }
    await new Promise(r => setTimeout(r, 100));
  }

  const etfs = Object.values(allEtfs).sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (etfs.length > 0) {
    return res.json({ count: etfs.length, etfs });
  }

  return res.status(404).json({ error: 'No Roundhill declarations found on Cboe in last 21 days', etfs: [] });
});

// ── YIELDMAX: Fetch latest Group 1 and Group 2 from GlobeNewsWire ─
app.get('/yieldmax', async (req, res) => {
  try {
    const tagPage = await fetch('https://www.globenewswire.com/search/tag/yieldmax', {
      headers: HEADERS, signal: AbortSignal.timeout(10000)
    });
    const tagHtml = await tagPage.text();

    const urlMatches = [...tagHtml.matchAll(/href="(\/news-release\/202[0-9]\/\d{2}\/\d{2}\/[^"]*yieldmax[^"]*group[^"]*etfs[^"]*\.html)"/gi)];
    const urls = [...new Set(urlMatches.map(m => 'https://www.globenewswire.com' + m[1]))];

    const results = { group1: null, group2: null };

    for (const url of urls.slice(0, 10)) {
      try {
        const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        const html = await resp.text();

        const isGroup1 = /group\s*1/i.test(html) && !/group\s*2/i.test(html.slice(0, 5000));
        const isGroup2 = /group\s*2/i.test(html.slice(0, 5000));
        const isUpdate = /UPDATE/i.test(html.slice(0, 2000));

        const etfs = parseDistributionTable(html, url);
        if (!etfs.length) continue;

        const exMatch  = html.match(/Ex\.\s*&amp;\s*Record Date[:\s]*([A-Z][a-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
        const payMatch = html.match(/Payment Date[:\s]*([A-Z][a-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
        const exDate   = exMatch  ? parseDate(exMatch[1])  : null;
        const payDate  = payMatch ? parseDate(payMatch[1]) : null;

        const data = { etfs, exDate, payDate, url, isUpdate };

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

// ── NEOS: Fetch latest monthly distribution from BusinessWire ────
app.get('/neos', async (req, res) => {
  try {
    // Search BusinessWire for latest NEOS announcement
    const searchResp = await fetch('https://www.businesswire.com/rss/home/?rss=G22&rssid=20090908882174', {
      headers: HEADERS, signal: AbortSignal.timeout(15000)
    });
    const rssText = await searchResp.text();

    // Find NEOS distribution announcement link
    const linkMatch = rssText.match(/<link>([^<]*NEOS-Investments-Announces[^<]*ETF[^<]*)<\/link>/i)
                   || rssText.match(/<link><![CDATA[([^\]]*NEOS-Investments-Announces[^\]]*ETF[^\]]*)]]+><\/link>/i);

    let articleUrl = linkMatch ? linkMatch[1].trim() : null;

    // Fallback: search BusinessWire newsroom directly
    if (!articleUrl) {
      const bwSearch = await fetch('https://www.businesswire.com/newsroom/finance/?keyword=NEOS+Investments+Announces', {
        headers: HEADERS, signal: AbortSignal.timeout(15000)
      });
      const bwHtml = await bwSearch.text();
      const hrefMatch = bwHtml.match(/href="(\/news\/home\/\d+\/en\/NEOS-Investments-Announces[^"]*ETF[^"]*)"/i);
      if (hrefMatch) articleUrl = 'https://www.businesswire.com' + hrefMatch[1];
    }

    if (!articleUrl) {
      return res.json({ error: 'No NEOS announcement found on BusinessWire', etfs: [] });
    }

    const articleResp = await fetch(articleUrl, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const html = await articleResp.text();

    const parseDateStr = (s) => {
      if (!s) return null;
      const d = new Date(s.replace(',', ''));
      return isNaN(d) ? null : d.toISOString().split('T')[0];
    };

    // Parse table rows: ticker in bold/cell, then amount column "$X.XXXX"
    const etfs = [];
    const tickers = ['SPYI','QQQI','IWMI','QQQH','BTCI','HYBI','BNDI','CSHI','TLTI','IYRI','SPYH','IAUI','NIHI','NEHI','NLSI','MLPI','XSPI','XQQI','XBCI'];
    
    // BusinessWire table format: ticker appears in bold inside cell, amount in next cells
    // Pattern: TICKER ... $X.XXXX ... Ex-Dividend Date
    tickers.forEach(ticker => {
      // Look for ticker followed by dollar amount within ~300 chars
      const re = new RegExp('\\b' + ticker + '\\b[\\s\\S]{1,300}?\\$?(\\d+\\.\\d{4})', 'i');
      const m = html.match(re);
      if (m) {
        // Also grab ex-date for this ticker (format: M/D/YYYY or Month D, YYYY)
        const exRe = new RegExp('\\b' + ticker + '\\b[\\s\\S]{1,400}?(\\d{1,2}\\/\\d{1,2}\\/\\d{4})', 'i');
        const exM = html.match(exRe);
        const exDate = exM ? parseDateStr(exM[1]) : null;
        etfs.push({ ticker, amount: parseFloat(m[1]), exDate });
      }
    });

    // Get declaration date from article publish date
    const declMatch = html.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
    const declDate = declMatch ? parseDateStr(declMatch[0]) : null;

    res.json({
      etfs,
      declDate,
      sourceUrl: articleUrl,
    });

  } catch(e) {
    res.status(500).json({ error: e.message, etfs: [] });
  }
});

// ── PRICE HISTORY: 90 days daily OHLC via Yahoo Finance ──────────
app.get('/history/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3mo`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    const json = await resp.json();
    const result = json?.chart?.result?.[0];
    if (!result) return res.json({ ticker, prices: [] });

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    const prices = [];
    timestamps.forEach((ts, i) => {
      if (closes[i] != null) {
        prices.push({
          date: new Date(ts * 1000).toISOString().split('T')[0],
          close: Math.round(closes[i] * 10000) / 10000,
        });
      }
    });

    res.json({ ticker, prices });
  } catch(e) {
    res.status(500).json({ ticker, prices: [], error: e.message });
  }
});

// Parse distribution table from GlobeNewsWire HTML
function parseDistributionTable(html, url) {
  const etfs = [];
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim());

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
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d&includePrePost=true`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
    const json = await resp.json();
    const meta  = json?.chart?.result?.[0]?.meta;
    const price = meta?.postMarketPrice || meta?.preMarketPrice || meta?.regularMarketPrice || null;
    res.json({ ticker, price, isExtended: !!(meta?.postMarketPrice || meta?.preMarketPrice) });
  } catch(e) {
    res.status(500).json({ ticker, price: null, error: e.message });
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(process.env.PORT || 3000);
