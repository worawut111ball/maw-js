import { cmdSend } from "../commands/shared/comm";
import { UserError } from "../core/util/user-error";
import { error, hint } from "./output";

export async function routeComm(cmd: string, args: string[]): Promise<boolean> {
  // hey stays core — it's the transport layer.
  // Note: `send` and `tell` were previously aliases here; `send` is now the
  // raw-text plugin (#757), and `tell` was undocumented. Use `maw hey` for
  // agent messaging.
  if (cmd === "hey") {
    const force = args.includes("--force");
    // #842 Sub-C — `--approve` bypasses the cross-scope ACL queue gate.
    // Operator-explicit opt-in for THIS message; mirrors the consent
    // `--pin` escape hatch already wired in #644. Optional `--trust`
    // pairs with `--approve` to also persist the sender↔target trust
    // entry so the same pair stops queuing on subsequent sends.
    const approve = args.includes("--approve");
    const trust = args.includes("--trust");
    const target = args[1];
    const msgArgs = args
      .slice(2)
      .filter(a => a !== "--force" && a !== "--approve" && a !== "--trust");

    // Distinguish: zero-args usage error vs missing-message error (#388.3)
    // A user who typed `maw hey mawjs` (just the target, no message) was
    // previously indistinguishable from `maw hey` alone — both hit the
    // same "usage:" error. Now the missing-message case names the target
    // so the user sees their input got through.
    if (!target) {
      console.error(error("missing target and message"));
      console.error(hint("usage: maw hey <target> <message> [--force]"));
      console.error(hint("target forms:"));
      console.error(hint("  local:<agent>                this node"));
      console.error(hint("  <node>:<session>             canonical cross-node form (window 1)"));
      console.error(hint("  <node>:<session>:<window>    target a specific tmux window"));
      console.error(hint("examples:"));
      console.error(hint("  maw hey local:mawjs \"hello from neo\""));
      console.error(hint("  maw hey phaith:01-hojo:3 \"hello hojo-hermes\""));
      throw new UserError("missing target and message");
    }
    if (!msgArgs.length) {
      console.error(error(`missing message for target '${target}'`));
      console.error(hint(`maw hey ${target} <message>`));
      console.error(hint(`if '${target}' is not valid, run 'maw ls' to see available targets`));
      throw new UserError(`missing message for '${target}'`);
    }
    await cmdSend(target, msgArgs.join(" "), force, { approve, trust });
    return true;
  }
  return false;
}
