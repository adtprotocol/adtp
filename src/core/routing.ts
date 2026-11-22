import type { Route } from '../config.js';

/** The facts about a message that routes can match on. */
export interface RouteFacts {
  priority: string;
  intent: string;
  /** The sender's organization: the domain of the `from` address. */
  from_org: string;
  sender_type: string | null;
}

function matches(route: Route, facts: RouteFacts): boolean {
  if (!route.match) return false;
  for (const [key, allowed] of Object.entries(route.match) as [keyof RouteFacts, string[] | undefined][]) {
    if (!allowed) continue;
    const actual = facts[key];
    if (actual === null || !allowed.includes(actual.toLowerCase())) return false;
  }
  return true;
}

/**
 * Picks the route for a message: the first route whose `match` conditions all
 * hold, in config order; otherwise the default route; otherwise none.
 */
export function selectRoute(routes: Route[], facts: RouteFacts): Route | null {
  for (const route of routes) {
    if (!route.default && matches(route, facts)) return route;
  }
  return routes.find((r) => r.default) ?? null;
}
