// How the SDK wiring gets its Catalyst app (index.js). No SDK is required here, so tests can use fakes.

/** A value or a function returning one, as a function: lets a long-lived service pass "the latest app" instead of one fixed app. */
const appGetter = (appOrGetter) => (typeof appOrGetter === "function" ? appOrGetter : () => appOrGetter);

/**
 * The project-scoped (admin) app for this request's x-zc-* headers. The default app takes its scope from the caller: a signed-in
 * browser makes it a user app, and the Data Store (ZCQL, rows) and Stratus (signed bucket URLs) then act as that user, who has no
 * grant on the people tables or the bucket. The relay decides who may do what itself (handler.js), so these two run as admin.
 */
const adminAppOf = (zcAuth, req) => zcAuth.init(req, { type: "auto", appName: "squeak-admin", scope: "admin" });

module.exports = { appGetter, adminAppOf };
