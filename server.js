/**
 * Roboflow WebRTC Secure Proxy Server
 *
 * This Express server acts as a secure proxy between your frontend and Roboflow's API.
 * Your API key stays on the server and is never exposed to the browser.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { InferenceHTTPClient } from '@roboflow/inference-sdk';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const isDev = process.env.NODE_ENV !== 'production';

// Middleware
app.use(cors());
app.use(express.json());

/**
 * POST /api/init-webrtc
 *
 * Proxies WebRTC initialization to Roboflow while keeping the API key secure.
 *
 * Request body:
 *   - offer: { sdp, type }
 *   - wrtcParams: { workflowSpec, imageInputName, streamOutputNames, ... }
 *
 * Response:
 *   - sdp: string
 *   - type: string
 *   - context: { request_id, pipeline_id }
 */

// server.js (top of file)
const realFetch = globalThis.fetch;

if (!realFetch) {
  console.error("No global fetch found. Are you running Node 18+?");
} else {
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    console.log("[SDK fetch]", method, url);

    // Log minimal request headers (avoid dumping secrets)
    if (opts.headers) {
      const headersObj = opts.headers instanceof Headers
        ? Object.fromEntries(opts.headers.entries())
        : opts.headers;

      const redacted = { ...headersObj };
      if (redacted.Authorization) redacted.Authorization = "Bearer ***REDACTED***";
      if (redacted.authorization) redacted.authorization = "Bearer ***REDACTED***";
      console.log("[SDK fetch headers]", redacted);
    }

    const res = await realFetch(url, opts);

    console.log("[SDK fetch response]", res.status, res.statusText, url);
    console.log("[SDK fetch response headers]", Object.fromEntries(res.headers.entries()));

    // Try to read body safely without breaking downstream consumers:
    // we must clone() because the SDK will read the body too.
    try {
      const text = await res.clone().text();
      if (text && text.length) {
        console.log("[SDK fetch response body]", text.slice(0, 4000));
      }
    } catch (e) {
      console.log("[SDK fetch response body] <unavailable>", String(e));
    }

    return res;
  };
}




app.post('/api/init-webrtc', async (req, res) => {
  try {
    const { offer, wrtcParams } = req.body;

    // Validate request
    if (!offer || !offer.sdp || !offer.type) {
      return res.status(400).json({
        error: 'Missing required field: offer with sdp and type'
      });
    }

    // Validate workflow configuration (either spec or identifier)
    const hasWorkflowSpec = wrtcParams?.workflowSpec;
    const hasWorkflowIdentifier = wrtcParams?.workspaceName && wrtcParams?.workflowId;

    if (!wrtcParams || (!hasWorkflowSpec && !hasWorkflowIdentifier)) {
      return res.status(400).json({
        error: 'Missing required field: wrtcParams must contain either workflowSpec OR (workspaceName + workflowId)'
      });
    }

    // Validate API key
    const apiKey = process.env.ROBOFLOW_API_KEY;
    if (!apiKey) {
      console.error('[Server] ROBOFLOW_API_KEY not set in environment');
      return res.status(500).json({
        error: 'Server configuration error: API key not configured'
      });
    }

    // Optional custom server URL
    const serverUrl = process.env.ROBOFLOW_SERVER_URL;

    console.log('[Server] Initializing WebRTC worker...');

    // Initialize Roboflow client
    const client = InferenceHTTPClient.init({
      apiKey,
      serverUrl
    });

    // Build workflow configuration (either spec or identifier)
    const workflowConfig = hasWorkflowSpec
      ? { workflowSpec: wrtcParams.workflowSpec }
      : { workspaceName: wrtcParams.workspaceName, workflowId: wrtcParams.workflowId };

    // Prepare the config object, filtering out undefined values
    const config = {};
    if (wrtcParams.imageInputName) config.imageInputName = wrtcParams.imageInputName;
    if (wrtcParams.streamOutputNames) config.streamOutputNames = wrtcParams.streamOutputNames;
    if (wrtcParams.dataOutputNames) config.dataOutputNames = wrtcParams.dataOutputNames;
    if (wrtcParams.workflowParameters) config.workflowParameters = wrtcParams.workflowParameters;
    if (wrtcParams.threadPoolWorkers) config.threadPoolWorkers = wrtcParams.threadPoolWorkers;
    if (wrtcParams.processingTimeout) config.processingTimeout = wrtcParams.processingTimeout;
    if (wrtcParams.iceServers) config.iceServers = wrtcParams.iceServers;

    // Prepare the request parameters
    // Note: requestedPlan and requestedRegion might need to be at top level based on SDK behavior
    const requestParams = {
      offer,
      ...workflowConfig
    };

    // Add requestedPlan and requestedRegion at top level if provided
    if (wrtcParams.requestedPlan) {
      requestParams.requestedPlan = wrtcParams.requestedPlan;
    }
    if (wrtcParams.requestedRegion) {
      requestParams.requestedRegion = wrtcParams.requestedRegion;
    }

    // Only add config if it has properties
    if (Object.keys(config).length > 0) {
      requestParams.config = config;
    }

    console.log('[Server] Calling initializeWebrtcWorker with params:', JSON.stringify(requestParams, null, 2));

    // Call Roboflow API
    const answer = await client.initializeWebrtcWorker(requestParams);

    console.log('[Server] Full API response:', JSON.stringify(answer, null, 2));
    console.log('[Server] WebRTC worker initialized:', {
      pipelineId: answer?.context?.pipeline_id,
      region: wrtcParams.requestedRegion,
      plan: wrtcParams.requestedPlan
    });

    // Return answer to frontend
    res.json(answer);

  } catch (error) {
    console.error('[Server] Error initializing WebRTC worker:');
    console.error('[Server] Error type:', error?.constructor?.name);
    console.error('[Server] Error message:', error?.message || '(no message)');
    console.error('[Server] Error stack:', error?.stack || '(no stack)');
    
    // Try to stringify the error to see all properties
    try {
      const errorDetails = {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
        ...Object.getOwnPropertyNames(error).reduce((acc, key) => {
          try {
            acc[key] = error[key];
          } catch (e) {
            acc[key] = '[unable to access]';
          }
          return acc;
        }, {})
      };
      console.error('[Server] Full error details:', JSON.stringify(errorDetails, null, 2));
    } catch (stringifyError) {
      console.error('[Server] Could not stringify error:', stringifyError);
      console.error('[Server] Raw error:', error);
    }

    const errorMessage = error?.message || error?.toString() || 'Failed to initialize WebRTC worker';
    res.status(500).json({
      error: errorMessage,
      details: error?.stack || 'No stack trace available'
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  const hasApiKey = !!process.env.ROBOFLOW_API_KEY;

  res.json({
    status: 'ok',
    apiKeyConfigured: hasApiKey,
    message: hasApiKey
      ? 'Server is ready'
      : 'Warning: ROBOFLOW_API_KEY not configured'
  });
});

/**
 * GET /api/turn-config
 *
 * Fetches TURN server configuration from Roboflow API.
 * This improves WebRTC connectivity for users behind restrictive firewalls.
 *
 * Response:
 *   - iceServers: Array of RTCIceServer configurations
 */
app.get('/api/turn-config', async (req, res) => {
  try {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    if (!apiKey) {
      console.warn('[Server] TURN config requested but no API key configured');
      return res.json({ iceServers: [] });
    }

    const serverUrl = process.env.ROBOFLOW_SERVER_URL;

    const client = InferenceHTTPClient.init({
      apiKey,
      serverUrl
    });

    const iceServers = await client.fetchTurnConfig();

    console.log('[Server] TURN config fetched:', iceServers ? 'success' : 'none available');

    res.json({ iceServers: iceServers || [] });

  } catch (error) {
    console.error('[Server] Error fetching TURN config:', error);
    res.json({ iceServers: [] });
  }
});

// Setup Vite dev server or static files (AFTER API routes)
if (isDev) {
  // In development, use Vite's middleware for HMR and module resolution
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
    root: 'src'
  });
  app.use(vite.middlewares);
} else {
  // In production, serve from public/
  app.use(express.static('public'));
}

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Roboflow WebRTC Proxy Server ${isDev ? '(Development)' : '(Production)'}`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api/init-webrtc`);
  console.log(`   Health:   http://localhost:${PORT}/api/health`);
  console.log(`   Serving:  ${isDev ? 'src/ (via Vite)' : 'public/'}\n`);

  if (!process.env.ROBOFLOW_API_KEY) {
    console.warn('⚠️  Warning: ROBOFLOW_API_KEY not set in .env file\n');
  }
});
