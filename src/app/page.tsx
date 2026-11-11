"use client";

import Network from "@/components/Network";
import { useHub } from "@/lib/useHub";

export default function Home() {
  const hub = useHub();
  if (!hub.data) return <div id="stage" aria-busy="true" />;
  return (
    <Network
      data={hub.data}
      update={hub.update}
      account={hub.account}
      status={hub.status}
      cloudEnabled={hub.cloudEnabled}
      signIn={hub.signIn}
      signOut={hub.signOut}
      reset={hub.reset}
    />
  );
}
