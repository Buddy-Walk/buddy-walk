import "./instrument";
import * as Sentry from "@sentry/node";
import express, { Application, Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import questionRoute from "./routes/question"
import lastMetersRoute, { mountLastMeters } from "./routes/lastMeters"
import { mountLastMetersDashboardAliases } from "./config/lastMetersDashboardAliases"
import chatLogRoute from "./routes/chatLog"
import tokenRoute from "./routes/token"
import companionRoute from "./routes/companion"
import telemetryRoute from "./routes/telemetry"
import feedbackRoute from "./routes/feedback"
import mtaRoute from "./routes/mta"
import lastMetersTestLogRoute from "./routes/lastMetersTestLog"
import mongoose from "mongoose";
import { config } from "./database";
import { setCompanionMemoryStore } from "./database/companionStoreMode";
import { canRunLocalLastMeters, describeServerMode, getServiceRouting } from "./config/serverMode";
import {
  mountAiProxy,
  mountSpeechProxy,
  mountMtaProxy,
} from "./middleware/upstreamProxy";
import { isMongoConnected } from "./database/usageStore";
import { probeUpstreamText } from "./middleware/upstreamProxy";
import { TranscribeController } from "./controllers/transcribe";
import lastMetersTestLogModel from "./database/models/lastMetersTestLog";
import { lastMetersRetryRunService } from "./services/lastMetersRetryRuns";
import { startRenderKeepAlive } from "./utils/keepAlive";

dotenv.config();

const transcribeController = new TranscribeController();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
      'http://localhost:5173',
      'http://localhost:8000',
      'https://buddy-walk-api.onrender.com',
      'https://justraymond99.github.io',
    ];

(async function(){
  const app: Application = express();
  const port = process.env.PORT || 8000;

  let mongoConnected = false;
  try {
    await mongoose.connect(config.link!, {
      ...config.options,
      serverSelectionTimeoutMS: 4000,
    });
    mongoConnected = true;
    console.log(
      `[server] MongoDB connected (${mongoose.connection.name || "default database"}).`
    );
  } catch (error) {
    console.warn("MongoDB unavailable — using in-memory store for metrics, chat logs, and companion:", error);
    Sentry.captureException(error, { tags: { subsystem: "mongodb", phase: "connect" } });
    setCompanionMemoryStore(true);
  }

  if (mongoConnected) {
    try {
      await lastMetersTestLogModel.collection.createIndex({ serverTs: -1 });
      // Retry history and per-row retry counts; field tests are left out.
      await lastMetersTestLogModel.collection.createIndex(
        { retryOf: 1, serverTs: 1 },
        { partialFilterExpression: { retryOf: { $exists: true } } }
      );
      console.log("[server] Last Meters dashboard indexes ready.");
    } catch (error) {
      console.warn("[server] Could not create the Last Meters dashboard indexes; history queries may be slow:", error);
    }
    // One running retry per original, enforced across server instances.
    // Without this index, dashboard retries stay off.
    try {
      await lastMetersRetryRunService.ensureIndexes();
    } catch (error) {
      console.error("[server] Could not create the one-running-retry index; dashboard retries are off:", error);
    }
  }

  const routing = getServiceRouting();
  console.log(
    `[server] Capability routing - ai=${routing.ai}, speech=${routing.speech}, mta=${routing.mta}, lastMeters=${routing.lastMeters}`
  );


  app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? allowedOrigins : true,
    credentials: true,
  }));
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  app.use('/api/companion', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Speech is routed on its own, so transcription runs locally or upstream
  // regardless of AI routing.
  if (routing.speech === 'local') {
    app.use("/api/token", tokenRoute);
    app.post(
      '/api/transcribe',
      express.raw({ type: '*/*', limit: '10mb' }),
      (req, res) => {
        void transcribeController.transcribe(req, res);
      }
    );
  } else {
    mountSpeechProxy(app);
  }

  if (routing.mta === 'local') {
    app.use("/api", mtaRoute);
  } else {
    mountMtaProxy(app);
  }

  mountLastMeters(app);

  if (routing.ai === 'local') {
    app.use("/api", lastMetersRoute);
    app.use("/api", questionRoute);
  } else {
    mountAiProxy(app);
  }

  app.use("/api/db", chatLogRoute)
  app.use("/api/companion", companionRoute)
  app.use("/api/telemetry", telemetryRoute)
  app.use("/api/feedback", feedbackRoute)
  app.use("/api/last-meters-tests", lastMetersTestLogRoute)
  app.use("/api/last-mile-tests", lastMetersTestLogRoute)

  // Gated verification route — enable with SENTRY_DEBUG_ROUTE=1 on Render when testing ingest.
  if (process.env.SENTRY_DEBUG_ROUTE === '1') {
    app.get('/api/debug-sentry', (_req, res) => {
      const message = `Sentry test error ${Date.now()}`;
      Sentry.captureException(new Error(message));
      res.status(500).json({ ok: false, message });
    });
  }

  app.get('/api/health', async (_req, res) => {
    const mode = describeServerMode();
    const upstreamText =
      mode.routing.ai === 'proxy' ? await probeUpstreamText() : { ok: true, status: 200 };
    res.status(200).json({
      ok: true,
      service: 'buddy-walk-api',
      mode: mode.mode,
      upstream: mode.upstream,
      // Per-capability routing makes a misconfigured service visible here
      // instead of only surfacing as a 500 from the endpoint itself.
      routing: mode.routing,
      storage: isMongoConnected() ? 'mongo' : 'memory',
      upstreamTextOk: upstreamText.ok,
      upstreamTextStatus: upstreamText.status || undefined,
      lastMetersCapable: canRunLocalLastMeters(),
    });
  });

  // Public companion viewer page. Loads a tiny HTML shell with the token
  // injected as a global so the page can poll the snapshot endpoint.
  const viewerCandidates = [
    path.join(__dirname, 'views', 'companion.html'),
    path.join(__dirname, '..', 'views', 'companion.html'),
    path.join(__dirname, '..', 'server', 'views', 'companion.html'),
  ];
  let companionViewerTemplate = '';
  for (const candidate of viewerCandidates) {
    if (fs.existsSync(candidate)) {
      companionViewerTemplate = fs.readFileSync(candidate, 'utf8');
      break;
    }
  }
  if (!companionViewerTemplate) {
    console.warn('[companion] viewer template not found in any of:', viewerCandidates);
  }

  function sendCompanionViewer(res: Response, rawToken: string): void {
    const token = rawToken.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!companionViewerTemplate) {
      res.status(500).send('Companion viewer is not available right now.');
      return;
    }
    const html = companionViewerTemplate.replace(
      'window.__COMPANION_TOKEN__ || ""',
      `${JSON.stringify(token)}`
    );
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  }

  app.get('/companion-viewer.html', (req, res) => {
    sendCompanionViewer(res, String(req.query.token ?? ''));
  });

  app.get('/companion/:token', (req, res) => {
    sendCompanionViewer(res, req.params.token ?? '');
  });

  mountLastMetersDashboardAliases(app);

  const rootDir = __dirname.includes('dist') 
  ? path.join(__dirname, '..')       // Production: go up 1 level to /dist
  : path.join(__dirname, '../dist'); // Development: go up 2 levels to /dist

  if (fs.existsSync(path.join(rootDir, 'index.html'))) {
    app.use(express.static(rootDir));

    app.get('*', (_req, res) => {
      res.sendFile(path.join(rootDir, 'index.html'));
    });
  } else {
    console.warn('[server] Web dist not found; running API-only.');
    app.get('/', (_req, res) => {
      res.status(200).json({ ok: true, service: 'buddy-walk-api' });
    });
  }

  // Must be after all routes so Express errors reach Sentry.
  Sentry.setupExpressErrorHandler(app);
  
  app.listen(Number(port), '0.0.0.0', () => {
      console.log(`Server is live at http://localhost:${port}`);
      startRenderKeepAlive();
    });

})()
