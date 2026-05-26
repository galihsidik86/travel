// File-based notification templates with {{var}} substitution (5bb).
//
// Templates live at `src/notifications/templates/<TYPE>__<CHANNEL>.json`:
//   { "subject": "Konfirmasi {{bookingNo}}", "body": "Assalamu'alaikum {{fullName}}..." }
//
// Both fields support `{{key}}` placeholders that map to keys in the `vars`
// object. Missing keys render as empty strings (defensive — don't crash on a
// missing payload field). Unknown template files throw — better to fail loud
// than silently dispatch an empty body.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, '..', 'notifications', 'templates');

// Tiny in-memory cache so we don't re-read the file every dispatch.
// Production reload: just restart the dev server (template changes are rare).
const cache = new Map();

function loadTemplate(type, channel) {
  const key = `${type}__${channel}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(TEMPLATE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Notif template missing: ${key}.json (looked in ${TEMPLATE_DIR})`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  cache.set(key, parsed);
  return parsed;
}

function substitute(str, vars) {
  if (typeof str !== 'string') return '';
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars?.[k];
    return v == null ? '' : String(v);
  });
}

/**
 * Render (subject, body) for a given notification type + channel + vars.
 * Subject is optional (some channels like WA don't use it).
 */
export function renderTemplate(type, channel, vars = {}) {
  const tpl = loadTemplate(type, channel);
  return {
    subject: substitute(tpl.subject, vars),
    body: substitute(tpl.body, vars),
  };
}

// Test/dev helper — clear the in-memory cache so a template edit takes effect
// without restarting the process. Not used in production paths.
export function _clearTemplateCache() {
  cache.clear();
}
