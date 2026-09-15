# AI Trading Card Centering & Whitening Analyzer

An Express backend service that integrates the eBay Browse API with Anthropic's Claude Vision (`claude-sonnet-4-5`) to fetch listing photos, upscale image resolution, calculate border centering ratios, and detect card edge whitening for grading potential.

---

## Features

* **eBay API Integration & Image Upscaling:** Searches eBay's Trading Card category (`183454`) and automatically upgrades thumbnail URLs to high-resolution `s-l1600` assets.
* **Image Proxy & Fallback Handling:** Proxies image fetches to handle CORS, automatically retrying with lower resolution variants (`s-l500`, `s-l400`) if max-res images fail to load.
* **Claude 4.5 Vision Centering Analysis:**
  * **Front Centering:** Measures Left/Right and Top/Bottom border ratios against strict 50/50 targets. Isolates card borders inside slabs or one-touch holders.
  * **Back Centering:** Applies PSA-specific lenient scoring criteria (accepting up to 75/25 ratio standards before penalizing).
* **Whitening & Edge Wear Inspection:** Scans card backs for stress marks and scuffs, reporting severity (`none`, `minimal`, `moderate`, `heavy`), location, grade impact, and PSA 10 viability.
* **Advanced Listing Filtering:** Filter search queries by min/max price, seller feedback score, rating percentage, and Authenticity Guarantee (`AG`) status.

---

## Tech Stack

* **Runtime & Framework:** Node.js (ES Modules), Express.js, CORS
* **AI Vision Provider:** Anthropic Claude Messages API (`claude-sonnet-4-5`)
* **Marketplace API:** eBay Buy Browse API (OAuth 2.0 Client Credentials)
* **Environment Configuration:** `dotenv`

---

## Environment Variables

Create a `.env` file in the project root containing your API credentials:

```env
PORT=3001
EBAY_APP_ID=your_ebay_app_id
EBAY_CERT_ID=your_ebay_cert_id
ANTHROPIC_API_KEY=your_anthropic_api_key

## Running

npm install

node server.js

curl http://localhost:3001/api/health
