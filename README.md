# Hyginix — Log Extra

A small phone app for recording an operational extra against an employee, in
under five seconds, online or offline.

It is a static progressive web app: cached on the device, so it opens instantly
and keeps working with no signal. Entries are saved to a local queue and sent in
the background, so the user is never waiting on the network.

## Setup

The app is configured once per device, from within the app itself:

1. **App URL** — the `/exec` URL of the Google Apps Script web app that receives
   entries.
2. **Device key** — a passphrase checked by that endpoint.

Neither value is stored in this repository. Both live only in the device's
local storage and in the script's own properties.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup and styles |
| `app.js` | Selection flow, offline queue, background sync |
| `sw.js` | Service worker — caches the app shell |
| `manifest.json` | Install metadata |
| `icon.svg` | Home-screen icon |

## Notes

Each queued entry carries its own identifier, used by the server as an
idempotency key. The queue retries on reconnect, so an entry can legitimately
arrive more than once; repeats are acknowledged without being recorded twice.
