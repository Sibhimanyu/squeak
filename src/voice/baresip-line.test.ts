import { describe, expect, it } from "vitest";

import {
  accountsFile,
  configFile,
  encodeNetstring,
  isSafeAccountValue,
  NetstringReader,
  parseEvent,
  type LineConfig,
} from "./baresip-line.js";

const line: LineConfig = {
  host: "pbx.local",
  user: "900",
  authUser: "abc123",
  secret: "pw",
  transport: "udp",
  proxy: null,
  baresipPath: "/opt/homebrew/bin/baresip",
  modulePath: "/opt/homebrew/lib/baresip/modules",
  dir: "/s/voice",
};

describe("netstrings", () => {
  it("round-trips a command, including a split across chunks", () => {
    const wire = encodeNetstring({ command: "dial", params: "sip:101@pbx" });
    const reader = new NetstringReader();
    expect(reader.push(wire.subarray(0, 7))).toEqual([]);
    expect(reader.push(wire.subarray(7))).toEqual(['{"command":"dial","params":"sip:101@pbx"}']);
  });

  it("reads two messages from one chunk and survives garbage", () => {
    const reader = new NetstringReader();
    const both = Buffer.concat([encodeNetstring({ a: 1 }), encodeNetstring({ b: 2 })]);
    expect(reader.push(both)).toEqual(['{"a":1}', '{"b":2}']);
    expect(new NetstringReader().push(Buffer.from("nonsense"))).toEqual([]);
  });
});

describe("parseEvent", () => {
  it("reads an event and its DTMF digit", () => {
    expect(
      parseEvent('{"event":true,"type":"CALL_DTMF_START","class":"call","param":"5","direction":"outgoing"}'),
    ).toEqual({
      type: "CALL_DTMF_START",
      param: "5",
      direction: "outgoing",
    });
  });

  it("ignores responses and junk", () => {
    expect(parseEvent('{"response":true,"ok":true}')).toBeNull();
    expect(parseEvent("not json")).toBeNull();
  });
});

describe("generated files", () => {
  it("registers with the 3CX authentication ID and a quoted password", () => {
    expect(accountsFile(line)).toBe(
      '<sip:900@pbx.local>;auth_user="abc123";auth_pass="pw";transport=udp;regint=300;answermode=manual\n',
    );
  });

  it("sends everything through an SBC when there is one", () => {
    expect(accountsFile({ ...line, proxy: "192.168.68.114:5060" })).toContain(
      ';outbound="sip:192.168.68.114:5060;transport=udp"',
    );
  });

  it("plays and records through files only", () => {
    const config = configFile(line, 4444, "/tmp/p.wav", "/tmp/heard.wav");
    expect(config).toContain("audio_source aufile,/tmp/p.wav");
    expect(config).toContain("audio_player aufile,/tmp/heard.wav");
    expect(config).toContain("ctrl_tcp_listen 127.0.0.1:4444");
    expect(config).not.toMatch(/coreaudio|audiounit/);
  });

  it("rejects anything that could end the quoted value", () => {
    for (const bad of ['a"b', "a\nb", "a;b", "a\\b", "<a>", ""]) expect(isSafeAccountValue(bad)).toBe(false);
    expect(isSafeAccountValue("Abc-123.x")).toBe(true);
  });
});
