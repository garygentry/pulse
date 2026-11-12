// apps/web/src/client/views/engine/verdict-banner.tsx — the overall engine verdict banner. Renders
// presentVerdict output; derives nothing.
import type { ReactElement } from "react";
import { useId, useState } from "react";
import { Button, Callout, Section, TARGET_STATUS } from "@/ui";
import type { IconName } from "@/ui";
import { bannerSummary } from "./verdict.js";
import type { BannerVerdict, VerdictPresentation } from "./verdict.js";
import type { EnginePayload } from "@pulse/web-data/wire";

/** Props for {@link VerdictBanner}. */
export interface VerdictBannerProps {
  /** Roll-up result from `rollUpVerdict`, never `loading`. */
  readonly verdict: BannerVerdict;
  /** `presentVerdict(verdict, clock.format)`: word, status, headline, inline/more/all. */
  readonly presentation: VerdictPresentation;
  /** Kiosk: every contributor is shown inline and nothing is interactive. */
  readonly kiosk: boolean;
  /** "job instance" of every down scrape target (`downTargetNames`), named under a degraded verdict. */
  readonly downTargets?: readonly string[];
}

/** Icon per verdict kind, shown with the verdict word so the status is never colour alone. */
export const VERDICT_ICON: Readonly<Record<BannerVerdict["kind"], IconName>> = {
  ok: "circle-check",
  degraded: "triangle-alert",
  unknown: "circle-help",
};

/**
 * The overall engine verdict: a toned Callout (icon + word) whose text names the contributors. The
 * Callout is the live region; the "and N more" control and the full list sit after it, so a verdict
 * change announces only the headline. In kiosk every contributor is inline and there is no button.
 */
/** Down scrape targets named in the banner before "and N more". */
const MAX_NAMED_TARGETS = 3;

/** "job instance" for every scrape target that is not up, in payload order (F32). */
export function downTargetNames(engine: EnginePayload | null): string[] {
  if (engine === null) return [];
  return engine.scrapeJobs.flatMap((job) => job.targets.filter((t) => t.health !== "up").map((t) => `${t.job} ${t.instance}`));
}

export function VerdictBanner({ verdict, presentation: p, kiosk, downTargets = [] }: VerdictBannerProps): ReactElement {
  const listId = `${useId()}-contributors`;
  const [open, setOpen] = useState(false);
  const status = p.status ?? "unknown";
  const summary = bannerSummary(verdict, p, kiosk);
  const showMore = !kiosk && verdict.kind === "degraded" && p.more > 0;

  return (
    <Section title="Engine verdict" level={2} data-verdict={verdict.kind} data-status={status}>
      <Callout
        tone={TARGET_STATUS[status].tone}
        icon={VERDICT_ICON[verdict.kind]}
        role="status"
        title={<span data-verdict-word="">{p.word}</span>}
        data-status={status}
      >
        {summary === "" ? null : <span data-verdict-summary="">— {summary}</span>}
        {verdict.kind === "degraded" && downTargets.length > 0 ? (
          // F32: name the down targets instead of leaving them buried in the long scrape list.
          <span className="block text-sm" data-verdict-down-targets="">
            {`Down: ${downTargets.slice(0, MAX_NAMED_TARGETS).join(", ")}${
              downTargets.length > MAX_NAMED_TARGETS ? `, and ${downTargets.length - MAX_NAMED_TARGETS} more` : ""}`}
          </span>
        ) : null}
      </Callout>
      {showMore ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            aria-expanded={open ? "true" : "false"}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            and {p.more} more
          </Button>
          <ul id={listId} className="m-0 list-disc pl-5 text-sm" hidden={!open}>
            {p.all.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}
