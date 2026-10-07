/** Proposal ids and file names (browser-safe; imports nothing). Names are built only from validated
 *  ids, so no traversal-bearing path can be produced. */

/** Proposal id: `p-YYYYMMDDTHHMMSSZ-<8 lowercase hex>`. */
export const PROPOSAL_ID_RE = /^p-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
/** Directory entry names the scanners accept (anchored; no path separators possible). */
export const PROPOSAL_FILE_RE = /^(p-\d{8}T\d{6}Z-[0-9a-f]{8})\.proposal\.json$/;
/** Result-sidecar entry names (`<id>.result.json`); anchored, so no path separators possible. */
export const RESULT_FILE_RE = /^(p-\d{8}T\d{6}Z-[0-9a-f]{8})\.result\.json$/;

/** Default randomness: Web Crypto (Bun, Node ≥ 19, browsers). Keeps this module browser-safe. */
const defaultRandomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * New proposal id from the UTC time and 4 random bytes.
 * @param now - Creation instant (the same Date is used for `payload.createdAt`).
 * @param randomBytes - Injected for tests; must return exactly `n` bytes.
 * @throws TypeError on an invalid Date or a wrong-length random buffer (programming fault).
 * @example newProposalId(new Date("2026-09-28T14:03:07.512Z"), () => Uint8Array.of(0xde, 0xad, 0xbe, 0xef)) === "p-20260928T140307Z-deadbeef"
 */
export function newProposalId(now: Date = new Date(), randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  if (Number.isNaN(now.getTime())) throw new TypeError("invalid date");
  const r = randomBytes(4);
  if (r.length !== 4) throw new TypeError("randomBytes returned wrong length");
  const iso = now.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  const hex = Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
  return `p-${stamp}-${hex}`;
}

/** `<id>.proposal.json`. @throws TypeError unless `PROPOSAL_ID_RE.test(id)`, so no traversal-bearing name can be built. */
export function proposalFileName(id: string): string { assertId(id); return `${id}.proposal.json`; }
/** `<id>.result.json`. @throws TypeError unless `PROPOSAL_ID_RE.test(id)`. */
export function resultFileName(id: string): string { assertId(id); return `${id}.result.json`; }
/** Extract the id from a directory entry name, or null when it is not a proposal file. */
export function parseProposalFileName(name: string): string | null { return PROPOSAL_FILE_RE.exec(name)?.[1] ?? null; }

function assertId(id: string): void { if (!PROPOSAL_ID_RE.test(id)) throw new TypeError("invalid proposal id"); }
