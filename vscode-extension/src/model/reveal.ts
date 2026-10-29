/** Which Wingman Spec UI route reveals a requirement or scenario. Pure. */
import type { Route } from '../webview/types.ts';
import { slug } from './anchors.ts';
import type { RevealTarget } from './reqInsight.ts';
import type { TraceModel } from './traceability.ts';

/** `capability/requirement-slug` split into its parts. */
export const splitKey = (key: string): { cap: string; req: string } => ({ cap: key.split('/')[0] ?? '', req: key.split('/')[1] ?? '' });

export function revealRoute(model: Pick<TraceModel, 'root'>, target: RevealTarget): Route {
  switch (target.type) {
    case 'requirement': {
      const { cap, req } = splitKey(target.key);
      return { page: 'spec', root: model.root, name: cap, focus: `req:${req}` };
    }
    case 'scenario': {
      const { cap, req } = splitKey(target.key);
      return { page: 'spec', root: model.root, name: cap, focus: `scn:${req}/${slug(target.scenario)}` };
    }
  }
}

/** Requirement route from a capability and a requirement name as written in a spec (heading text). */
export const requirementRouteByName = (root: string, cap: string, name: string): Route => ({ page: 'spec', root, name: cap, focus: `req:${slug(name)}` });
