/* Migration endpoint for utility entry/chunk URLs used before content hashing. */
(function () {
  'use strict';
  if (document.getElementById('utilityLoadRecovery')) return;
  const notice = document.createElement('div');
  notice.id = 'utilityLoadRecovery';
  notice.setAttribute('role', 'alert');
  // Cached HTML may also have cached CSS from before the recovery UI existed.
  notice.style.cssText = 'position:fixed;top:48px;right:20px;z-index:100;max-width:min(360px,calc(100vw - 40px));padding:16px;border:1px solid #7050c0;background:#fff;color:#111;font:14px/1.5 sans-serif';
  const message = document.createElement('p');
  message.textContent = 'A newer version of these tools is available. Reload to continue.';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload tools';
  reload.style.cssText = 'padding:8px 12px;border:1px solid #7050c0;background:#7050c0;color:#fff;font:inherit;cursor:pointer';
  reload.addEventListener('click', () => window.location.reload());
  notice.append(message, reload);
  document.body.append(notice);
})();
