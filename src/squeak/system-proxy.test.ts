import { afterEach, describe, expect, it } from "vitest";

import {
  applySystemProxyToProcess,
  mergeProxyEnv,
  parseScutilProxy,
  proxyEnvFor,
  resetSystemProxyCache,
  withSystemProxyEnv,
} from "./system-proxy.js";

const ON = `<dictionary> {
  ExcludeSimpleHostnames : 1
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : *.corp.example
  }
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 3128
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`;
const OFF = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`;
const PAC = `<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad.example/proxy.pac
  HTTPSEnable : 1
  HTTPSPort : 8080
  HTTPSProxy : proxy.example
}`;

afterEach(() => resetSystemProxyCache());

describe("parseScutilProxy", () => {
  it("reads an enabled proxy with exceptions", () => {
    const p = parseScutilProxy(ON);
    expect(p.https).toEqual({ host: "127.0.0.1", port: 3128 });
    expect(p.http).toEqual({ host: "127.0.0.1", port: 3128 });
    expect(p.exceptions).toEqual(["*.local", "169.254/16", "*.corp.example"]);
    expect(p.excludeSimpleHostnames).toBe(true);
    expect(p.pac).toBe(false);
  });
  it("reads off, PAC and garbage without throwing", () => {
    expect(parseScutilProxy(OFF).https).toBeUndefined();
    expect(parseScutilProxy(PAC).pac).toBe(true);
    expect(parseScutilProxy("nonsense\n\n").https).toBeUndefined();
  });
});

describe("env merge", () => {
  it("builds the proxy and NO_PROXY", () => {
    const env = proxyEnvFor(parseScutilProxy(ON));
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.http_proxy).toBe("http://127.0.0.1:3128");
    expect(env.NO_PROXY).toBe(".local,169.254/16,.corp.example,127.0.0.1,localhost,::1");
  });
  it("leaves the environment alone when off or PAC", () => {
    const base = { PATH: "/bin" };
    expect(mergeProxyEnv(base, parseScutilProxy(OFF))).toBe(base);
    expect(mergeProxyEnv(base, parseScutilProxy(PAC))).toBe(base);
  });
  it("an existing HTTPS_PROXY wins", () => {
    const base = { HTTPS_PROXY: "http://corp:1" };
    expect(mergeProxyEnv(base, parseScutilProxy(ON))).toBe(base);
  });
  it("is computed per call from the cached read, never throws", () => {
    expect(withSystemProxyEnv({}, () => ON).HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    resetSystemProxyCache();
    expect(withSystemProxyEnv({ A: "1" }, () => OFF)).toEqual({ A: "1" });
    resetSystemProxyCache();
    expect(
      withSystemProxyEnv({ A: "1" }, () => {
        throw new Error("no scutil");
      }),
    ).toEqual({ A: "1" });
  });
});

describe("applySystemProxyToProcess", () => {
  it("sets, follows a network change and never touches a foreign proxy", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applySystemProxyToProcess(env, () => ON)).toBe(true);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    resetSystemProxyCache();
    applySystemProxyToProcess(env, () => OFF);
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    const own: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://corp:1" };
    resetSystemProxyCache();
    applySystemProxyToProcess(own, () => ON);
    expect(own.HTTPS_PROXY).toBe("http://corp:1");
  });
});
