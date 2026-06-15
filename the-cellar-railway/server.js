const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wines (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS opened (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  console.log('Database ready.');
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Wines ─────────────────────────────────────────────────────────────
app.get('/api/wines', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM wines ORDER BY updated_at DESC');
    res.json(r.rows.map(r => r.data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wines', async (req, res) => {
  try {
    const wine = req.body;
    await pool.query(
      `INSERT INTO wines (id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()`,
      [wine.id, JSON.stringify(wine)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/wines/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM wines WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Opened ────────────────────────────────────────────────────────────
app.get('/api/opened', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM opened ORDER BY updated_at DESC');
    res.json(r.rows.map(r => r.data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/opened', async (req, res) => {
  try {
    const entry = req.body;
    await pool.query(
      `INSERT INTO opened (id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()`,
      [entry.id, JSON.stringify(entry)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/opened/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM opened WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Settings (stores Anthropic API key server-side) ───────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM settings');
    const obj = {};
    r.rows.forEach(row => obj[row.key] = row.value);
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value=$2`,
      [key, value]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Helper: get Gemini key ─────────────────────────────────────────────────
async function getGeminiKey() {
  let key = process.env.GEMINI_API_KEY || '';
  if (!key) {
    const r = await pool.query("SELECT value FROM settings WHERE key='gemini_key'");
    if (r.rows.length > 0) key = r.rows[0].value;
  }
  return key;
}

// ── Helper: call Gemini ────────────────────────────────────────────────────
async function callGemini(parts, useSearch = true) {
  const key = await getGeminiKey();
  if (!key) throw new Error('No Gemini API key configured.');

  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);

  // Extract text parts only (skip search result parts)
  const txt = d.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '{}';

  return JSON.parse(txt.replace(/```json|```/g, '').trim());
}

// ── API: Text wine lookup with Google Search ───────────────────────────────
app.post('/api/lookup', async (req, res) => {
  try {
    const { query } = req.body;
    const prompt = `You are a kosher wine expert. Search Google for this wine: "${query}"

Search kosherwine.com and royalwine.com and any other wine sites for information.

Return ONLY valid JSON (no markdown, no explanation):
{"company":"winery brand name","wine":"label/line name (not the varietal)","varietal":"grape varietal","vintage":"year string or empty","region":"country","rPrice":"retail price as number string or empty","mevushal":"Y or N","drinkFrom":"earliest drink year or empty","drinkUntil":"latest drink year or empty","notes":"1-2 sentence tasting notes","confidence":"high/medium/low","source":"kosherwine.com or royalwine.com or web search"}

Rules: company=brand only (Barkan/Psagot/Yatir/Hagafen). wine=label name (Superieur/Forest/Peak). Israeli wines are almost always Mevushal.`;

    const result = await callGemini([{ text: prompt }], true);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Barcode UPC proxy (avoids CORS in browser) ─────────────────────────────
app.get('/api/barcode/:code', async (req, res) => {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${req.params.code}.json`);
    const d = await r.json();
    if (d.status === 1 && d.product) {
      const name = (d.product.product_name || d.product.brands || '').trim();
      res.json({ found: true, name });
    } else {
      res.json({ found: false, name: '' });
    }
  } catch (e) { res.json({ found: false, name: '' }); }
});

// ── API: Photo label recognition — Gemini vision + Google Search ───────────
app.post('/api/photo-lookup', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });

    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const prompt = `You are a kosher wine expert. Look carefully at this wine bottle label photo.

First read everything visible on the label. Then search Google to find more details about this specific wine on kosherwine.com, royalwine.com, or other wine sites — especially for price, drink window, and tasting notes.

Return ONLY valid JSON (no markdown, no explanation):
{"company":"winery/producer brand name","wine":"wine line or label name (not the varietal)","varietal":"grape varietal","vintage":"year as string or empty","region":"country or wine region","rPrice":"retail price as number string or empty","mevushal":"Y or N","drinkFrom":"earliest drink year or empty","drinkUntil":"latest drink year or empty","notes":"tasting notes from label or web search","confidence":"high/medium/low","source":"label + web search"}

Rules:
- company = winery/producer (e.g. Barkan, Yatir, Psagot, Hagafen, Golan Heights Winery)
- wine = label/line name (e.g. Superieur, Forest, Peak, Reserve) — NOT the grape variety
- Israeli wines are almost always Mevushal unless clearly boutique
- confidence: high if label is clear and confirmed by web, low if blurry or uncertain`;

    const result = await callGemini([
      { inline_data: { mime_type: mimeType, data: base64 } },
      { text: prompt }
    ], true);

    res.json(result);
  } catch (e) {
    console.error('Photo lookup error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Bulk import from xlsx/csv ─────────────────────────────────────────
app.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });

    // Find where the "Opened" section starts (row with Company='Opened')
    const openedIdx = raw.findIndex(r =>
      String(r['Company']||r['Opened']||'').trim().toLowerCase() === 'opened'
    );

    const inventoryRows = openedIdx > 0 ? raw.slice(0, openedIdx) : raw;
    const openedRows    = openedIdx > 0 ? raw.slice(openedIdx + 1) : [];

    // ── Map column names from the spreadsheet ──────────────────────────────
    // The DB.xlsx columns: Company, Wine, Varietal, Vintage, P Paid, Store,
    //   .1 (Region), R Price, Mevushal, Qty, Wine Cooler, Schelf,
    //   Qty.1, Wine Cooler.1, Schelf.1, Qty.2, Wine Cooler.2, Schelf.2,
    //   Drinking Window, Untill, QPR GG
    // Also supports Google Sheets export with same/similar headers.

    const str = v => String(v||'').trim();
    const num = v => { const n=Number(v); return isNaN(n)?'':String(n); };

    // Group inventory rows by wine identity (Company+Wine+Varietal+Vintage)
    // Each row = 1 bottle in his spreadsheet, so we sum quantities per unique wine
    const wineMap = new Map();

    for (const row of inventoryRows) {
      const company  = str(row['Company']);
      const wine     = str(row['Wine']);
      const varietal = str(row['Varietal']);
      const vintage  = str(row['Vintage']);

      if (!company || !wine || company.toLowerCase() === 'company') continue; // skip header repeats

      const key = `${company}||${wine}||${varietal}||${vintage}`;

      if (!wineMap.has(key)) {
        wineMap.set(key, {
          id: Date.now().toString() + Math.random().toString(36).slice(2,6),
          company,
          wine,
          varietal,
          vintage,
          pPaid:     num(row['P Paid']),
          store:     str(row['Store']),
          region:    str(row[' .1'] || row['Region'] || row['.1']),
          rPrice:    num(row['R Price']),
          mevushal:  str(row['Mevushal']).toUpperCase() === 'Y' ? 'Y' : 'N',
          // Storage slot 1 — accumulate quantities
          qty1: 0, cooler1: str(row['Wine Cooler']), shelf1: str(row['Schelf'] || row['Shelf']),
          qty2: 0, cooler2: str(row['Wine Cooler.1']), shelf2: str(row['Schelf.1'] || row['Shelf.1']),
          qty3: 0, cooler3: str(row['Wine Cooler.2']), shelf3: str(row['Schelf.2'] || row['Shelf.2']),
          drinkFrom:  num(row['Drinking Window']),
          drinkUntil: num(row['Untill'] || row['Until']),
          qprGG:      num(row['QPR GG'] || row['QPR']),
          notes: str(row['Notes'] || row['notes'] || ''),
        });
      }

      // Each row is one bottle — add to the appropriate slot count
      const entry = wineMap.get(key);
      const slotQty = Number(row['Qty']) || 1;
      if (str(row['Wine Cooler']) && str(row['Wine Cooler']) === entry.cooler1) {
        entry.qty1 += slotQty;
      } else if (str(row['Wine Cooler.1']) && str(row['Wine Cooler.1']) === entry.cooler2) {
        entry.qty2 += slotQty;
      } else if (str(row['Wine Cooler.2'])) {
        entry.qty3 += slotQty;
      } else {
        entry.qty1 += slotQty;
      }
    }

    // Convert qty numbers to strings
    const importedWines = [...wineMap.values()].map(w => ({
      ...w,
      qty1: w.qty1 > 0 ? String(w.qty1) : '',
      qty2: w.qty2 > 0 ? String(w.qty2) : '',
      qty3: w.qty3 > 0 ? String(w.qty3) : '',
    }));

    // ── Map opened rows ────────────────────────────────────────────────────
    const importedOpened = openedRows
      .filter(row => str(row['Company']) && str(row['Wine']) && str(row['Company']).toLowerCase() !== 'company')
      .map(row => ({
        id: Date.now().toString() + Math.random().toString(36).slice(2,6),
        dateOpened: str(row['Opened'] || row['Date'] || row['Date Opened'] || ''),
        company:    str(row['Company']),
        wine:       str(row['Wine']),
        varietal:   str(row['Varietal']),
        vintage:    str(row['Vintage']),
        pPaid:      num(row['P Paid']),
        store:      str(row['Store']),
        region:     str(row['Region'] || row[' .1'] || row['.1']),
        rPrice:     num(row['R Price']),
        mevushal:   str(row['Mevushal']).toUpperCase() === 'Y' ? 'Y' : 'N',
        notes:      str(row['Notes'] || ''),
      }));

    // ── Save to database ───────────────────────────────────────────────────
    let winesSaved = 0, openedSaved = 0;

    for (const w of importedWines) {
      await pool.query(
        `INSERT INTO wines (id, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()`,
        [w.id, JSON.stringify(w)]
      );
      winesSaved++;
    }
    for (const o of importedOpened) {
      await pool.query(
        `INSERT INTO opened (id, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()`,
        [o.id, JSON.stringify(o)]
      );
      openedSaved++;
    }

    res.json({
      ok: true,
      winesImported: winesSaved,
      openedImported: openedSaved,
      wines: importedWines,
      opened: importedOpened,
    });

  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({ error: e.message });
  }
});


app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`The Cellar running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
