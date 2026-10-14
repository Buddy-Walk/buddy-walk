import type { Request, Response } from "express";

/**
 * Express 4 drops the promise an async handler returns, so a rejection would
 * go unhandled and stop the server. This answers it with a 500 instead.
 */
export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error) => {
      // The path only: the query can carry the admin token.
      console.error(`[asyncRoute] ${req.method} ${req.baseUrl}${req.path} failed:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "The request failed. Check the server logs." });
      }
    });
  };
}
