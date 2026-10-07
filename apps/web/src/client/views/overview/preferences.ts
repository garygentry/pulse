// preferences.ts — guarded, versioned persistence of the overview presentation record.
// Pure module: callers inject an OverviewPreferenceStorage adapter (or null); this module
// never touches browser globals, never throws on storage failure, and never partially
// accepts an invalid record. Only the five known v1 fields are ever read or written.
import {
  DEFAULT_OVERVIEW_PREFERENCES,
  MAX_COLLAPSED_GROUP_IDS,
  MAX_PREFERENCE_ID_LENGTH,
  OVERVIEW_PREFERENCES_KEY,
  OVERVIEW_PREFERENCES_VERSION,
  type GroupMode,
  type OverviewModel,
  type OverviewPreferenceStorage,
  type OverviewPreferencesV1,
  type PreferenceReadResult,
  type SortMode,
} from "./model.js";

const GROUP_MODES: ReadonlySet<string> = new Set<GroupMode>(["class", "status", "name"]);
const SORT_MODES: ReadonlySet<string> = new Set<SortMode>(["class", "status", "name"]);

type DefaultedReason = Extract<PreferenceReadResult, { status: "defaulted" }>["reason"];

function defaulted(reason: DefaultedReason): PreferenceReadResult {
  return { status: "defaulted", value: DEFAULT_OVERVIEW_PREFERENCES, reason };
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PREFERENCE_ID_LENGTH;
}

/**
 * Closed validation shared by read and write. Returns a new frozen record containing only
 * the known v1 fields (collapsed ids deduplicated, first occurrence kept), or null when any
 * field is invalid. Caps are rejection limits, never truncation rules.
 */
function validateRecord(record: Readonly<Record<string, unknown>>): OverviewPreferencesV1 | null {
  const { groupBy, sortBy, collapsedGroupIds, selectedTargetId } = record;
  if (typeof groupBy !== "string" || !GROUP_MODES.has(groupBy)) return null;
  if (typeof sortBy !== "string" || !SORT_MODES.has(sortBy)) return null;
  if (!Array.isArray(collapsedGroupIds) || collapsedGroupIds.length > MAX_COLLAPSED_GROUP_IDS) {
    return null;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of collapsedGroupIds as readonly unknown[]) {
    if (!isValidId(id)) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (selectedTargetId !== null && !isValidId(selectedTargetId)) return null;
  return Object.freeze({
    version: OVERVIEW_PREFERENCES_VERSION,
    groupBy: groupBy as GroupMode,
    sortBy: sortBy as SortMode,
    collapsedGroupIds: Object.freeze(ids),
    selectedTargetId,
  });
}

function removeBestEffort(storage: OverviewPreferenceStorage): void {
  try {
    storage.remove(OVERVIEW_PREFERENCES_KEY);
  } catch {
    // Cleanup is best effort; defaults are returned regardless.
  }
}

/**
 * Read, parse, and fully validate the one versioned overview preference record.
 * Invalid or unsupported records are best-effort removed and defaults are returned.
 *
 * @param storage - Guarded browser-local string storage, or null when unavailable.
 * @returns Valid preferences and whether defaults were required.
 */
export function readOverviewPreferences(
  storage: OverviewPreferenceStorage | null,
): PreferenceReadResult {
  if (storage === null) return defaulted("unavailable");
  let raw: string | null;
  try {
    raw = storage.get(OVERVIEW_PREFERENCES_KEY);
  } catch {
    return defaulted("unavailable");
  }
  if (raw === null) return defaulted("missing");
  if (typeof raw !== "string") {
    removeBestEffort(storage);
    return defaulted("malformed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removeBestEffort(storage);
    return defaulted("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    removeBestEffort(storage);
    return defaulted("malformed");
  }

  const record = parsed as Readonly<Record<string, unknown>>;
  if (record.version !== OVERVIEW_PREFERENCES_VERSION) {
    removeBestEffort(storage);
    return defaulted("unsupported");
  }
  const value = validateRecord(record);
  if (value === null) {
    removeBestEffort(storage);
    return defaulted("invalid");
  }
  return { status: "ok", value };
}

/**
 * Validate and persist the complete preference record as one JSON value.
 *
 * @param storage - Guarded per-browser storage, or null to disable persistence.
 * @param value - Complete v1 record; runtime validation still rejects forged input.
 * @returns True only when serialization and storage both complete successfully.
 */
export function writeOverviewPreferences(
  storage: OverviewPreferenceStorage | null,
  value: OverviewPreferencesV1,
): boolean {
  if (storage === null) return false;
  try {
    if (typeof value !== "object" || value === null) return false;
    if (value.version !== OVERVIEW_PREFERENCES_VERSION) return false;
    const valid = validateRecord(value as unknown as Readonly<Record<string, unknown>>);
    if (valid === null) return false;
    // Exactly the five known fields, in declaration order; nothing else is ever serialized.
    const serialized = JSON.stringify({
      version: valid.version,
      groupBy: valid.groupBy,
      sortBy: valid.sortBy,
      collapsedGroupIds: valid.collapsedGroupIds,
      selectedTargetId: valid.selectedTargetId,
    });
    storage.set(OVERVIEW_PREFERENCES_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove group and selection ids that do not exist in the current model.
 * Returns the original object when no field changes, preventing write/render churn.
 *
 * @param preferences - Valid persisted or in-memory preferences.
 * @param model - Model derived from the currently accepted snapshot.
 * @returns Reconciled preferences safe to apply to the current estate.
 */
export function reconcileOverviewPreferences(
  preferences: OverviewPreferencesV1,
  model: OverviewModel,
): OverviewPreferencesV1 {
  const groupIds = new Set(model.groups.map((group) => group.id));
  const collapsed = preferences.collapsedGroupIds.filter((id) => groupIds.has(id));
  const collapsedChanged = collapsed.length !== preferences.collapsedGroupIds.length;
  const selectedTargetId =
    preferences.selectedTargetId !== null && model.targetById.has(preferences.selectedTargetId)
      ? preferences.selectedTargetId
      : null;
  const selectionChanged = selectedTargetId !== preferences.selectedTargetId;
  if (!collapsedChanged && !selectionChanged) return preferences;
  return Object.freeze({
    ...preferences,
    collapsedGroupIds: collapsedChanged ? Object.freeze(collapsed) : preferences.collapsedGroupIds,
    selectedTargetId,
  });
}
