/**
 * Dashboard status checks.
 * Performs lightweight runtime availability checks for self-hosted services.
 */

const STATUS_TIMEOUT_MS = 4500;
const STATUS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

document.addEventListener('DOMContentLoaded', () => {
  initServiceStatusChecks();
});

function initServiceStatusChecks() {
  const cards = Array.from(document.querySelectorAll('.service-card[data-health-url]'));
  if (!cards.length) return;

  const refreshButton = document.getElementById('servicesRefreshBtn');
  let lastRunAt = 0;
  let isChecking = false;

  const runChecks = async () => {
    if (isChecking) return;
    isChecking = true;
    lastRunAt = Date.now();

    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Checking...';
    }

    const results = await Promise.all(cards.map((card) => checkServiceCard(card)));

    updateStatusSummary(results);
    updateLastCheckedTime();

    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh Status';
    }

    isChecking = false;
  };

  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      runChecks();
    });
  }

  runChecks();

  const intervalId = window.setInterval(() => {
    if (document.hidden) return;
    runChecks();
  }, STATUS_REFRESH_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (Date.now() - lastRunAt > 20 * 1000) {
      runChecks();
    }
  });

  window.addEventListener('beforeunload', () => {
    window.clearInterval(intervalId);
  }, { once: true });
}

async function checkServiceCard(card) {
  const healthUrl = card.dataset.healthUrl || card.href;
  const serviceName = card.querySelector('.service-name')?.textContent?.trim() || 'Service';

  setServiceStatus(card, {
    state: 'checking',
    label: 'Checking...',
    title: `${serviceName}: checking now`
  });

  const started = performance.now();

  try {
    await fetchWithTimeout(healthUrl, STATUS_TIMEOUT_MS);

    const latencyMs = Math.max(1, Math.round(performance.now() - started));

    setServiceStatus(card, {
      state: 'online',
      label: 'Reachable',
      title: `${serviceName}: reachable (${latencyMs}ms)`
    });

    return {
      state: 'reachable',
      latencyMs
    };
  } catch (_err) {
    setServiceStatus(card, {
      state: 'offline',
      label: 'Unreachable',
      title: `${serviceName}: unreachable`
    });

    return {
      state: 'unreachable',
      latencyMs: null
    };
  }
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  // Note: mode:'no-cors' returns opaque responses — all non-network-error
  // responses (including 4xx/5xx) resolve successfully. This means we can
  // only distinguish "server reachable" (resolves) from "unreachable/timed
  // out" (throws). For a personal uptime indicator this is an acceptable
  // tradeoff without a CORS-enabled proxy on each service.
  return fetch(url, {
    method: 'GET',
    mode: 'no-cors',
    cache: 'no-store',
    redirect: 'follow',
    signal: controller.signal
  }).finally(() => {
    window.clearTimeout(timeout);
  });
}

function setServiceStatus(card, status) {
  const badge = card.querySelector('[data-service-status]');
  if (!badge) return;

  badge.classList.remove('online', 'offline', 'checking');
  badge.classList.add(status.state);

  const textEl = badge.querySelector('.status-text');
  if (textEl) {
    textEl.textContent = status.label;
  } else {
    badge.textContent = status.label;
  }

  badge.title = status.title;
  badge.setAttribute('aria-label', status.title);
}

function updateStatusSummary(results) {
  const summaryEl = document.getElementById('servicesStatusSummary');
  if (!summaryEl) return;

  const total = results.length;
  const reachable = results.filter((result) => result.state === 'reachable');
  const unreachable = results.filter((result) => result.state === 'unreachable');

  let summary = `${reachable.length}/${total} services reachable`;

  if (unreachable.length > 0) {
    summary += `, ${unreachable.length} unreachable`;
  }

  if (reachable.length > 0) {
    const avgLatency = Math.round(
      reachable.reduce((sum, result) => sum + result.latencyMs, 0) / reachable.length
    );
    summary += ` · avg ${avgLatency}ms`;
  }

  summaryEl.textContent = summary;
}

function updateLastCheckedTime() {
  const lastCheckedEl = document.getElementById('servicesLastChecked');
  if (!lastCheckedEl) return;

  const now = new Date();
  const formatted = now.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });

  lastCheckedEl.textContent = `Last checked: ${formatted}`;
}
