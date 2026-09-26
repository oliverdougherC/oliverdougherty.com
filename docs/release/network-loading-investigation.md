# Intermittent live navigation: evidence and reproduction

Issue #50 tracks intermittent stalls previously reported on a university network. The same site was subsequently reported fast on personal Wi-Fi. The cause is still unknown. This document separates observations from checks that have not yet been possible.

## Checks from September 25, 2026

- The live `release-artifact.json` reported commit `d61a1eaef0747dd6b3738b5a7d9fac0cabe71a58`, matching the source revision used for these local checks.
- Four live document requests from this host returned HTTP 200 over HTTP/2. Their total times were 44–143 ms. This is one access path, not the affected university path.
- `node scripts/navigation-stability-check.js` passed 28 real-link and back/forward transitions against source and a freshly built `dist` in Chromium. The same run passed against the live site from this host. A packaged WebKit run also passed. The macOS Firefox launch did not complete because its headless compositor/sandbox failed before a page opened; no Firefox navigation result is claimed.
- The probe records time to visibly readable heading and current-page navigation, confirms an event-loop response, and reports document `DOMContentLoaded` and `load` timings separately. It neither intercepts requests nor uses `networkidle`. On failure it prints pending and failed requests to help identify the actual wait stage.

These passes do **not** identify or fix the reported network-correlated incident. They also do not establish that personal Wi-Fi and university Wi-Fi reach the same CDN edge or negotiate the same protocol.

## Controlled comparison to capture next

1. On the same laptop and browser profile, record the browser version and deployed release marker. Enable DevTools Network **Preserve log** before navigating. Keep blocker, browser settings, and site configuration unchanged.
2. Run repeated real-link navigation on university Wi-Fi, then a phone hotspot, then university Wi-Fi again, close together in time. Preserve the original session for the first pass; compare fresh-cache sessions separately.
3. For a stall, identify the pending **document or critical asset**, not simply the last red console line. Record URL, status, protocol, queue/stall time, DNS/connect/TLS where exposed, response-start time, body completion, redirects and relevant response headers. Note whether the page is unusable or only the tab spinner remains active. Save a sanitized HAR and screenshot if possible.
4. If the same wait follows one network, investigate its DNS/address-family, route/filtering/proxy and negotiated transport one variable at a time. Compare source, local `dist`, live custom domain and direct Pages delivery only with matched artifact versions and validated Host/TLS handling.
5. Verify any proposed fix with the previously failing sequence on that access path. If no stall can be reproduced, record that outcome without attributing a cause.

The persistent unsupported Permissions-Policy warnings and blocked Cloudflare analytics beacon have also appeared during fast use. They are not evidence of the navigation bottleneck by themselves. Do not weaken security headers or change CDN transport globally to quiet them.

## Probe usage

Run `node scripts/navigation-stability-check.js` for local source. Set `STATIC_ROOT=dist` after `npm run utilities:build && npm run build:deploy` to exercise the packaged site. Set `NAV_STABILITY_URL=https://oliverdougherty.com` to use the live site. The release browser matrix also runs this probe against `dist` in Chromium, Firefox and WebKit on CI.
