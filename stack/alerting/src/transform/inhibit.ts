// stack/alerting/src/transform/inhibit.ts
// Native `inhibit_rules` from the estate's standing (config-as-code) suppressions plus expected-churn
// host classifications (04 §8, REQ-SUPP-01/02/03/04). Two transform-generated classes:
//   - known-expected → one inhibit rule carrying its mandatory rationale as a YAML comment (§8.1).
//   - expected-churn → ONE narrowly-scoped, host-scoped rule targeting the churn family ONLY (§8.2).
// `excluded` suppressions are enforced upstream and produce no rule here (§8.1). No generated
// target matcher may ever reference `alertname="DeadMansSwitch"` (§8.3, REQ-SUPP-04).
//
// A pure fragment generator: no file I/O, no clock, no secret resolution.

import type { EstateModel } from "./estate.js";
import { expectedChurnHosts, suppressedTargets, suppressionsOfClass } from "./estate.js";
import type { AmInhibitRule } from "./am-config.js";
import type { AlertingFinding } from "./findings.js";

/** The container churn/restart family — the ONLY alertnames an expected-churn rule may target
 *  (02 churn.yml, REQ-SUPP-03). Emitted as one anchored AM regex alternation. */
const CHURN_ALERTNAMES = ["ContainerRestarting", "ContainerChurn"] as const;
const CHURN_MATCHER = `alertname=~"${CHURN_ALERTNAMES.join("|")}"`;

/** Identity labels an inhibit rule may share between source and target (the `equal` set). */
const IDENTITY_LABELS = ["estate", "host", "service"] as const;

/** A parsed AM label matcher. */
export interface ParsedMatcher {
  label: string;
  op: "=" | "!=" | "=~" | "!~";
  value: string;
}

/** Parse an AM matcher `label<op>"value"`; returns null if it is not a well-formed matcher. */
export function parseMatcher(matcher: string): ParsedMatcher | null {
  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(=~|!~|!=|=)"([^"]*)"$/.exec(matcher.trim());
  if (!m) return null;
  return { label: m[1]!, op: m[2] as ParsedMatcher["op"], value: m[3]! };
}

/** Compile an AM regex-matcher value to a fully-anchored RegExp (AM anchors regex matchers). */
function anchored(value: string): RegExp {
  return new RegExp(`^(?:${value})$`);
}

/** Whether a candidate string satisfies a single parsed matcher's op/value. */
function matchValue(op: ParsedMatcher["op"], value: string, candidate: string): boolean {
  switch (op) {
    case "=":
      return candidate === value;
    case "!=":
      return candidate !== value;
    case "=~":
      return anchored(value).test(candidate);
    case "!~":
      return !anchored(value).test(candidate);
  }
}

/**
 * Whether an AND-combined `target_matchers` set admits an alert of the given `alertname`, considering
 * ONLY the alertname dimension (other labels held to match). A matcher on any other label imposes no
 * alertname constraint. Used by the expected-churn scope guard (§8.2) and item 012's guards.
 */
export function targetAdmitsAlertname(targetMatchers: string[], alertname: string): boolean {
  for (const raw of targetMatchers) {
    const p = parseMatcher(raw);
    if (!p || p.label !== "alertname") continue;
    if (!matchValue(p.op, p.value, alertname)) return false;
  }
  return true;
}

/** Whether a single matcher POSITIVELY references `alertname="DeadMansSwitch"` (`=` or `=~` that
 *  admits it). A `!=`/`!~` exclusion is not a positive reference. Guards REQ-SUPP-04 (§8.3). */
export function matcherReferencesDeadman(matcher: string): boolean {
  const p = parseMatcher(matcher);
  if (!p || p.label !== "alertname") return false;
  if (p.op === "=") return p.value === "DeadMansSwitch";
  if (p.op === "=~") return anchored(p.value).test("DeadMansSwitch");
  return false;
}

/** Extract the identity matchers (label ∈ IDENTITY_LABELS) from a parsed target, preserving order. */
function identityMatchers(parsed: ParsedMatcher[]): { matchers: string[]; labels: string[] } {
  const matchers: string[] = [];
  const labels: string[] = [];
  for (const p of parsed) {
    if ((IDENTITY_LABELS as readonly string[]).includes(p.label)) {
      matchers.push(renderMatcher(p));
      if (!labels.includes(p.label)) labels.push(p.label);
    }
  }
  return { matchers, labels };
}

/** Render a parsed matcher back to its canonical `label op "value"` string. */
function renderMatcher(p: ParsedMatcher): string {
  return `${p.label}${p.op}"${p.value}"`;
}

/** A stable sort key over a rule's source+target matcher sets (deterministic assembly, §12). */
function ruleSortKey(rule: AmInhibitRule): string {
  return JSON.stringify([rule.source_matchers, rule.target_matchers]);
}

/**
 * Generate native `inhibit_rules` from the estate's standing suppressions and expected-churn hosts.
 *
 * @param estate   - Reads `estate.suppressions` (standalone) + in-place marks + `Host.expectedChurn`.
 * @param findings - Accumulator: MISSING_RATIONALE (error) for a rationale-less known-expected
 *                   suppression; INVALID_SUPPRESSION (error) for a malformed matcher/target.
 * @returns The generated rules (sorted by a stable key) and a per-rule rationale-comment map.
 */
export function buildInhibitRules(
  estate: EstateModel,
  findings: AlertingFinding[],
): { rules: AmInhibitRule[]; comments: Map<AmInhibitRule, string> } {
  const rules: AmInhibitRule[] = [];
  const comments = new Map<AmInhibitRule, string>();

  const emit = (rule: AmInhibitRule, comment: string): void => {
    rules.push(rule);
    comments.set(rule, comment);
  };

  // ── known-expected: standalone suppressions + in-place host/service marks (§8.1) ───────────────
  for (const s of suppressionsOfClass(estate, "known-expected")) {
    buildKnownExpected(
      s.target,
      s.rationale,
      { file: "estate", path: `suppressions[target=${s.target}]` },
      findings,
      emit,
    );
  }
  for (const t of suppressedTargets(estate)) {
    if (t.mark.class !== "known-expected") continue;
    const target = `${t.kind}="${t.name}"`;
    buildKnownExpected(
      target,
      t.mark.rationale,
      { file: "estate", path: `${t.kind}[name=${t.name}].suppressed` },
      findings,
      emit,
    );
  }

  // ── expected-churn: one narrow, host-scoped rule per churn-classified host (§8.2) ──────────────
  for (const host of churnHostRationales(estate)) {
    const hostMatcher = `host="${host.name}"`;
    // Guard REQ-SUPP-04 defensively — a malformed host name that breaks the matcher is INVALID.
    if (parseMatcher(hostMatcher) === null) {
      findings.push({
        severity: "error",
        code: "INVALID_SUPPRESSION",
        file: "estate",
        path: `host[name=${host.name}].expectedChurn`,
        message: `Expected-churn host name "${host.name}" cannot form a valid AM label matcher.`,
        fix: "Use a host name without embedded quotes/backslashes.",
      });
      continue;
    }
    const rule: AmInhibitRule = {
      source_matchers: [hostMatcher],
      target_matchers: [hostMatcher, CHURN_MATCHER], // churn family ONLY (§8.2)
      equal: ["estate", "host"],
    };
    emit(rule, `rationale: ${host.rationale}`);
  }

  rules.sort((a, b) => (ruleSortKey(a) < ruleSortKey(b) ? -1 : ruleSortKey(a) > ruleSortKey(b) ? 1 : 0));
  return { rules, comments };
}

/** Build ONE known-expected inhibit rule from a target string + rationale, pushing findings and
 *  emitting the rule (with its rationale comment) only when it is well-formed and un-suppressible. */
function buildKnownExpected(
  target: string,
  rationale: string | undefined,
  loc: { file: string; path: string },
  findings: AlertingFinding[],
  emit: (rule: AmInhibitRule, comment: string) => void,
): void {
  if (rationale === undefined || rationale.trim().length === 0) {
    findings.push({
      severity: "error",
      code: "MISSING_RATIONALE",
      file: loc.file,
      path: loc.path,
      message: "A known-expected suppression must carry a rationale; none was declared.",
      fix: "Add a rationale explaining why this condition is a known-expected exception.",
    });
    return;
  }

  const elements = target
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (elements.length === 0) {
    pushInvalidSuppression(findings, loc, `Suppression target "${target}" is empty.`);
    return;
  }

  const parsed: ParsedMatcher[] = [];
  for (const el of elements) {
    const p = parseMatcher(el) ?? parseBareIdentity(el);
    if (p === null) {
      pushInvalidSuppression(
        findings,
        loc,
        `Suppression target element "${el}" is not a valid AM matcher or host identity.`,
      );
      return;
    }
    // NEVER construct a target matcher that references alertname="DeadMansSwitch" (§8.3, REQ-SUPP-04).
    if (matcherReferencesDeadman(renderMatcher(p))) {
      pushInvalidSuppression(
        findings,
        loc,
        'A suppression may not target alertname="DeadMansSwitch" (REQ-SUPP-04).',
      );
      return;
    }
    parsed.push(p);
  }

  const target_matchers = parsed.map(renderMatcher);
  const identity = identityMatchers(parsed);
  const source_matchers = identity.matchers.length > 0 ? identity.matchers : [...target_matchers];
  const rule: AmInhibitRule = { source_matchers, target_matchers };
  if (identity.labels.length > 0) rule.equal = [...identity.labels];
  emit(rule, `rationale: ${rationale.trim()}`);
}

/** Interpret a bare (no-operator) target element as a `host="<id>"` matcher, if it is a safe id. */
function parseBareIdentity(element: string): ParsedMatcher | null {
  if (/^[A-Za-z0-9_.:-]+$/.test(element)) {
    return { label: "host", op: "=", value: element };
  }
  return null;
}

function pushInvalidSuppression(
  findings: AlertingFinding[],
  loc: { file: string; path: string },
  message: string,
): void {
  findings.push({
    severity: "error",
    code: "INVALID_SUPPRESSION",
    file: loc.file,
    path: loc.path,
    message,
    fix: 'Use AM matchers of the form label="value" (or label=~"regex"); scope by host/service/severity.',
  });
}

/** A churn-classified host and the rationale carried on its generated inhibit rule. */
interface ChurnHost {
  name: string;
  rationale: string;
}

/** The set of hosts that get an expected-churn rule: `Host.expectedChurn === true` plus any in-place
 *  `expected-churn` mark (a service mark resolves to its owning host). Deduped, insertion-ordered. */
function churnHostRationales(estate: EstateModel): ChurnHost[] {
  const byName = new Map<string, string>();
  const defaultRationale = (name: string): string =>
    `${name} is an expected-churn host (container churn is expected)`;

  for (const h of expectedChurnHosts(estate)) {
    if (!byName.has(h.name)) byName.set(h.name, defaultRationale(h.name));
  }
  for (const t of suppressedTargets(estate)) {
    if (t.mark.class !== "expected-churn") continue;
    const hostName = t.kind === "host" ? t.name : owningHost(estate, t.name);
    if (hostName === undefined) continue;
    // A declared mark's rationale wins over the synthesized default.
    byName.set(hostName, t.mark.rationale.trim().length > 0 ? t.mark.rationale.trim() : defaultRationale(hostName));
  }
  return [...byName.entries()].map(([name, rationale]) => ({ name, rationale }));
}

/** The owning host name of a service, or undefined if the service is unknown. */
function owningHost(estate: EstateModel, serviceName: string): string | undefined {
  return estate.services.find((s) => s.name === serviceName)?.host;
}
