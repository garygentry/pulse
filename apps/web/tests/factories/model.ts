// apps/web/tests/factories/model.ts — typed builders for the rendered web-estate-model shapes
// (@pulse/renderer). MUST NOT import from ./wire — this file is owned by rendered-model-v2.
//
// These `host`/`service`/`model` builders construct the current v1 `WebEstateModel` shape and remain
// the legacy call sites for the shipped web-foundation tests (build, snapshot, skeleton, links). The
// complete v2 estate-bundle construction (`WebEstateModelV2` + coverage + findings + canonical bytes)
// lives in `./estate-bundle.ts`; both are re-exported through the `../factories.ts` seam. Until the
// item-010 format cutover aliases `WebEstateModel` to v2, the two shapes intentionally coexist here.

import { RENDER_FORMAT_VERSION } from "@pulse/renderer";
import type { WebEstateHost, WebEstateModel, WebEstateService } from "@pulse/renderer";

/** A model host with valid defaults (managed-linux, monitored). */
export function host(over: Partial<WebEstateHost> = {}): WebEstateHost {
  return {
    name: "web01",
    collectionClass: "managed-linux",
    addresses: ["10.0.0.4"],
    suppressed: null,
    drilldownId: "host:web01",
    ...over,
  };
}

/** A model service with valid defaults (managed, no deep-health), owned by `web01`. */
export function service(over: Partial<WebEstateService> = {}): WebEstateService {
  return {
    name: "grafana",
    host: "web01",
    managed: true,
    deepHealth: false,
    suppressed: null,
    drilldownId: "svc:web01/grafana",
    ...over,
  };
}

/** A whole web-estate-model with the given hosts/services and the supported `formatVersion`. */
export function model(over: Partial<WebEstateModel> = {}): WebEstateModel {
  return {
    formatVersion: RENDER_FORMAT_VERSION,
    estate: { name: "home-estate", domains: ["example.com"] },
    hosts: [host()],
    services: [service()],
    ...over,
  };
}
