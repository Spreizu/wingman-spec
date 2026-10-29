import type { BranchReview } from '../model/branchReview.ts';
import type { RoadmapReport } from '../model/roadmap.ts';
import type { DashboardInputs } from '../model/changeDashboard.ts';
import type { SetupStatus } from '../model/specGuard.ts';
import type { TraceModel } from '../model/traceability.ts';
import type { ProjectModel } from '../model/types.ts';

export type Route =
  | { page: 'overview' }
  | { page: 'change'; root: string; name: string; tab?: string }
  | { page: 'adrs'; root?: string }
  | { page: 'adr'; root: string; number: string }
  | { page: 'specs'; root?: string }
  | { page: 'spec'; root: string; name: string; focus?: string }
  | { page: 'branch'; root?: string }
  | { page: 'roadmap'; root?: string }
  | { page: 'history'; root?: string }
  | { page: 'archived'; root: string; name: string };

/** The pull request view's data: it comes from git and the verifier, so it is loaded after the page first shows. */
export type BranchState = { status: 'loading' } | { status: 'unavailable'; reason: string } | { status: 'ready'; review: BranchReview };

/** The roadmap view's data (a new product's slices): it comes from the verifier, so it is loaded after the page first shows. */
export type RoadmapState = { status: 'loading' } | { status: 'unavailable'; reason: string } | { status: 'ready'; roadmap: RoadmapReport };

export interface ViewData {
  projects: ProjectModel[];
  route: Route;
  /** File contents keyed by absolute path; only files the current route needs are loaded. */
  texts: Record<string, string>;
  /** Capability names under `openspec/specs/`, keyed by project root. */
  baseSpecs: Record<string, string[]>;
  /** Whether the /spec-* commands and the spec-guard hook are installed in the workspace. */
  setup: SetupStatus;
  /** Traceability models (one per project): the spec pages show the Why, anchors, tested scenarios and pending changes from them. */
  trace?: TraceModel[];
  /** The pull request view (route `branch`). */
  branch?: BranchState;
  /** The roadmap view (route `roadmap`). */
  roadmap?: RoadmapState;
  /** The project is a new product in the specification or build phase (`openspec/greenfield.yaml` exists): the roadmap link shows. */
  greenfield?: boolean;
  /** What the verifier and its run files say about the change shown (route `change`); undefined while it is being read. */
  dashboard?: DashboardInputs;
  /** Counts up each time a lens, hover link or tree item asks to reveal something, so the page scrolls to it again even on the same route. */
  revealTick?: number;
}

/**
 * `focus` of a spec route: `req:<requirement-slug>` or `scn:<requirement-slug>/<scenario-slug>`. The page scrolls to
 * that item, highlights it and gives it keyboard focus.
 */
export function focusOf(route: Route): { req: string; scenario?: string } | undefined {
  if (route.page !== 'spec' || !route.focus) return undefined;
  const m = /^(req|scn):([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/.exec(route.focus);
  if (!m) return undefined;
  return { req: m[2] ?? '', ...(m[1] === 'scn' && m[3] ? { scenario: m[3] } : {}) };
}

/** Identity of a route without view-only state such as the active tab. */
export function routeKey(route: Route): string {
  const { tab: _tab, ...rest } = route as Route & { tab?: string };
  return JSON.stringify(rest);
}
