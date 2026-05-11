const express = require('express');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Fetch latest Roundhill declaration from Cboe
// Tries the last 14 days to find the most recent declaration
app.get('/roundhill', async (req, res) => {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
    'Accept': 'text/html,application/xhtml+xml',
  };

  // Try each of the last 14 days to find the most recent declaration
  const today = new Date();
  let found = null;

  for (let daysBack = 0; daysBack <= 14; daysBack++) {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];
    const url = `https://www.cboe.com/us/equities/notices/dividends/details/?firm_name=Roundhill+Financial+Inc.&declaration_dt=${dateStr}`;

    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      const html = await resp.text();

      // Look for table rows with dividend data
      const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
      const results = [];

      for (const row of rows) {
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
          .map(c => c[1].replace(/<[^>]+>/g, '').trim());

        // Valid row has ticker, name, ex-date, record-date, payable-date, amount
        if (cells.length >= 6 && cells[0].match(/^[A-Z]{2,5}$/) && cells[2].match(/\d{4}-\d{2}-\d{2}/)) {
          results.push({
            ticker:       cells[0],
            name:         cells[1],
            exDate:       cells[2],
            recordDate:   cells[3],
            payableDate:  cells[4],
            amount:       parseFloat(cells[5].replace('$', '')),
            declaredDate: dateStr,
          });
        }
      }

      if (results.length > 0) {
        found = { declaredDate: dateStr, etfs: results };
        break;
      }
    } catch(e) {
      continue;
    }
  }

  if (found) {
    res.json(found);
  } else {
    res.status(404).json({ error: 'No Roundhill declaration found in last 14 days' });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(process.env.PORT || 3000);
