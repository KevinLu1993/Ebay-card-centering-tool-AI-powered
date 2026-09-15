import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));
const PORT = process.env.PORT || 3001;

// ── eBay OAuth token (cached) ──────────────────────────────────────────────────
let ebayToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  if (ebayToken && Date.now() < tokenExpiry) return ebayToken;
  const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) throw new Error(`eBay auth failed: ${await res.text()}`);
  const data = await res.json();
  ebayToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return ebayToken;
}

// ── Upgrade eBay image URL to highest available resolution ────────────────────
function upgradeImageUrl(url) {
  if (!url) return url;
  // eBay image URLs use s-l{size} pattern — upgrade to 1600px
  return url
    .replace(/s-l\d+\.jpg/i, 's-l1600.jpg')
    .replace(/s-l\d+\.png/i, 's-l1600.png')
    .replace(/s-l\d+\.webp/i, 's-l1600.webp')
    // Also handle thumbs subdomain -> images subdomain
    .replace('thumbs.ebaystatic.com', 'i.ebayimg.com')
    .replace('/thumbs/', '/');
}

// ── Search listings ────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const { q, mode = 'raw', minPrice, maxPrice, minRating, minFeedback, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query param q' });
    const token = await getEbayToken();
    const filters = [];
    if (minPrice && maxPrice) filters.push(`price:[${minPrice}..${maxPrice}],priceCurrency:USD`);
    else if (minPrice) filters.push(`price:[${minPrice}..],priceCurrency:USD`);
    else if (maxPrice) filters.push(`price:[..${maxPrice}],priceCurrency:USD`);
    if (mode === 'ag') filters.push('authenticityVerificationStatus:VERIFIED');
    const params = new URLSearchParams({ q, category_ids: '183454', limit, ...(filters.length ? { filter: filters.join(',') } : {}) });
    const searchRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US', 'Content-Type': 'application/json' },
    });
    if (!searchRes.ok) throw new Error(`eBay search failed: ${await searchRes.text()}`);
    const data = await searchRes.json();
    let items = data.itemSummaries || [];
    if (minRating || minFeedback) {
      items = items.filter(item => {
        const s = item.seller || {};
        if (minRating && (s.feedbackPercentage || 0) < parseFloat(minRating)) return false;
        if (minFeedback && (s.feedbackScore || 0) < parseInt(minFeedback)) return false;
        return true;
      });
    }
    const listings = items.map(item => ({
      id: item.itemId,
      title: item.title,
      price: item.price?.value || '0',
      currency: item.price?.currency || 'USD',
      imageUrl: upgradeImageUrl(item.image?.imageUrl) || null,
      url: item.itemWebUrl,
      condition: item.condition,
      sellerRating: parseFloat(item.seller?.feedbackPercentage || 0),
      feedbackCount: parseInt(item.seller?.feedbackScore || 0),
      isAG: !!item.authenticityVerification,
    }));
    res.json({ total: data.total || 0, listings });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Get all images for a listing ───────────────────────────────────────────────
app.get('/api/item-images', async (req, res) => {
  try {
    const { itemId } = req.query;
    if (!itemId) return res.status(400).json({ error: 'Missing itemId' });
    const token = await getEbayToken();
    const itemRes = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US', 'Content-Type': 'application/json' },
    });
    if (!itemRes.ok) throw new Error(`eBay getItem failed: ${await itemRes.text()}`);
    const data = await itemRes.json();
    const images = [];
    if (data.image?.imageUrl) images.push(upgradeImageUrl(data.image.imageUrl));
    if (data.additionalImages) {
      data.additionalImages.forEach(img => {
        const upgraded = upgradeImageUrl(img.imageUrl);
        if (upgraded && !images.includes(upgraded)) images.push(upgraded);
      });
    }
    res.json({ images });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Proxy image as base64 ──────────────────────────────────────────────────────
app.get('/api/image', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url param' });

    // Try the upgraded URL first, fall back to original
    const urls = [url, url.replace('s-l1600', 's-l500'), url.replace('s-l1600', 's-l400')];
    let lastErr;

    for (const tryUrl of urls) {
      try {
        const imgRes = await fetch(tryUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/webp,image/apng,image/jpeg,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.ebay.com/',
            'sec-fetch-dest': 'image',
            'sec-fetch-mode': 'no-cors',
          }
        });
        if (!imgRes.ok) { lastErr = new Error(`${imgRes.status}`); continue; }
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        // Make sure it's actually an image
        if (!contentType.startsWith('image/')) { lastErr = new Error(`Not an image: ${contentType}`); continue; }
        const buffer = await imgRes.arrayBuffer();
        if (buffer.byteLength < 1000) { lastErr = new Error('Image too small'); continue; }
        console.log(`Image fetched: ${tryUrl} (${buffer.byteLength} bytes, ${contentType})`);
        return res.json({ base64: Buffer.from(buffer).toString('base64'), mediaType: contentType.split(';')[0] });
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All image URLs failed');
  } catch (err) { console.error('Image fetch error:', err.message); res.status(500).json({ error: err.message }); }
});

// ── Analyze centering via Claude vision ───────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { base64, mediaType, side = 'front' } = req.body;
    if (!base64) return res.status(400).json({ error: 'Missing base64 image' });

    const prompt = side === 'front'
      ? `You are a trading card grading expert analyzing centering of a trading card front.

Look at the white/colored borders around the card artwork and estimate:
- lr: percentage of horizontal border space on the LEFT side (50=perfect, >50=left-heavy, <50=right-heavy)
- tb: percentage of vertical border space on the TOP (50=perfect, >50=top-heavy, <50=bottom-heavy)
- score: 0-100 centering score. Formula: 100 - abs(lr-50) - abs(tb-50), minus 5 extra if either axis is off by more than 15pts
- notes: 1 sentence describing what you see
- inSlab: true if the card is inside a PSA/BGS/CGC graded slab or acrylic one-touch holder

Important:
- If the card IS in a slab or holder, measure the card borders INSIDE the holder — ignore the holder edges
- Be aggressive about estimating borders even if the image is not perfect — only return score=0 if you truly cannot see ANY card borders at all (e.g. pure white stock image with no card visible)
- Most eBay listing photos DO show a real card, even if slightly blurry or angled — do your best

Respond ONLY with valid JSON, no markdown fences:
{"lr": number, "tb": number, "score": number, "notes": "string", "inSlab": boolean}`
      : `You are a trading card grading expert analyzing the BACK of a trading card.

Look at the borders around the card back design and estimate:
- lr: percentage of horizontal border space on the LEFT (50=perfect)
- tb: percentage of vertical border space on the TOP (50=perfect)
- score: 0-100. PSA grades backs more leniently — use formula: 100 - max(0, abs(lr-50)-25) - max(0, abs(tb-50)-25). So 75/25 ratio scores 100, only outside that gets penalized.
- notes: 1 sentence. Note if it meets PSA 10 back standard (75/25 is acceptable)
- meetsBackStandard: true if lr is between 25 and 75 AND tb is between 25 and 75

Important:
- If card is in a slab/holder, measure the card borders INSIDE the holder
- Only return score=0 if you truly cannot see any card borders at all
- If this appears to be a front image (not a back), set score=0 and notes="Front image detected, not back."

Respond ONLY with valid JSON, no markdown fences:
{"lr": number, "tb": number, "score": number, "notes": "string", "meetsBackStandard": boolean}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
        ]}],
      }),
    });
    if (!claudeRes.ok) throw new Error(`Claude API failed: ${await claudeRes.text()}`);
    const claudeData = await claudeRes.json();
    const raw = claudeData.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    console.log(`Analyzed ${side}:`, raw);
    res.json(JSON.parse(raw));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Analyze whitening on back of card ─────────────────────────────────────────
app.post('/api/whitening', async (req, res) => {
  try {
    const { base64, mediaType } = req.body;
    if (!base64) return res.status(400).json({ error: 'Missing base64 image' });

    const prompt = `You are a professional trading card grader inspecting the BACK of a trading card for whitening.

Whitening refers to white stress marks or scuffs on the card's edges and corners, typically caused by handling, shuffling, or poor storage. It shows up as white or light-colored marks on what should be a solid colored border or surface.

Carefully inspect the card back and assess:
1. severity: "none" | "minimal" | "moderate" | "heavy"
   - none: No whitening visible anywhere
   - minimal: Very slight whitening on 1-2 corners or edges, barely noticeable, PSA 9-10 still possible
   - moderate: Noticeable whitening on multiple corners/edges, likely PSA 7-8 range
   - heavy: Significant whitening across corners/edges, PSA 6 or below
2. locations: array of where whitening is found. Options: "top-left corner", "top-right corner", "bottom-left corner", "bottom-right corner", "top edge", "bottom edge", "left edge", "right edge", "surface". Empty array if none.
3. grade_impact: Estimated PSA grade impact. "none", "minor" (loses 0-1 grade), "moderate" (loses 1-2 grades), "severe" (loses 2+ grades)
4. notes: 1-2 sentences describing what you see
5. psa10_possible: true if whitening is unlikely to prevent a PSA 10

Rules:
- If card is in a slab/holder, inspect the card itself not the holder
- If the image is unclear or too dark to assess: severity="unknown", locations=[], grade_impact="unknown", notes="Image too unclear to assess whitening.", psa10_possible=false
- Be honest but not overly harsh — slight edge wear is common and may not affect grade

Respond ONLY with valid JSON, no markdown:
{"severity": "string", "locations": ["string"], "grade_impact": "string", "notes": "string", "psa10_possible": boolean}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
        ]}],
      }),
    });
    if (!claudeRes.ok) throw new Error(`Claude API failed: ${await claudeRes.text()}`);
    const claudeData = await claudeRes.json();
    const raw = claudeData.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    console.log('Whitening analysis:', raw);
    res.json(JSON.parse(raw));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n🟢 Card centering server running at http://localhost:${PORT}`);
  console.log(`   eBay App ID: ${process.env.EBAY_APP_ID?.slice(0, 20)}...`);
});