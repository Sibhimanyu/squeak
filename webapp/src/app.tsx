import { useEffect, useState } from "preact/hooks";
import type { InvitePreview } from "../../src/shared/shapes.js";
import type { Auth, AuthState } from "./auth/auth.js";
import type { Provider } from "./auth/session.js";
import type { Relay } from "./relay/client.js";
import { routePath, type Route, type Router } from "./router.js";
import { DuckScreen, JoinScreen, PondScreen, PondsScreen } from "./views/Screens.js";
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

export interface AppProps {
  auth: Auth;
  relay: Relay;
  router: Router;
}

export function App({ auth, relay, router }: AppProps) {
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

  if (state.status !== "signed-in") {
    const signIn = (provider: Provider): void => auth.signIn(provider, routePath(route));
    return <SignIn state={state} invite={invite} onSignIn={signIn} onRetry={() => void auth.start()} />;
  }

  // Narrow: one screen at a time (Ponds, Pond, Duck). Wide: the list on the left, the open Pond or Duck on the right.
  return (
    <div class="shell" data-route={route.name}>
      <div class="list">
        <PondsScreen account={state.account.name} onSignOut={() => auth.signOut()} />
      </div>
      <div class="detail">
        {route.name === "pond" ? <PondScreen route={route} /> : null}
        {route.name === "duck" ? <DuckScreen route={route} /> : null}
        {route.name === "join" ? <JoinScreen route={route} /> : null}
      </div>
    </div>
  );
}
