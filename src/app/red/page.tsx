"use client";

import Link from "next/link";
import Network from "@/components/Network";
import { useHub } from "@/lib/useHub";

/** The old free-form network view, kept as a secondary view of the same data. */
export default function Red() {
  const hub = useHub();
  if (!hub.data) return <div id="stage" aria-busy="true" />;
  return (
    <>
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
      <Link href="/" className="pill backToBrain">← Cerebro</Link>
    </>
  );
}
