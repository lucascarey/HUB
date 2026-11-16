"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "hub-theme";
const BG: Record<Theme, string> = { dark: "#06070a", light: "#f4f1ea" };

/** Runs before the page paints so the chosen theme never flashes. */
export const THEME_BOOT = `(function(){try{var t=localStorage.getItem("${KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?"${BG.light}":"${BG.dark}")}catch(e){}})()`;

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BG[t]);
}

/** Light or dark, remembered on this device; follows the phone's setting until you pick one. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const n: Theme = t === "light" ? "dark" : "light";
      apply(n);
      try {
        localStorage.setItem(KEY, n);
      } catch {}
      return n;
    });
  }, []);
  return { theme, toggle };
}
