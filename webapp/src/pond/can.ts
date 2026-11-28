// What a person may do in a Pond, asked of the same pure `decide` the daemon uses (docs/adr/0006-pond-policy.md). The web has no
// daemon to send `me.can`, so it derives it from its role, its member id and the Owner's signed Pond policy. Each answer is `true`
// or the refusal sentence the daemon would send, which a disabled control shows as its reason.

import { decide, type Action, type Actor, type PondPolicy } from "../../../src/shared/pond-policy.js";
import type { PondRole } from "../../../src/shared/shapes.js";

export type Can = true | string;

export interface PondCan {
  postRoom: Can;
  makeTask: Can;
  messageDuck: Can;
  startDuck: Can;
  answerQuestion: Can;
  invite: Can;
  removeMember: Can;
  changeRole: Can;
  approveStart: Can;
  setPolicy: Can;
  deletePond: Can;
  stop: Can;
  /** Allowed, but the Owner approves first (a Member's Task or Duck under `members-approval`). */
  waitsForOwner: { makeTask: boolean; startDuck: boolean };
}

/** `starter`: the member who started the Duck being asked about (a Duck someone else started is the default). */
export function canOf(role: PondRole, memberId: string, policy: PondPolicy, starter = ""): PondCan {
  const actor: Actor = { kind: "human", memberId, role };
  const thread = { starter, private: false };
  const ask = (action: Action) => decide(actor, action, { thread, via: "direct" }, policy);
  const can = (action: Action): Can => {
    const d = ask(action);
    return d.ok ? true : d.reason;
  };
  const waits = (action: Action): boolean => {
    const d = ask(action);
    return d.ok && d.approval === true;
  };
  return {
    postRoom: can("post-room"),
    makeTask: can("make-task"),
    messageDuck: can("message-duck"),
    startDuck: can("start-duck"),
    answerQuestion: can("answer-question"),
    invite: can("invite"),
    removeMember: can("remove-member"),
    changeRole: can("change-role"),
    approveStart: can("approve-start"),
    setPolicy: can("set-policy"),
    deletePond: can("delete-pond"),
    stop: can("stop"),
    waitsForOwner: { makeTask: waits("make-task"), startDuck: waits("start-duck") },
  };
}
