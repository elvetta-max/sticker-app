import { logSearch, getTrendingSearches, getSearchSuggestions } from "./search.service.js";

/**
 * POST /api/search — log a normalized search keyword (context.md §4.6).
 */
export async function postSearch(req, res) {
  const result = await logSearch({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    device_id: req.body.device_id,
    app_id: req.body.app_id,
    keyword: req.body.keyword,
  });

  res.status(200).json({ success: true, data: result });
}

/**
 * GET /api/search/trending — Redis-served trending keywords (context.md §4.6).
 */
export async function getTrending(req, res) {
  const data = await getTrendingSearches({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    app_id: req.query.app_id,
    limit: req.query.limit,
  });

  res.status(200).json({ success: true, data });
}

/**
 * GET /api/search/suggest — prefix autocomplete (context.md §4.16).
 */
export async function getSuggest(req, res) {
  const suggestions = await getSearchSuggestions({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    app_id: req.query.app_id,
    q: req.query.q,
  });

  res.status(200).json({ success: true, suggestions });
}
