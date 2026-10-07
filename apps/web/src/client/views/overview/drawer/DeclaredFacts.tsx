// apps/web/src/client/views/overview/drawer/DeclaredFacts.tsx — declared identity and configuration
// of the selected target. Renders only fields present on the snapshot's HostStatus/ServiceStatus: no
// secret reference is resolved, no value is fabricated for an absent field, and there is no edit
// affordance.

import type { ReactNode, ReactElement } from "react";

import type { HostStatus, ServiceStatus, TargetIdentity } from "@pulse/web-data/wire";
import { EmptyValue, KeyValue, KeyValueList, Section } from "@/ui";

/** Copy for an empty declared list or an absent optional declaration. */
export const NONE_DECLARED_TEXT = "None declared";

const KIND_LABEL: Readonly<Record<TargetIdentity["kind"], string>> = {
  host: "Host",
  service: "Service",
  endpoint: "Endpoint",
};

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

function Fact(props: { readonly fact: string; readonly term: string; readonly children: ReactNode }): ReactElement {
  return (
    <KeyValue data-fact={props.fact} label={props.term}>
      {props.children}
    </KeyValue>
  );
}

function NoneDeclared(): ReactElement {
  return <EmptyValue>{NONE_DECLARED_TEXT}</EmptyValue>;
}

/** Render identity and declared configuration fields from the snapshot only. */
export function DeclaredFacts(props: {
  readonly identity: TargetIdentity;
  readonly host: HostStatus;
  readonly service: ServiceStatus | null;
}): ReactElement {
  const { identity, host, service } = props;
  const suppressed = service !== null ? service.suppressed : host.suppressed;

  return (
    <Section level={3} title="Declared facts" data-section="facts">
      <KeyValueList>
        <Fact fact="id" term="Canonical id">{identity.id}</Fact>
        <Fact fact="name" term="Name">{service !== null ? service.name : host.name}</Fact>
        <Fact fact="kind" term="Kind">{KIND_LABEL[identity.kind] ?? identity.kind}</Fact>
        <Fact fact="host" term="Owning host">{host.name}</Fact>
        {service === null ? (
          <>
            <Fact fact="class" term="Collection class">{host.collectionClass}</Fact>
            <Fact fact="addresses" term="Addresses">
              {host.addresses.length === 0 ? (
                <NoneDeclared />
              ) : (
                <ul className="m-0 grid list-none gap-0.5 p-0 font-mono text-xs">
                  {host.addresses.map((address, i) => <li key={`${address}:${i}`}>{address}</li>)}
                </ul>
              )}
            </Fact>
          </>
        ) : (
          <>
            <Fact fact="managed" term="Managed">{yesNo(service.managed)}</Fact>
            <Fact fact="deep-health" term="Deep health">{yesNo(service.deepHealth)}</Fact>
            <Fact fact="ingress" term="Ingress URL">
              {service.ingressUrl !== undefined ? <span className="break-all">{service.ingressUrl}</span> : <NoneDeclared />}
            </Fact>
          </>
        )}
        <Fact fact="suppression" term="Suppression">
          {suppressed === null ? (
            "Not suppressed"
          ) : (
            <>
              <span data-slot="drawer-suppression-class" className="font-medium">{suppressed.class}</span>
              {": "}
              <span data-slot="drawer-suppression-rationale">{suppressed.rationale}</span>
            </>
          )}
        </Fact>
      </KeyValueList>
    </Section>
  );
}
