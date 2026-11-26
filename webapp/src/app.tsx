import { useEffect, useMemo, useState } from "preact/hooks";
import type { InvitePreview } from "../../src/shared/shapes.js";
import type { Auth, AuthState } from "./auth/auth.js";
import type { KeyValueStore, Provider } from "./auth/session.js";
import { defaultVault, type KeyVault } from "./device/vault.js";
import { createDevice } from "./pond/device.js";
import type { FetchLike, Relay } from "./relay/client.js";
import { routePath, type Route, type Router } from "./router.js";
import { createPondsStore, type PondsState, type PondsStore } from "./state/ponds-store.js";
import { DuckScreen } from "./views/Duck.js";
import { PondScreen } from "./views/Pond.js";
import { PondsScreen } from "./views/Ponds.js";
import { JoinScreen } from "./views/Screens.js";
import { SignIn } from "./views/SignIn.js";

function useSubscribed<T>(read: () => T, subscribe: (listener: (value: T) => void) => () => void): T {
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    setValue(read());
    return subscribe(setValue);
    // read and subscribe are stable for the life of the app
  }, []);
  return value;
}

function useStore(store: PondsStore | null): PondsState | null {
  const [value, setValue] = useState<PondsState | null>(store ? store.state() : null);
  useEffect(() => {
    setValue(store ? store.state() : null);
    return store?.subscribe(setValue);
  }, [store]);
  return value;
}

export interface AppProps {
  auth: Auth;
  relay: Relay;
  router: Router;
  /** The `squeak-live` base URL; null reads the lists every 30 s instead. */
  liveBase?: string | null;
  /** The fetch the live stream uses (tests); the page's own by default. */
  liveFetch?: FetchLike;
  /** Where this browser's device key is kept (IndexedDB); tests pass an in-memory one. */
  vault?: KeyVault;
  /** Where "seen up to" is kept per Pond (localStorage). */
  seen?: KeyValueStore;
}

const defaultSeen = (): KeyValueStore => window.localStorage;

export function App({ auth, relay, router, liveBase = null, liveFetch, vault, seen }: AppProps) {
  const state: AuthState = useSubscribed(auth.state, auth.subscribe);
  const route: Route = useSubscribed(router.current, router.subscribe);
  const [invite, setInvite] = useState<InvitePreview | null>(null);

  useEffect(() => {
    void auth.start();
  }, [auth]);

  // An invite link says who invited you before you sign in; unknown or unreachable falls back to the plain page.
  const code = route.name === "join" ? route.code : null;
  useEffect(() => {
    setInvite(null);
    if (!code || state.status !== "signed-out") return;
    let live = true;
    void relay.invitePreview(code).then((preview) => live && setInvite(preview));
    return () => {
      live = false;
    };
  }, [code, state.status, relay]);

  // One Ponds store per signed-in session: one read on open, then live notices (or the 30 s poll) say when to read again.
  const token = state.status === "signed-in" ? state.token : null;
  const userId = state.status === "signed-in" ? state.account.userId : null;
  const store = useMemo(
    () =>
      token && userId
        ? createPondsStore({
            relay,
            token,
            liveBase,
            // This browser is a device of the account: its key is made once and kept, and the Owner's Mac seals Pond keys to it.
            device: createDevice({ relay, token, userId, vault: vault ?? defaultVault() }),
            seen: seen ?? defaultSeen(),
            ...(liveFetch ? { fetch: liveFetch } : {}),
            onSignedOut: () => auth.signOut(),
          })
        : null,
    [relay, token, userId, liveBase, liveFetch, auth, vault, seen],
  );
  const ponds = useStore(store);
  useEffect(() => {
    store?.start();
    return () => store?.stop();
  }, [store]);

  if (state.status !== "signed-in" || !store || !ponds) {
    const signIn = (provider: Provider): void => auth.signIn(provider, routePath(route));
    return <SignIn state={state} invite={invite} onSignIn={signIn} onRetry={() => void auth.start()} />;
  }

  // Narrow: one screen at a time (Ponds, Pond, Duck). Wide: the list on the left, the open Pond or Duck on the right.
  return (
    <div class="shell" data-route={route.name}>
      <div class="list">
        <PondsScreen
          account={state.account}
          state={ponds}
          selectedPondId={route.name === "pond" || route.name === "duck" ? route.pondId : null}
          onSignOut={() => auth.signOut()}
          onRetry={() => void store.refresh()}
          onJoin={(id) =>
            void store.join(id).then((pondId) => pondId && router.go({ name: "pond", pondId, tab: "room" }))
          }
          onDecline={(id) => void store.decline(id)}
        />
      </div>
      <div class="detail">
        {route.name === "pond" ? (
          <PondScreen
            key={route.pondId}
            route={route}
            pond={ponds.overview.ponds.find((p) => p.pondId === route.pondId)}
            session={store.session(route.pondId)}
            connection={ponds.connection}
            onSeen={() => store.markSeen(route.pondId)}
          />
        ) : null}
        {route.name === "duck" ? (
          <DuckScreen
            key={`${route.pondId}/${route.duckId}`}
            route={route}
            pond={ponds.overview.ponds.find((p) => p.pondId === route.pondId)}
            session={store.session(route.pondId)}
          />
        ) : null}
        {route.name === "join" ? <JoinScreen route={route} /> : null}
      </div>
    </div>
  );
}
