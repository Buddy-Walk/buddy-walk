import express from 'express';
import { getSubwayArrivals } from '../services/mta';

const route = express.Router();

route.post('/mta', async (req, res) => {
  // Validate the requested transit route and location, then return nearby subway arrivals or a
  // controlled lookup error.
  const body = req.body as { routeId?: string; lat?: number; lon?: number };
  const routeId = body.routeId?.trim();
  const lat = Number(body.lat);
  const lon = Number(body.lon);

  if (!routeId) {
    res.status(400).json({ error: 'routeId is required' });
    return;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'lat and lon are required' });
    return;
  }

  try {
    const arrivals = await getSubwayArrivals(routeId, lat, lon);
    res.status(200).json({ arrivals });
  } catch (e) {
    console.error('[MTA] arrivals error:', e);
    res.status(500).json({ error: 'Could not fetch MTA arrivals' });
  }
});

export default route;
