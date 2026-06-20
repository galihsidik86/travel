#!/usr/bin/env node
// Generate VAPID keys for Web Push (Stage 17/93).
//
// Usage:
//   npm run vapid:generate
//
// Prints keys to stdout. Copy the three VAPID_* lines into your .env
// then restart the dev server. Boot log will switch from
// "[push] sender = console" to "[push] sender = web-push".

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('');
console.log('# Generated VAPID keys — copy these 3 lines into your .env:');
console.log('');
console.log(`VAPID_PUBLIC=${keys.publicKey}`);
console.log(`VAPID_PRIVATE=${keys.privateKey}`);
console.log('VAPID_CONTACT=mailto:admin@religio.pro');
console.log('');
console.log('# After saving .env, restart the server. Push fan-out will now use real');
console.log('# web-push delivery instead of console fake mode.');
console.log('');
