/**
 * Pretty ASCII banner for Oxian JS
 */

const BANNER = [
  "", // empty line
  "", // empty line
  "  ██████  ██   ██ ██  █████  ███    ██       ██ ███████ ",
  " ██    ██  ██ ██  ██ ██   ██ ████   ██       ██ ██      ",
  " ██    ██   ███   ██ ███████ ██ ██  ██       ██ ███████ ",
  " ██    ██  ██ ██  ██ ██   ██ ██  ██ ██  ██   ██      ██ ",
  "  ██████  ██   ██ ██ ██   ██ ██   ████   █████  ███████ ",
  "",
  "🚀 Turn simple ESM into enterprise-grade APIs",
  "", // empty line
  "", // empty line
].join("\n");

export function printBanner(version?: string) {
  console.log(BANNER);
  if (version) console.log(`v${version}`);
}

export function getBanner(): string {
  return BANNER;
}


