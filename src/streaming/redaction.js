const SECRET_KEYS = new Set([
  'x-api-token',
  'api_token',
  'apitoken',
  'authorization',
  'token',
  'secret',
  'password',
]);

export function redactSecret(value) {
  if (value === undefined || value === null || value === '') return '';
  return '[REDACTED]';
}

export function containsSecret(text, secrets = []) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return secrets
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
    .some((secret) => text.includes(secret));
}

export function redactHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_KEYS.has(String(key).toLowerCase())) {
      result[key] = redactSecret(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function redactDeep(value, secrets = []) {
  if (typeof value === 'string') {
    if (containsSecret(value, secrets)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, secrets));
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEYS.has(String(key).toLowerCase())) {
        result[key] = redactSecret(nested);
      } else {
        result[key] = redactDeep(nested, secrets);
      }
    }
    return result;
  }
  return value;
}

export function safeErrorMessage(error, secrets = []) {
  const message = error?.message ?? 'Unexpected error';
  if (containsSecret(message, secrets)) {
    return 'A configuration error occurred';
  }
  return message;
}
