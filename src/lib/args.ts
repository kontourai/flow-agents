export type ParsedArgs = { positionals: string[]; flags: Record<string, string | boolean | string[]> };

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    const next = eq === -1 ? argv[index + 1] : arg.slice(eq + 1);
    let value: string | boolean = true;
    if (eq !== -1) value = String(next);
    else if (next !== undefined && !String(next).startsWith("--")) {
      value = String(next);
      index += 1;
    }
    if (flags[key] === undefined) flags[key] = value;
    else if (Array.isArray(flags[key])) (flags[key] as string[]).push(String(value));
    else flags[key] = [String(flags[key]), String(value)];
  }
  return { positionals, flags };
}

export function flagString(flags: ParsedArgs["flags"], key: string, fallback?: string): string | undefined {
  const value = flags[key];
  if (Array.isArray(value)) return value[value.length - 1];
  if (typeof value === "string") return value;
  return fallback;
}

export function flagBool(flags: ParsedArgs["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

export function flagList(flags: ParsedArgs["flags"], key: string): string[] {
  const value = flags[key];
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}
