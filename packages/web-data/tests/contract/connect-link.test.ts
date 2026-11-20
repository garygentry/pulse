/** connect-link.test.ts — base-URL normalisation, link building and the reference link validator.
 *
 *  Rows marked W depend on a WHATWG URL-parser quirk and are pinned against Bun's `URL`. */

import { describe, expect, test } from "bun:test";
import {
  CONNECT_LINK_FORMAT_VERSION,
  CONNECT_LINK_HOST,
  CONNECT_LINK_MAX_LENGTH,
  CONNECT_LINK_SCHEME,
  KNOWN_LINK_PARAMS,
  LINK_PARAM_NAME_PATTERN,
  RESERVED_LINK_PARAMS,
  buildConnectLink,
  isLoopbackHost,
  normaliseBaseUrl,
  parseConnectLink,
  type ConnectLinkRefusal,
  type ConnectLinkRejection,
} from "../../src/contract/connect-link.js";
import { ContractError } from "../../src/contract/errors.js";

const BASE = "https://pulse.example.com";
const ENCODED_BASE = "https%3A%2F%2Fpulse.example.com";
const LINK = `pulse://connect?v=1&url=${ENCODED_BASE}`;

/** [input, normalised base] */
const OK_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["https://pulse.example.com", "https://pulse.example.com"],
  ["https://pulse.example.com/", "https://pulse.example.com"],
  ["HTTPS://Pulse.Example.COM:443/", "https://pulse.example.com"],
  ["https://pulse.example.com:0443", "https://pulse.example.com"], // W: default port with a leading zero
  ["https://pulse.example.com:8443/", "https://pulse.example.com:8443"],
  ["https://pulse.example.com//pulse///ui/", "https://pulse.example.com/pulse/ui"],
  ["https://pulse.example.com/pulse/?tab=1#top", "https://pulse.example.com/pulse"],
  ["https://pulse.example.com/a/./b/../c", "https://pulse.example.com/a/c"],
  ["https://pulse.example.com/my%2fdir/%7euser", "https://pulse.example.com/my%2Fdir/%7Euser"],
  ["https://pulse.example.com/a b/ü", "https://pulse.example.com/a%20b/%C3%BC"],
  ["https://bücher.example/", "https://xn--bcher-kva.example"],
  ["https://[2001:DB8:0:0:0:0:0:1]:443/", "https://[2001:db8::1]"],
  ["https://198.51.100.7/pulse", "https://198.51.100.7/pulse"],
  ["https://192.0.2.010/", "https://192.0.2.8"], // W: octal part
  ["https://0xC0.0.2.1", "https://192.0.2.1"], // W: hex part
  ["  https://pulse.example.com\n", "https://pulse.example.com"], // W: surrounding whitespace
  ["https:pulse.example.com", "https://pulse.example.com"], // W: missing slashes
  ["https:\\\\pulse.example.com\\ui", "https://pulse.example.com/ui"], // W: backslashes
  ["https://@pulse.example.com", "https://pulse.example.com"], // W: empty userinfo
  ["https://pulse.example.com./", "https://pulse.example.com."],
  ["https://10.0.0.1", "https://10.0.0.1"],
  ["https://203.0.113.9:8443", "https://203.0.113.9:8443"],
  // The deprecated IPv4-compatible form is not loopback: WHATWG serialises it as plain IPv6.
  ["https://[::127.0.0.1]", "https://[::7f00:1]"],
];

const REFUSED_ROWS: ReadonlyArray<readonly [string, ConnectLinkRefusal]> = [
  ["https://user:secret@pulse.example.com", "credentials"],
  ["https://user@pulse.example.com", "credentials"],
  ["http://user:secret@pulse.example.com", "credentials"], // credentials precede the scheme check
  ["http://pulse.example.com", "not-https"],
  ["ftp://pulse.example.com", "not-https"],
  ["pulse.example.com:8443", "not-https"], // W: parses with scheme `pulse.example.com:`
  ["http://localhost:8080", "not-https"], // the scheme check precedes loopback
  ["pulse.example.com", "unparseable"],
  ["", "unparseable"],
  ["https://", "unparseable"],
  ["https://pulse.example.com:99999", "unparseable"],
  ["https://bad host.test/", "unparseable"],
  ["https://localhost:8443", "loopback"],
  ["https://app.localhost", "loopback"],
  ["https://localhost./", "loopback"],
  ["https://127.0.0.1", "loopback"],
  ["https://127.1", "loopback"], // W: short IPv4 form
  ["https://[::1]", "loopback"],
  ["https://[::]", "loopback"],
  ["https://0.0.0.0", "loopback"],
  ["https://[::ffff:127.0.0.1]", "loopback"], // W: serialised as [::ffff:7f00:1]
];

describe("constants", () => {
  test("have their pinned values", () => {
    expect(CONNECT_LINK_SCHEME).toBe("pulse:");
    expect(CONNECT_LINK_HOST).toBe("connect");
    expect(CONNECT_LINK_FORMAT_VERSION).toBe(1);
    expect(CONNECT_LINK_MAX_LENGTH).toBe(256);
    expect([...RESERVED_LINK_PARAMS]).toEqual(["v", "url"]);
    expect([...KNOWN_LINK_PARAMS]).toEqual(["pair"]);
    expect(Object.isFrozen(KNOWN_LINK_PARAMS)).toBe(true);
    expect(Object.isFrozen(RESERVED_LINK_PARAMS)).toBe(true);
    expect(LINK_PARAM_NAME_PATTERN.flags).toBe("");
  });

  test("every known link parameter is a valid, unreserved name", () => {
    for (const name of KNOWN_LINK_PARAMS) {
      expect(name).toMatch(LINK_PARAM_NAME_PATTERN);
      expect((RESERVED_LINK_PARAMS as readonly string[]).includes(name)).toBe(false);
    }
  });
});

describe("isLoopbackHost", () => {
  test.each([
    "localhost", "LOCALHOST.", "a.localhost", "127.255.0.1", "[::1]", "::", "0.0.0.0", "0.1.2.3",
    "::ffff:7f00:1", "::ffff:0.0.0.0", "[::ffff:7f00:1]",
  ])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  test.each([
    "10.0.0.1", "192.0.2.1", "2001:db8::1", "localhost.example", "pulse.example.com", "",
    // IPv4-compatible (deprecated) in the form `URL.hostname` produces: plain IPv6, not loopback.
    "::7f00:1", "[::7f00:1]",
    // NAT64
    "64:ff9b::7f00:1",
  ])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  test("the dotted IPv4-compatible spelling is read as loopback by the address parser", () => {
    // ipaddr.js reads `::a.b.c.d` as an IPv4-mapped address. A URL host never has this spelling (it is
    // serialised as `::7f00:1`, covered above), so this only errs on the cautious side for raw strings.
    expect(isLoopbackHost("::127.0.0.1")).toBe(true);
  });

  test("never throws on junk", () => {
    for (const junk of ["[", "]", "[]", ".", "..", "%", "[::1", "999.999.999.999", "\u0000", "x".repeat(10_000)]) {
      expect(() => isLoopbackHost(junk)).not.toThrow();
    }
  });
});

describe("normaliseBaseUrl", () => {
  test.each(OK_ROWS)("%j → %s", (input, expected) => {
    const result = normaliseBaseUrl(input);
    expect(result).toEqual({ ok: true, baseUrl: expected });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test.each(OK_ROWS)("is idempotent for %j", (_input, expected) => {
    expect(normaliseBaseUrl(expected)).toEqual({ ok: true, baseUrl: expected });
  });

  test.each(REFUSED_ROWS)("%j is refused as %s", (input, refusal) => {
    const result = normaliseBaseUrl(input);
    expect(result).toEqual({ ok: false, refusal });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("never reports too-long, whatever the length", () => {
    const long = `${BASE}/${"a".repeat(5000)}`;
    expect(normaliseBaseUrl(long)).toEqual({ ok: true, baseUrl: long });
  });

  test("keeps %2F as an escape rather than a slash", () => {
    expect(normaliseBaseUrl(`${BASE}/a%2f%2fb/`)).toEqual({ ok: true, baseUrl: `${BASE}/a%2F%2Fb` });
  });
});

describe("buildConnectLink", () => {
  test("builds the documented example", () => {
    const result = buildConnectLink("https://Pulse.Example.com:443/");
    expect(result).toEqual({ ok: true, link: LINK, baseUrl: BASE });
    expect(LINK.length).toBe(55);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("orders parameters v, url, then extras sorted by name", () => {
    const result = buildConnectLink(BASE, { zz: "1", aa: "2", "m-1": "3" });
    expect(result).toEqual({ ok: true, link: `${LINK}&aa=2&m-1=3&zz=1`, baseUrl: BASE });
  });

  test("form-encodes %, space and + in the base and in extra values", () => {
    const result = buildConnectLink(`${BASE}/a%2Fb`, { aa: "x y+z%" });
    expect(result).toEqual({
      ok: true,
      link: `${LINK}%2Fa%252Fb&aa=x+y%2Bz%25`,
      baseUrl: `${BASE}/a%2Fb`,
    });
  });

  test.each(["v", "url", "V", "1a", "a_b", "", "a".repeat(33), "__proto__", "a b"])(
    "extra name %j throws LINK_PARAM_INVALID",
    (name) => {
      const extras = Object.fromEntries([[name, "x"]]);
      for (const base of [BASE, "not a url"]) {
        let thrown: unknown;
        try {
          buildConnectLink(base, extras);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ContractError);
        expect((thrown as ContractError).code).toBe("LINK_PARAM_INVALID");
        expect((thrown as ContractError).subject).toBe(name);
      }
    },
  );

  test("accepts any well-formed extra name, known or not", () => {
    expect(buildConnectLink(BASE, { "future-thing": "x", ["a".repeat(32)]: "y" }).ok).toBe(true);
  });

  test.each(REFUSED_ROWS)("%j passes the %s refusal through", (input, refusal) => {
    expect(buildConnectLink(input)).toEqual({ ok: false, refusal });
  });

  test("a 256-character link is ok and parses; 257 is too-long", () => {
    // The fixed prefix is 24 characters and the encoded base without its path is 31.
    const at = (pathLength: number): string => `${BASE}/${"a".repeat(pathLength)}`;
    const fits = buildConnectLink(at(198));
    if (!fits.ok) throw new Error(`expected ok, got ${fits.refusal}`);
    expect(fits.link.length).toBe(CONNECT_LINK_MAX_LENGTH);
    expect(parseConnectLink(fits.link)).toEqual({ ok: true, formatVersion: 1, baseUrl: at(198), params: {} });

    expect(buildConnectLink(at(199))).toEqual({ ok: false, refusal: "too-long" });
    expect(buildConnectLink(at(194), { aa: "1" })).toEqual({ ok: false, refusal: "too-long" });
    expect(buildConnectLink(at(193), { aa: "1" }).ok).toBe(true);
  });

  test("is deterministic, whatever the key insertion order", () => {
    const a = buildConnectLink("https://Pulse.Example.com/x/", { bb: "2", aa: "1" });
    const b = buildConnectLink("https://Pulse.Example.com/x/", { aa: "1", bb: "2" });
    expect(a).toEqual(b);
    expect(buildConnectLink(BASE)).toEqual(buildConnectLink(BASE));
  });

  test("never carries credentials", () => {
    expect(buildConnectLink("https://user:secret@pulse.example.com")).toEqual({ ok: false, refusal: "credentials" });
  });
});

describe("parseConnectLink", () => {
  const rejects = (link: string, rejection: ConnectLinkRejection): void => {
    const result = parseConnectLink(link);
    expect(result).toEqual({ ok: false, rejection });
    expect(Object.isFrozen(result)).toBe(true);
  };

  test("accepts the plain link", () => {
    const result = parseConnectLink(LINK);
    expect(result).toEqual({ ok: true, formatVersion: 1, baseUrl: BASE, params: {} });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.params)).toBe(true);
  });

  test("keeps unknown parameters, and names outside the extra-name grammar", () => {
    expect(parseConnectLink(`${LINK}&future-thing=x`)).toEqual({
      ok: true, formatVersion: 1, baseUrl: BASE, params: { "future-thing": "x" },
    });
    expect(parseConnectLink(`${LINK}&Odd_Name=a+b%2B`)).toEqual({
      ok: true, formatVersion: 1, baseUrl: BASE, params: { Odd_Name: "a b+" },
    });
  });

  test("the first occurrence of a repeated parameter wins", () => {
    const result = parseConnectLink(`${LINK}&a=1&a=2`);
    expect(result).toEqual({ ok: true, formatVersion: 1, baseUrl: BASE, params: { a: "1" } });
  });

  test("scheme and host are case-insensitive, parameters may come in any order, and the base is normalised", () => {
    expect(parseConnectLink("PULSE://Connect/?url=https%3A%2F%2FPulse.Example.com%3A443%2F&v=1")).toEqual({
      ok: true, formatVersion: 1, baseUrl: BASE, params: {},
    });
  });

  test("ignores the fragment", () => {
    expect(parseConnectLink(`${LINK}#frag`)).toEqual({ ok: true, formatVersion: 1, baseUrl: BASE, params: {} });
  });

  test("does not limit length: a reader accepts links longer than producers emit", () => {
    const link = `${LINK}&pad=${"a".repeat(400)}`;
    expect(link.length).toBeGreaterThan(CONNECT_LINK_MAX_LENGTH);
    expect(parseConnectLink(link).ok).toBe(true);
  });

  test.each([
    "https://pulse.example.com/connect?v=1",
    "not a url",
    "",
    `pulse://other?v=1&url=${ENCODED_BASE}`,
    `pulse://connect:80?v=1&url=${ENCODED_BASE}`,
    `pulse://user@connect?v=1&url=${ENCODED_BASE}`,
    `pulse://user:pw@connect?v=1&url=${ENCODED_BASE}`,
    `pulse://connect/x?v=1&url=${ENCODED_BASE}`,
    `pulse:connect?v=1&url=${ENCODED_BASE}`,
    `pulses://connect?v=1&url=${ENCODED_BASE}`,
  ])("%j → wrong-scheme", (link) => rejects(link, "wrong-scheme"));

  test.each([
    `pulse://connect?url=${ENCODED_BASE}`,
    `pulse://connect?v=2&url=${ENCODED_BASE}`,
    `pulse://connect?v=1&v=1&url=${ENCODED_BASE}`,
    `pulse://connect?v=&url=${ENCODED_BASE}`,
    `pulse://connect?v=01&url=${ENCODED_BASE}`,
    `pulse://connect?v=1.0&url=${ENCODED_BASE}`,
    `pulse://connect?v=%2B1&url=${ENCODED_BASE}`,
    `pulse://connect?v=+1&url=${ENCODED_BASE}`,
    `pulse://connect?V=1&url=${ENCODED_BASE}`,
  ])("%j → unsupported-version", (link) => rejects(link, "unsupported-version"));

  test.each(["pulse://connect?v=1", "pulse://connect?v=1&url=", "pulse://connect?v=1&URL=x"])(
    "%j → missing-url",
    (link) => rejects(link, "missing-url"),
  );

  test.each([
    "pulse://connect?v=1&url=a&url=b",
    `pulse://connect?v=1&url=${ENCODED_BASE}&url=${ENCODED_BASE}`,
    "pulse://connect?v=1&url=not%20a%20url",
    "pulse://connect?v=1&url=https%3A%2F%2Flocalhost",
    "pulse://connect?v=1&url=https%3A%2F%2F127.0.0.1",
    "pulse://connect?v=1&url=https%3A%2F%2Fuser%3Asecret%40pulse.example.com",
  ])("%j → malformed-url", (link) => rejects(link, "malformed-url"));

  test.each([
    "pulse://connect?v=1&url=http%3A%2F%2Fpulse.example.com",
    "pulse://connect?v=1&url=ftp%3A%2F%2Fpulse.example.com",
  ])("%j → not-https", (link) => rejects(link, "not-https"));

  describe("check order: the first failing check wins", () => {
    test("wrong host beats every later failure", () => {
      rejects("pulse://other?v=2", "wrong-scheme");
      rejects("https://pulse.example.com/?v=2&url=http%3A%2F%2Flocalhost", "wrong-scheme");
    });

    test("version beats url problems", () => {
      rejects("pulse://connect?v=2", "unsupported-version");
      rejects("pulse://connect", "unsupported-version");
      rejects("pulse://connect?v=2&url=a&url=b", "unsupported-version");
      rejects("pulse://connect?v=2&url=http%3A%2F%2Fpulse.example.com", "unsupported-version");
    });

    test("an empty first url is missing-url even when a second url follows", () => {
      rejects(`pulse://connect?v=1&url=&url=${ENCODED_BASE}`, "missing-url");
    });

    test("a duplicate url is malformed-url even when the first is http", () => {
      rejects("pulse://connect?v=1&url=http%3A%2F%2Fpulse.example.com&url=x", "malformed-url");
    });

    test("http://localhost is not-https: the scheme check precedes loopback", () => {
      rejects("pulse://connect?v=1&url=http%3A%2F%2Flocalhost", "not-https");
      rejects("pulse://connect?v=1&url=http%3A%2F%2F127.0.0.1%3A8080", "not-https");
    });

    test("http with credentials is malformed-url: credentials precede the scheme check", () => {
      rejects("pulse://connect?v=1&url=http%3A%2F%2Fuser%3Asecret%40pulse.example.com", "malformed-url");
    });
  });

  test("a __proto__ parameter is an own property and cannot reach the prototype", () => {
    const result = parseConnectLink(`${LINK}&__proto__=polluted&constructor=c`);
    if (!result.ok) throw new Error(`expected ok, got ${result.rejection}`);
    expect(Object.getOwnPropertyNames(result.params).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(result.params, "__proto__")?.value).toBe("polluted");
    expect(Object.getPrototypeOf(result.params)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  test("never throws on junk", () => {
    for (const junk of ["pulse://", "pulse://connect?%", "pulse://connect?v=1&url=%E0%A4%A", "\u0000", "pulse://[", "x".repeat(100_000)]) {
      expect(() => parseConnectLink(junk)).not.toThrow();
    }
  });
});

describe("round trip", () => {
  const EXTRAS = { zz: "1", aa: "x y" } as const;

  test.each(OK_ROWS)("%j builds and parses back", (input, expected) => {
    for (const extras of [{}, EXTRAS]) {
      const built = buildConnectLink(input, extras);
      if (!built.ok) throw new Error(`expected ok, got ${built.refusal}`);
      expect(built.baseUrl).toBe(expected);
      expect(parseConnectLink(built.link)).toEqual({ ok: true, formatVersion: 1, baseUrl: expected, params: extras });
    }
  });
});
