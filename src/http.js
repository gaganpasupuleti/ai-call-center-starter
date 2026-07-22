import { readFile } from 'node:fs/promises';
import path from 'node:path';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export async function readJson(request, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), {
      statusCode: 400,
    });
  }
}

export async function servePublicFile(response, publicDirectory, fileName) {
  const safeName = path.basename(fileName);
  const filePath = path.join(publicDirectory, safeName);
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': contentTypes[path.extname(safeName)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

export function validatePhone(phone) {
  return typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone);
}
