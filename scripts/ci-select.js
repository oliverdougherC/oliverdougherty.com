#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCheckPlan, createPrPlan, PR_LANE_ORDER } = require('./release-check');

const GROUPS = ['navigation', 'home', 'gallery', 'utilities', 'artifact', 'cache'];
const UTILITIES = ['navigation', 'utilities', 'artifact', 'cache'];
const HOME = ['navigation', 'home'];
// Full-suite runs (main, nightly, manual, release validation) shard by release
// group across all three browsers. Pull requests run the targeted PR lanes:
// every suite once in Chromium (split into parallel lanes) plus the always-on
// Firefox/WebKit sweep of the shared packaged surface. Cross-engine depth for
// individual features belongs to the nightly/manual/explicit full suite.
const SWEEP_LANE = 'cross-engine-sweep';
const checkGroups = new Map(createCheckPlan().map((check) => [check.name, check.group]));
const prLaneContents = createPrPlan();
const PR_LANES = PR_LANE_ORDER;

function prLanesForGroups(groups) {
  if (!groups.length) return [];
  const selected = PR_LANES.filter((lane) =>
    lane === SWEEP_LANE || prLaneContents[lane].some((check) => groups.includes(checkGroups.get(check.name))));
  // The sweep runs even when its own groups were not touched: it is the only
  // cross-engine evidence a PR produces, and its cost is fixed and small.
  return [...new Set(selected)].filter((lane) => PR_LANES.includes(lane));
}

function laneReason(lane, groups, reasons, fallback) {
  if (lane === SWEEP_LANE) return 'Always-on Firefox/WebKit sweep of the shared packaged surface.';
  const trigger = prLaneContents[lane].map((check) => checkGroups.get(check.name)).find((group) => groups.includes(group));
  return (trigger && reasons[trigger]) || fallback;
}

function selection(inputGroups, reason, files = [], reasons = {}, laneProfile = 'full') {
  const groups = GROUPS.filter((group) => inputGroups.includes(group));
  const lanes = laneProfile === 'pr' ? prLanesForGroups(groups) : groups;
  return {
    groups,
    lanes,
    hasRegressions: lanes.length > 0,
    laneProfile,
    reason,
    files,
    decisions: Object.fromEntries((laneProfile === 'pr' ? PR_LANES : GROUPS).map((lane) => [lane, {
      selected: lanes.includes(lane),
      reason: lanes.includes(lane)
        ? (laneProfile === 'pr' ? laneReason(lane, groups, reasons, reason) : (reasons[lane] || reason))
        : `No changed path requires this ${laneProfile === 'pr' ? 'lane' : 'group'}.`
    }]))
  };
}

function groupsForPath(file) {
  // Only known non-runtime documentation may omit browser regressions. In particular,
  // assets/photos/descriptions.md is runtime input and must not be treated as docs.
  if (/^docs\//.test(file) || /^(README\.md|AGENTS\.md)$/.test(file) ||
      /^\.github\/(ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\.md$)/.test(file)) return [];
  if (/^(scripts\/|config\/|utilities-src\/tests\/|\.github\/workflows\/)/.test(file)) return GROUPS;
  if (/^(utilities-src\/(src|vm-src)\/|pages\/utilities\/|assets\/utilities\/)/.test(file) ||
      /^(js\/utilities-(shell|legacy-recovery)\.js|css\/utilities\.css)$/.test(file)) return UTILITIES;
  if (/^(pages\/gallery\/|mobile\/gallery\/|assets\/photos\/)/.test(file) ||
      /^(js\/(gallery|mobile-gallery)\.js|css\/(gallery|mobile-gallery)\.css)$/.test(file)) return ['navigation', 'gallery', 'artifact'];
  if (/^(index\.html|mobile\/index\.html|js\/(home-interactions|nighthawks|project-motion|keiri-motion|resume-typing)\.js|css\/(home|resume|project-motion)\.css)$/.test(file) ||
      /^(pages\/resume\/|mobile\/resume\/|assets\/(art|project-motion|OSU|images)\/|css\/project-motion\/)/.test(file)) return HOME;
  // Shared navigation, styles, fonts, build/dependency changes and unfamiliar paths
  // are deliberately broad. New feature directories must opt into a narrower rule.
  return GROUPS;
}

function classifyPaths(files, laneProfile = 'full') {
  const selected = new Set();
  const reasons = {};
  for (const file of files) {
    for (const group of groupsForPath(file)) {
      selected.add(group);
      reasons[group] ||= `Required by changed path: ${file}`;
    }
  }
  return selection([...selected], files.length ? 'Selected from the complete changed-file diff.' : 'No changed files.', files, reasons, laneProfile);
}

function validSha(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$/.test(value) && !/^0+$/.test(value);
}

function changedPaths(cwd, base, head, mergeBase = false) {
  if (!validSha(base) || !validSha(head)) throw new Error('Cannot classify changes: missing or invalid commit SHA.');
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
  let from = base;
  if (mergeBase) {
    from = git(['merge-base', base, head]).trim();
    if (!validSha(from)) throw new Error('Cannot classify changes: no valid merge base.');
  }
  // Disable rename detection so both old and new names participate in classification.
  const output = git(['diff', '--name-only', '-z', '--no-renames', from, head, '--']);
  return output.split('\0').filter(Boolean);
}

function selectForEvent({ eventName, event, ref, cwd = process.cwd() }) {
  if (eventName === 'schedule' || eventName === 'workflow_dispatch' ||
      (eventName === 'push' && ref === 'refs/heads/main')) {
    return selection(GROUPS, `Full validation for ${eventName}${ref ? ` on ${ref}` : ''}.`);
  }
  if (eventName === 'pull_request') {
    return classifyPaths(changedPaths(cwd, event?.pull_request?.base?.sha, event?.pull_request?.head?.sha, true), 'pr');
  }
  if (eventName === 'push' && ref === 'refs/heads/beta') {
    if (!validSha(event?.before)) return selection(GROUPS, 'Full validation: beta push has no usable previous commit.');
    return classifyPaths(changedPaths(cwd, event.before, event.after), 'pr');
  }
  return selection(GROUPS, `Full validation for unsupported event/ref: ${eventName}/${ref}.`);
}

function renderSummary(result) {
  const escape = (value) => String(value).replace(/[&<>|\r\n]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '\r': ' ', '\n': ' ' })[character]);
  const rows = result.laneProfile === 'pr' ? PR_LANES : GROUPS;
  const heading = result.laneProfile === 'pr' ? 'PR lanes (Chromium suites + Firefox/WebKit sweep)' : 'Groups';
  return `## CI regression selection\n\n${escape(result.reason)}\n\n` +
    `| ${heading} | Decision | Reason |\n| --- | --- | --- |\n` +
    rows.map((row) => `| ${row} | ${result.decisions[row].selected ? 'Run' : 'Omit'} | ${escape(result.decisions[row].reason)} |`).join('\n') + '\n';
}

function writeSelection(result, env = process.env, cwd = process.cwd()) {
  const directory = path.join(cwd, 'output', 'ci');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'selection.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT,
    `groups=${JSON.stringify(result.groups)}\nlanes=${JSON.stringify(result.lanes)}\nlane-profile=${result.laneProfile}\nhas-regressions=${result.hasRegressions}\n`);
  const summary = renderSummary(result);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return summary;
}

if (require.main === module) {
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = selectForEvent({ eventName: process.env.GITHUB_EVENT_NAME, event, ref: process.env.GITHUB_REF });
    console.log(writeSelection(result));
  } catch (error) {
    console.error(`CI selection failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { GROUPS, PR_LANES, classifyPaths, changedPaths, prLanesForGroups, selectForEvent, renderSummary, writeSelection };
