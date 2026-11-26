import { useEffect, useMemo, useState } from "preact/hooks";
import type { PondSummary } from "../../src/shared/shapes.js";
import type { Auth, AuthState } from "./auth/auth.js";
import type { KeyValueStore, Provider } from "./auth/session.js";
import { defaultVault, loadIdentity, type KeyVault } from "./device/vault.js";
import { createDevice } from "./pond/device.js";
import type { FetchLike, Relay } from "./relay/client.js";
import { routePath, type Route, type Router } from "./router.js";
import { isMac, MAC_DOWNLOAD_URL } from "./platform.js";
import { createPondsStore, type PondsState, type PondsStore } from "./state/ponds-store.js";
import { DuckScreen } from "./views/Duck.js";
import { PondScreen } from "./views/Pond.js";
import { PeopleSheet } from "./views/People.js";
import { PondsScreen } from "./views/Ponds.js";
import { InvitePage, type InviteLoad } from "./views/InvitePage.js";
import { SettingsScreen } from "./views/Settings.js";
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
  /** Whether this device is a Mac (Squeak for Mac is offered only there); the page's own navigator by default. */
  mac?: boolean;
}

/** After joining on the web: the one-time "Get Squeak for Mac" card in the Pond ("show" until dismissed, then "done"). */
export const MAC_CARD_KEY = "squeak-mac-card";

const defaultSeen = (): KeyValueStore => window.localStorage;

function PeopleHost(props: Omit<Parameters<typeof PeopleSheet>[0], "pond"> & { pond: PondSummary | undefined }) {
  const { pond, ...rest } = props;
  return pond ? <PeopleSheet {...rest} pond={pond} version={pond.counts.members} /> : null;
}

export function App({ auth, relay, router, liveBase = null, liveFetch, vault, seen, mac }: AppProps) {
  const state: AuthState = useSubscribed(auth.state, auth.subscribe);
  const route: Route = useSubscribed(router.current, router.subscribe);
  const onMac = mac ?? isMac(navigator);
  const [invite, setInvite] = useState<InviteLoad>({ status: "loading" });
  // One vault for the life of the app: the device key is loaded through it from every place that needs it.
  const keyVault = useMemo(() => vault ?? defaultVault(), [vault]);

  useEffect(() => {
    void auth.start();
  }, [auth]);

  // An invite link is read from the relay's record before anyone signs in; an unknown code or an unreachable relay says so.
  const code = route.name === "invite" ? route.code : null;
  const settled = state.status === "signed-out" || state.status === "signed-in";
  useEffect(() => {
    setInvite({ status: "loading" });
    if (!code || !settled) return;
    let live = true;
    void relay
      .invitePreview(code)
      .then((p) => live && setInvite(p ? { status: "ok", invite: p } : { status: "missing" }));
    return () => {
      live = false;
    };
  }, [code, settled, relay]);

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
            device: createDevice({ relay, token, userId, vault: keyVault }),
            seen: seen ?? defaultSeen(),
            ...(liveFetch ? { fetch: liveFetch } : {}),
            onSignedOut: () => auth.signOut(),
          })
        : null,
    [relay, token, userId, liveBase, liveFetch, auth, keyVault, seen],
  );
  const ponds = useStore(store);
  const seenStore = seen ?? defaultSeen();
  const [macCard, setMacCard] = useState(() => onMac && seenStore.getItem(MAC_CARD_KEY) === "show");
  // This browser's own device id, for Settings > Your devices ("This device").
  const [selfDeviceId, setSelfDeviceId] = useState<string | null>(null);
  useEffect(() => {
    setSelfDeviceId(null);
    if (!userId) return;
    let live = true;
    void loadIdentity(keyVault, userId).then(
      (id) => live && setSelfDeviceId(id.deviceId),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // the vault is stable for the life of the app
  }, [userId]);
  useEffect(() => {
    store?.start();
    return () => store?.stop();
  }, [store]);

  const signIn = (provider: Provider): void => auth.signIn(provider, routePath(route));
  if (route.name === "invite" && state.status !== "failed") {
    return (
      <InvitePage
        load={state.status === "checking" ? { status: "loading" } : invite}
        signedInAs={state.status === "signed-in" ? state.account.email : null}
        isMac={onMac}
        onSignIn={signIn}
        onAnswer={async (answer) => {
          if (state.status !== "signed-in") return { status: "failed" };
          const result = await relay.respond(state.token, route.code, answer);
          if (result.status === "unauthorized") auth.signOut();
          return result;
        }}
        onJoined={(pondId) => {
          if (onMac) {
            try {
              seenStore.setItem(MAC_CARD_KEY, "show");
            } catch {
              // storage refused: the card is skipped
            }
            setMacCard(true);
          }
          void (store ? store.refresh() : Promise.resolve()).then(() =>
            router.go(pondId ? { name: "pond", pondId, tab: "room" } : { name: "ponds" }),
          );
        }}
        onSwitchAccount={() => auth.signOut()}
      />
    );
  }
  if (state.status !== "signed-in" || !store || !ponds) {
    return <SignIn state={state} onSignIn={signIn} onRetry={() => void auth.start()} />;
  }

  // Narrow: one screen at a time (Ponds, Pond, Duck). Wide: the list on the left, the open Pond or Duck on the right.
  return (
    <div class="shell" data-route={route.name}>
      <div class="list">
        <PondsScreen
          account={state.account}
          state={ponds}
          selectedPondId={
            route.name === "pond" || route.name === "duck" || route.name === "people" ? route.pondId : null
          }
          onRetry={() => void store.refresh()}
          onJoin={(id) =>
            void store.join(id).then((pondId) => pondId && router.go({ name: "pond", pondId, tab: "room" }))
          }
          onDecline={(id) => void store.decline(id)}
        />
      </div>
      <div class="detail">
        {route.name === "pond" || route.name === "people" ? (
          <PondScreen
            key={route.pondId}
            route={route.name === "people" ? { name: "pond", pondId: route.pondId, tab: "room" } : route}
            pond={ponds.overview.ponds.find((p) => p.pondId === route.pondId)}
            deletedName={ponds.deleted[route.pondId]}
            session={store.session(route.pondId)}
            connection={ponds.connection}
            onSeen={() => store.markSeen(route.pondId)}
            macCard={
              macCard
                ? {
                    href: MAC_DOWNLOAD_URL,
                    onDismiss: () => {
                      try {
                        seenStore.setItem(MAC_CARD_KEY, "done");
                      } catch {
                        // storage refused: it may show again
                      }
                      setMacCard(false);
                    },
                  }
                : null
            }
          />
        ) : null}
        {route.name === "duck" ? (
          <DuckScreen
            key={`${route.pondId}/${route.duckId}`}
            route={route}
            pond={ponds.overview.ponds.find((p) => p.pondId === route.pondId)}
            deletedName={ponds.deleted[route.pondId]}
            session={store.session(route.pondId)}
          />
        ) : null}
        {route.name === "people" ? (
          <PeopleHost
            key={route.pondId}
            pond={ponds.overview.ponds.find((p) => p.pondId === route.pondId)}
            relay={relay}
            token={state.token}
            selfUserId={state.account.userId}
            onClose={() => router.go({ name: "pond", pondId: route.pondId, tab: "room" })}
            onGone={() => {
              void store.refresh();
              router.go({ name: "ponds" }, { replace: true });
            }}
            onSignedOut={() => auth.signOut()}
          />
        ) : null}
        {route.name === "settings" ? (
          <SettingsScreen
            account={state.account}
            relay={relay}
            token={state.token}
            selfDeviceId={selfDeviceId}
            onSignOut={() => auth.signOut()}
            onSignedOut={() => auth.signOut()}
          />
        ) : null}
      </div>
    </div>
  );
}
