// server.js
// Node 18+ recommended. Install deps:
// npm init -y
// npm i express body-parser node-fetch crypto dotenv

import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/**
 * Simple in-memory "DB" (demo). Replace with real DB (Postgres, Mongo).
 */
const users = {}; // key by email -> {subscribed: boolean}

/**
 * 1) /api/predictions
 * Return sample "live" predictions. Replace logic with real AI model or call to model server.
 */
app.get('/api/predictions', (req, res) => {
  // Example: return next 6 matches — in production, compute using your AI model
  const now = new Date().toISOString().slice(0,10);
  const sample = [
    { id: 1, match: "Switzerland vs Sweden", date: now, pick: "Switzerland to win", market: "1", rationale: "Home advantage", confidence: 52 },
    { id: 2, match: "Georgia vs Spain", date: now, pick: "Over 2.5", market: "Over 2.5", rationale: "Spain attack", confidence: 65 },
    { id: 3, match: "Belgium vs Kazakhstan", date: now, pick: "Belgium -1", market: "AH -1", rationale: "Strong away side", confidence: 70 }
  ];
  return res.json(sample);
});

/**
 * 2) PayFast Hosted Checkout creation (demo)
 * This example constructs the hosted payment form URL. For production, follow PayFast API docs and sandbox flow.
 * You need: PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY in .env
 *
 * See PayFast docs: https://developers.payfast.co.za/
 */
function createPayfastSignature(dataObj) {
  // PayFast's classic "signature" is a URL-encoded string sorted by key
  const query = Object.keys(dataObj)
    .sort()
    .map(k => `${k}=${encodeURIComponent(dataObj[k])}`)
    .join('&');
  // In older integrations no HMAC is required; PayFast validates fields using merchantId/Key
  // For API-based flows you might need to compute additional headers/signature per their API docs.
  return query;
}

app.post('/api/create-payfast', (req, res) => {
  const { email, plan } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'email and plan required' });

  // simple order/invoice id
  const mPaymentId = `wp_${Date.now()}`;

  const merchant_id = process.env.PAYFAST_MERCHANT_ID;
  const merchant_key = process.env.PAYFAST_MERCHANT_KEY;
  if (!merchant_id || !merchant_key) return res.status(500).json({ error: 'PayFast not configured' });

  // Example data for a hosted payment redirect (PayFast "return" flow)
  const amount = plan === 'vip' ? '199.00' : '0.00';
  const item_name = plan === 'vip' ? 'WinnersPro VIP monthly' : 'WinnersPro Free';
  const notify_url = `${process.env.PUBLIC_URL || 'http://localhost:' + PORT}/api/payfast-webhook`;
  const return_url = `${process.env.PUBLIC_URL || 'http://localhost:' + PORT}/thank-you`;
  const cancel_url = `${process.env.PUBLIC_URL || 'http://localhost:' + PORT}/cancel`;

  const data = {
    merchant_id,
    merchant_key,
    return_url,
    cancel_url,
    notify_url,
    m_payment_id: mPaymentId,
    amount,
    item_name,
    email_address: email
  };

  // PayFast classic wants a query string; merchant_key MUST NOT be exposed publicly in frontend
  const signature = createPayfastSignature(data);
  // PayFast hosted payment URL (sandbox vs live)
  const payfastHost = process.env.PAYFAST_MODE === 'sandbox' ? 'https://sandbox.payfast.co.za/eng/process' : 'https://www.payfast.co.za/eng/process';

  // Return the redirect details to the front-end to POST the user to PayFast
  // For ease we return the host + parameters
  return res.json({ redirect_url: payfastHost, payload: data, signature });
});

/**
 * 3) Webhook endpoint to receive PayFast notify (IPN)
 * You must validate the IPN with PayFast (they POST fields). For demo we accept and mark subscribed.
 * Production: verify the data with PayFast exactly (see docs)
 */
app.post('/api/payfast-webhook', (req, res) => {
  // PayFast will POST form-encoded fields. For demo, we accept JSON too.
  const payload = req.body;
  console.log('PayFast webhook received:', payload);

  // Validate using PayFast advice: verify with PayFast server, check merchant details, amount, status=COMPLETE, signature etc.
  // For demo: if status = 'COMPLETE' mark the user as subscribed
  // req.body.payment_status (or pf_payment_status) may contain status
  const status = payload.payment_status || payload.payment_status || payload.status || 'COMPLETE';

  // You should identify the user via m_payment_id or custom field (we used m_payment_id above).
  const mPaymentId = payload.m_payment_id || payload.m_payment_id;

  // Demo: mark subscriber (in memory)
  // In a real webhook, find the user by m_payment_id and activate subscription in DB.
  if (status === 'COMPLETE') {
    // Mark user active — in demo we don't have email, so just log
    console.log('Payment COMPLETE for', mPaymentId);
    // TODO: persist to DB
  }

  // respond 200 quickly
  res.send('OK');
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
// --- Predictor proxy + caching for WinMastersAI ---
// Requires Node 18+ (global fetch). If using older Node, `npm i node-fetch` and import it.

import jwt from 'jsonwebtoken'; // npm i jsonwebtoken if you didn't already
const PREDICTOR_URL = process.env.PREDICTOR_URL || 'http://localhost:5000';
const PREDICTOR_API_KEY = process.env.PREDICTOR_API_KEY || ''; // key used by Flask service if configured
const PREDICTOR_MATCH_IDS = (process.env.PREDICTOR_MATCH_IDS || 'm_20251115_001,m_20251115_002').split(',');

// Simple in-memory cache with TTL
const cache = new Map(); // key -> {ts, ttlSec, value}
function setCache(key, value, ttlSec = 30) {
  cache.set(key, { ts: Date.now(), ttlSec, value });
}
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if ((Date.now() - entry.ts) / 1000 > entry.ttlSec) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

// verify JWT (demo). Should be same secret used to sign tokens after payment.
function verifyJWT(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token.replace(/^Bearer\s+/i, ''), process.env.JWT_SECRET || 'dev-secret');
    return payload;
  } catch (e) {
    return null;
  }
}

// Helper: call predictor for a single matchId
async function fetchPredictorMatch(matchId, detail=false, forwardApiKey=false) {
  const cacheKey = `predictor:${matchId}:detail=${detail}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // Build URL
  const url = new URL(`${PREDICTOR_URL.replace(/\/$/, '')}/predict/${encodeURIComponent(matchId)}`);
  if (detail) url.searchParams.set('detail', 'true');

  const headers = { 'Accept': 'application/json' };
  // If predictor expects an API key header (server-to-server), include it
  if (forwardApiKey && PREDICTOR_API_KEY) headers['x-api-key'] = PREDICTOR_API_KEY;

  // Timeout helper (fetch doesn't timeout by default)
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 5000); // 5s timeout
  try {
    const resp = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(id);
    if (!resp.ok) {
      // return null so caller can decide fallback
      return null;
    }
    const json = await resp.json();
    // cache for short time
    setCache(cacheKey, json, 20); // 20s TTL (adjust as needed)
    return json;
  } catch (err) {
    clearTimeout(id);
    console.warn('Predictor fetch error', err && err.message ? err.message : err);
    return null;
  }
}

/**
 * GET /api/predictions
 * Returns aggregated predictions for configured matches.
 * This endpoint is public and returns the predictor response (summary).
 */
app.get('/api/predictions', async (req, res) => {
  try {
    const matchIds = PREDICTOR_MATCH_IDS;
    const calls = matchIds.map(id => fetchPredictorMatch(id, /*detail=*/false, /*forwardApiKey=*/false));
    const results = await Promise.all(calls);
    // Filter out nulls and return array
    const cleaned = results.filter(r => r !== null);
    if (cleaned.length === 0) {
      // Fallback: return basic sample predictions (you can keep your existing sample here)
      return res.json([
        { id: 1, match: "Demo: Switzerland vs Sweden", pick: "Switzerland to win", date: new Date().toISOString(), confidence: 0.52 },
        { id: 2, match: "Demo: Georgia vs Spain", pick: "Over 2.5", date: new Date().toISOString(), confidence: 0.65 }
      ]);
    }
    return res.json(cleaned);
  } catch (err) {
    console.error('Error /api/predictions', err);
    return res.status(500).json({ error: 'Could not fetch predictions' });
  }
});

/**
 * GET /api/prediction/:matchId
 * Proxy single-match request to predictor.
 * If detail=true in query, we forward PREDICTOR_API_KEY to predictor only if the requesting user is VIP.
 * We check JWT from Authorization header to see if subscribed.
 */
app.get('/api/prediction/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const detail = (req.query.detail || 'false').toLowerCase() === 'true';

    let forwardApiKey = false;
    if (detail) {
      // Verify user token
      const authHeader = req.headers.authorization || '';
      const payload = verifyJWT(authHeader);
      if (!payload) {
        return res.status(401).json({ error: 'Missing or invalid token for detailed analysis' });
      }
      // Example: suppose payload.subscribed === true when active
      if (!payload.subscribed) {
        return res.status(403).json({ teaser: 'Full analysis available for VIPs. Start a trial for R199/month.' });
      }
      forwardApiKey = true;
    }

    const predictorResp = await fetchPredictorMatch(matchId, detail, forwardApiKey);
    if (!predictorResp) {
      return res.status(502).json({ error: 'Prediction service unavailable' });
    }
    return res.json(predictorResp);
  } catch (err) {
    console.error('Error /api/prediction/:matchId', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

