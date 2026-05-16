const RESET = "\x1b[0m";

export const color = {
  bold: (s: string) => `\x1b[1m${s}${RESET}`,
  cyan: (s: string) => `\x1b[36m${s}${RESET}`,
  dim: (s: string) => `\x1b[90m${s}${RESET}`,
  green: (s: string) => `\x1b[32m${s}${RESET}`,
  red: (s: string) => `\x1b[31m${s}${RESET}`,
  yellow: (s: string) => `\x1b[33m${s}${RESET}`,
};

export function error(message: string): string {
  return `${color.red("[error]")} ${message}`;
}

export function warn(message: string): string {
  return `${color.yellow("[warn]")} ${message}`;
}

export function info(message: string): string {
  return `${color.dim("[info]")} ${message}`;
}

export function hint(message: string): string {
  return `  ${color.dim(message)}`;
}
