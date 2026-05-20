// ── ADD THIS TO server.js on Render ─────────────────────────────
// Place alongside the existing /roundhill and /yieldmax routes

app.get('/neos', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    // Search GlobeNewswire for the latest NEOS distribution announcement
    const searchUrl = 'https://www.globenewswire.com/RssFeed/subjectcode/28-Dividends%20and%20Distributions/industry/ETF';
    const searchResp = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    const rssText = await searchResp.text();

    // Find NEOS announcement link
    const neosMatch = rssText.match(/<link>([^<]+neos[^<]+)<\/link>/i)
                   || rssText.match(/<link><!\[CDATA\[([^\]]*neos[^\]]*)\]\]><\/link>/i);

    let articleUrl = null;
    if (neosMatch) {
      articleUrl = neosMatch[1];
    } else {
      // Fallback: search GNW directly
      const gnwSearch = await fetch('https://www.globenewswire.com/en/search/keyword/NEOS%20Investments%20Announces', {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000)
      });
      const gnwHtml = await gnwSearch.text();
      const linkMatch = gnwHtml.match(/href="(\/news-release\/\d{4}\/\d{2}\/\d{2}\/[^"]*neos[^"]*)">/i);
      if (linkMatch) articleUrl = 'https://www.globenewswire.com' + linkMatch[1];
    }

    if (!articleUrl) {
      return res.json({ error: 'No NEOS announcement found', etfs: [] });
    }

    // Fetch the article
    const articleResp = await fetch(articleUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    const html = await articleResp.text();

    // Parse ex-date and pay-date from headline/body
    const exMatch  = html.match(/[Ee]x[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);
    const payMatch = html.match(/[Pp]ay(?:able|ment)?[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);
    const declMatch= html.match(/[Dd]eclar(?:ed|ation)[.\-\s]*[Dd]ate[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/);

    const parseDate = (s) => {
      if (!s) return null;
      const d = new Date(s.replace(',',''));
      return isNaN(d) ? null : d.toISOString().split('T')[0];
    };

    // Parse ticker/amount table — lines like: SPYI  $0.5100  or BTCI 0.7934
    const etfs = [];
    const tickers = ['SPYI','QQQI','IWMI','QQQH','BTCI','HYBI','BNDI','CSHI','TLTI','IYRI','SPYH','IAUI','NIHI','NEHI','NLSI','MLPI','XSPI','XQQI','XBCI'];
    tickers.forEach(ticker => {
      const re = new RegExp(ticker + '[\\s\\S]{1,80}?\\$?\\s*(\\d+\\.\\d+)', 'i');
      const m = html.match(re);
      if (m) etfs.push({ ticker, amount: parseFloat(m[1]) });
    });

    res.json({
      exDate:   parseDate(exMatch?.[1]),
      payDate:  parseDate(payMatch?.[1]),
      declDate: parseDate(declMatch?.[1]),
      etfs,
      sourceUrl: articleUrl,
    });

  } catch (e) {
    res.status(500).json({ error: e.message, etfs: [] });
  }
});
