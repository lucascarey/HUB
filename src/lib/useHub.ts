"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { makeSeed } from "./seed";
import { CloudStore, LocalStore, readLocal, type Store, type SyncStatus } from "./store";
import { supabase } from "./supabase";
import type { HubData } from "./types";

export interface Account {
  email: string;
}

/** Loads the HUB from Supabase when signed in, otherwise from this browser, and saves every change. */
export function useHub() {
  const [data, setData] = useState<HubData | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [status, setStatus] = useState<SyncStatus>("local");
  const store = useRef<Store | null>(null);
  const skipSave = useRef(true);

  const boot = useCallback(async (userId: string | null, email: string | null) => {
    skipSave.current = true;
    if (supabase && userId) {
      const cloud = new CloudStore(supabase, userId, setStatus);
      store.current = cloud;
      setAccount({ email: email ?? "" });
      try {
        const remote = await cloud.load();
        if (remote) {
          setData(remote);
          setStatus("synced");
        } else {
          // First sign-in: upload what was in this browser (or the example).
          const local = readLocal() ?? makeSeed();
          setData(local);
          skipSave.current = false;
          cloud.save(local);
        }
      } catch (e) {
        console.error(e);
        setStatus("error");
        setData(readLocal() ?? makeSeed());
      }
      return;
    }
    store.current = new LocalStore();
    setAccount(null);
    setStatus("local");
    setData((await store.current.load()) ?? makeSeed());
  }, []);

  useEffect(() => {
    if (!supabase) {
      void boot(null, null);
      return;
    }
    let current: string | null | undefined;
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const uid = session?.user.id ?? null;
      if (uid === current) return;
      current = uid;
      void boot(uid, session?.user.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [boot]);

  useEffect(() => {
    if (!data) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    store.current?.save(data);
  }, [data]);

  const update = useCallback((fn: (d: HubData) => HubData) => setData((d) => (d ? fn(d) : d)), []);

  const signIn = useCallback(async (email: string) => {
    if (!supabase) return "La sincronización todavía no está configurada.";
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    return error ? error.message : null;
  }, []);

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
  }, []);

  const reset = useCallback(() => setData(makeSeed()), []);

  return { data, update, account, status, signIn, signOut, reset, cloudEnabled: !!supabase };
}
