"use client";

import Brain from "@/components/Brain";
import { useHub } from "@/lib/useHub";

export default function Home() {
  const hub = useHub();
  if (!hub.data) return <div id="stage" aria-busy="true" />;
  return (
    <Brain
      data={hub.data}
      update={hub.update}
      reload={hub.reload}
      account={hub.account}
      status={hub.status}
      cloudEnabled={hub.cloudEnabled}
      signIn={hub.signIn}
      signOut={hub.signOut}
      reset={hub.reset}
    />
  );
}
