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

