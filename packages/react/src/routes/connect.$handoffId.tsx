import { useEffect } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { ConnectionHandoffId } from "@executor-js/sdk/shared";

import { connectionHandoffAtom } from "../api/atoms";
import { ErrorState } from "../components/error-state";
import { PageContainer } from "../components/page";
import { Skeleton } from "../components/skeleton";
import { IntegrationDetailPage } from "../pages/integration-detail";

export const Route = createFileRoute("/{-$orgSlug}/connect/$handoffId")({
  component: ConnectionHandoffRoute,
});

function ConnectionHandoffRoute() {
  const { handoffId: rawHandoffId } = Route.useParams();
  const handoffId = ConnectionHandoffId.make(rawHandoffId);
  const handoffAtom = connectionHandoffAtom(handoffId);
  const result = useAtomValue(handoffAtom);
  const refresh = useAtomRefresh(handoffAtom);
  const handoff = AsyncResult.isSuccess(result) ? result.value : null;

  useEffect(() => {
    if (handoff?.status !== "pending") return;
    const interval = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(interval);
  }, [handoff?.status, refresh]);

  useEffect(() => {
    if (handoff?.status !== "completed") return;
    window.location.assign(handoff.returnTo);
  }, [handoff]);

  if (AsyncResult.isFailure(result)) {
    return (
      <PageContainer className="py-10">
        <ErrorState message="This connection request is unavailable." onRetry={refresh} />
      </PageContainer>
    );
  }

  if (!handoff || handoff.status === "completed") {
    return (
      <PageContainer className="space-y-3 py-10">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-24 w-full" />
        <p className="text-sm text-muted-foreground">
          {handoff?.status === "completed"
            ? "Connection confirmed. Returning to the requesting application…"
            : "Loading secure connection request…"}
        </p>
      </PageContainer>
    );
  }

  if (handoff.status === "expired") {
    return (
      <PageContainer className="py-10">
        <ErrorState message="This connection request expired." onRetry={refresh} />
      </PageContainer>
    );
  }

  return (
    <IntegrationDetailPage
      namespace={String(handoff.integration)}
      tab="accounts"
      accountHandoff={{
        key: String(handoff.handoffId),
        connectionHandoffId: handoff.handoffId,
        owner: "user",
        template: handoff.template,
        label: handoff.label,
        fixedTarget: true,
      }}
    />
  );
}
