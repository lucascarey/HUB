import type { Metadata } from "next";
import Companion from "@/components/Companion";

export const metadata: Metadata = { title: "Jarvis" };

/** The desktop companion: Jarvis's face living in a corner of the screen (loaded by the Windows app). */
export default function CompaPage() {
  return <Companion />;
}
