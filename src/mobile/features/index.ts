// Feature packs for the phone UI — see PLAN-maw-mobile.md §9. Each adds routes under /mobile.
import { mount as permissions } from "./permissions";
import { mount as modes } from "./modes";
import { mount as activity } from "./activity";
import { mount as resume } from "./resume";
import { mount as context } from "./context";
import { mount as superset } from "./superset";
import { mount as travel } from "./travel";
import { mount as ports } from "./ports";
import { mount as retro } from "./retro";
import { mount as prs } from "./prs";

export function mountFeatures(app: any): void {
  for (const m of [permissions, modes, activity, resume, context, superset, travel, ports, retro, prs]) m(app);
}
