export function parseArgs(argv) {
  const args = { url: null, token: null, tokenFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === '--url') {
      args.url = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (part === '--token') {
      args.token = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (part === '--token-file') {
      args.tokenFile = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (part.startsWith('--url=')) {
      args.url = part.slice('--url='.length);
      continue;
    }
    if (part.startsWith('--token=')) {
      args.token = part.slice('--token='.length);
      continue;
    }
    if (part.startsWith('--token-file=')) {
      args.tokenFile = part.slice('--token-file='.length);
    }
  }
  return args;
}
