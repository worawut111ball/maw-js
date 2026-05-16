import { discoverPackages } from "../plugin/registry";
import { color } from "./output";

export function usage() {
  const title = `${color.cyan("maw")} ${color.dim("Multi-Agent Workflow")}`;

  try {
    const all = discoverPackages();
    const active = all.filter(p => !p.disabled && p.manifest.cli?.command);
    const hasDisabled = all.some(p => p.disabled);

    // Group by weight tier: core < 10, standard 10-49, extra 50+
    const tiers = [
      { name: "core",     plugins: active.filter(p => (p.manifest.weight ?? 50) < 10) },
      { name: "standard", plugins: active.filter(p => { const w = p.manifest.weight ?? 50; return w >= 10 && w < 50; }) },
      { name: "extra",    plugins: active.filter(p => (p.manifest.weight ?? 50) >= 50) },
    ].filter(t => t.plugins.length > 0);

    const multiTier = tiers.length > 1;
    const commands = tiers.flatMap(t => t.plugins.map(p => `maw ${p.manifest.cli!.command}`));
    const commandWidth = Math.min(34, Math.max(18, ...commands.map(c => c.length)) + 2);
    const lines: string[] = [
      title,
      "",
      `${color.yellow("Usage")}`,
      `  maw <command> [args]`,
      "",
      `${color.yellow("Commands")}`,
    ];

    for (const tier of tiers) {
      const label = multiTier
        ? `${color.dim(tier.name)} ${color.dim(`(${tier.plugins.length})`)}`
        : color.dim(tier.name);
      lines.push(label);
      for (const p of tier.plugins) {
        const cmd = color.cyan(`maw ${p.manifest.cli!.command}`.padEnd(commandWidth));
        const desc = p.manifest.description ?? "";
        lines.push(`  ${cmd} ${desc}`);
      }
      lines.push("");
    }

    lines.push(`${color.yellow("Options")}`);
    lines.push(`  ${color.cyan("--help, -h".padEnd(commandWidth))} Show help`);
    lines.push(`  ${color.cyan("--version, -v".padEnd(commandWidth))} Show version`);
    lines.push("");

    const countLine = hasDisabled
      ? color.dim(`${active.length} commands active. Run 'maw plugin enable <name>' for more.`)
      : color.dim(`${active.length} commands active.`);
    lines.push(countLine);

    console.log(lines.join("\n"));
  } catch {
    // Registry not loaded yet — minimal fallback
    console.log(`${title}\n\nRun ${color.cyan("maw plugin ls")} to see available commands.`);
  }
}
