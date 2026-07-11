function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build a portable command that cannot reuse a repository-local package with
 * the same name and version. The temporary prefix is removed on every exit.
 */
export function isolatedPackageCommand(packageSpec: string, binary: string, args: string[]): string {
  const script = [
    "root=$(mktemp -d) || exit 1",
    `trap 'rm -rf "$root"' EXIT HUP INT TERM`,
    "package=$1",
    "binary=$2",
    "shift 2",
    `npm exec --yes --prefix "$root" --package="$package" -- "$binary" "$@"`,
  ].join("; ");
  return `sh -c ${shellQuote(script)} sh ${[packageSpec, binary, ...args].map(shellQuote).join(" ")}`;
}

export function pinnedFlowAgentsCommand(version: string, args: string[]): string {
  return isolatedPackageCommand(`@kontourai/flow-agents@${version}`, "flow-agents", args);
}
