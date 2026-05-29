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

// ── ROUNDHILL: PRNewswire ────────────────────────────────────────
app.get('/roundhill', async (req, res) => {
  try {
    const searchResp = await fetch('https://www.prnewswire.com/rss/news-releases-list.rss?category=roundhill', {
      headers: HEADERS, signal: AbortSignal.timeout(15000)
    });
    let articleUrl = null;

    if (searchResp.ok) {
      const rssText = await searchResp.text();
      const linkMatch = rssText.match(/<link>([^<]*roundhill[^<]*declares[^<]*)<\/link>/i)
                     || rssText.match(/<link><!\[CDATA\[([^\]]*roundhill[^\]]*declares[^\]]*)\]\]><\/link>/i);
      if (linkMatch) articleUrl = linkMatch[1];
    }

    // Fallback: search PRNewswire directly
    if (!articleUrl) {
      const searchPage = await fetch('https://www.prnewswire.com/news-releases/news-releases-list.html?company=roundhill', {
        headers: HEADERS, signal: AbortSignal.timeout(15000)
      });
      const searchHtml = await searchPage.text();
      const linkMatch = searchHtml.match(/href="(\/news-releases\/[^"]*roundhill[^"]*declares[^"]*\.html)"/i)
                     || searchHtml.match(/href="(\/news-releases\/[^"]*roundhill[^"]*distribution[^"]*\.html)"/i);
      if (linkMatch) articleUrl = 'https://www.prnewswire.com' + linkMatch[1];
    }

    if (!articleUrl) {
      return res.status(404).json({ error: 'No Roundhill declarations found on PRNewswire', etfs: [] });
    }
    const articleResp = await fetch(articleUrl, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const html = await articleResp.text();

    const exMatch   = html.match(/[Ee]x[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);
    const payMatch  = html.match(/[Pp]ay(?:able|ment)?[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);
    const declMatch = html.match(/[Dd]eclar(?:ed|ation)[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);

    const parseDateStr = (s) => {
      if (!s) return null;
      const d = new Date(s.replace(',', ''));
      return isNaN(d) ? null : d.toISOString().split('T')[0];
    };

    const exDate       = parseDateStr(exMatch?.[1]);
    const payableDate  = parseDateStr(payMatch?.[1]);
    const declaredDate = parseDateStr(declMatch?.[1]);

    const gnwEtfs = [];
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(c => c[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim());
      if (cells.length >= 2) {
        const ticker = cells[0].replace(/\*/g,'').trim();
        const amountCell = cells.find(c => /^\$?[\d.]+$/.test(c.trim()));
        if (ticker.match(/^[A-Z]{2,5}$/) && amountCell) {
          gnwEtfs.push({
            ticker,
            name: ticker,
            exDate,
            payableDate,
            declaredDate,
            amount: parseFloat(amountCell.replace('$','')),
            source: 'globenewswire',
          });
        }
      }
    }

    if (gnwEtfs.length > 0) {
      return res.json({ count: gnwEtfs.length, etfs: gnwEtfs, sourceUrl: articleUrl });
    }

    res.status(404).json({ error: 'No Roundhill declarations found on PRNewswire', etfs: [] });

  } catch(e) {
    res.status(500).json({ error: e.message, etfs: [] });
  }
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

// ── NEOS: Fetch latest monthly distribution from GlobeNewsWire ───
app.get('/neos', async (req, res) => {
  try {
    const gnwSearch = await fetch('https://www.globenewswire.com/en/search/keyword/NEOS%20Investments%20Announces', {
      headers: HEADERS, signal: AbortSignal.timeout(15000)
    });
    const gnwHtml = await gnwSearch.text();

    const linkMatch = gnwHtml.match(/href="(\/news-release\/\d{4}\/\d{2}\/\d{2}\/[^"]*neos[^"]*)">/i);
    if (!linkMatch) {
      return res.json({ error: 'No NEOS announcement found', etfs: [] });
    }

    const articleUrl = 'https://www.globenewswire.com' + linkMatch[1];
    const articleResp = await fetch(articleUrl, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const html = await articleResp.text();

    const exMatch   = html.match(/[Ee]x[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);
    const payMatch  = html.match(/[Pp]ay(?:able|ment)?[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);
    const declMatch = html.match(/[Dd]eclar(?:ed|ation)[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);

    const parseDateStr = (s) => {
      if (!s) return null;
      const d = new Date(s.replace(',', ''));
      return isNaN(d) ? null : d.toISOString().split('T')[0];
    };

    const etfs = [];
    const tickers = ['SPYI','QQQI','IWMI','QQQH','BTCI','HYBI','BNDI','CSHI','TLTI','IYRI','SPYH','IAUI','NIHI','NEHI','NLSI','MLPI','XSPI','XQQI','XBCI'];
    tickers.forEach(ticker => {
      const re = new RegExp(ticker + '[\\s\\S]{1,80}?\\$?\\s*(\\d+\\.\\d+)', 'i');
      const m = html.match(re);
      if (m) etfs.push({ ticker, amount: parseFloat(m[1]) });
    });

    res.json({
      exDate:    parseDateStr(exMatch?.[1]),
      payDate:   parseDateStr(payMatch?.[1]),
      declDate:  parseDateStr(declMatch?.[1]),
      etfs,
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
