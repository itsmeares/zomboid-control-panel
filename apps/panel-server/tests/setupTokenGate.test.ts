import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map();
const db = { data: { users: [] } };

vi.mock("../database/init.ts", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
}));

const { default: authService } = await import("../services/auth.ts");
const { getOrCreateSetupToken } = await import("../utils/setupToken.ts");
const { default: authRouter } = await import("../routes/auth.ts");

function createResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    removeHeader: vi.fn(),
    end: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.cookie.mockReturnValue(response);
  response.clearCookie.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return authRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(routePath, method, req, res) {
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
}

function makeReq(body, ip) {
  return { body, ip, headers: {} };
}

describe("authService.middleware() — the pre-setup gate", () => {
  let middleware;

  beforeEach(() => {
    settings.clear();
    db.data.users = [];
    middleware = authService.middleware();
  });

  async function run(path, { needsUser = false } = {}) {
    if (needsUser) db.data.users = [{ id: "u1", role: "admin" }];
    const req = { path, headers: {} };
    const res = createResponse();
    const next = vi.fn();
    await middleware(req, res, next);
    return { req, res, next };
  }

  it("lets non-/api paths through unconditionally", async () => {
    const { next, res } = await run("/index.html");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("lets /api/auth/* through even with zero users (the setup wizard's own traffic)", async () => {
    const { next } = await run("/api/auth/setup");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("lets /api/health through unconditionally", async () => {
    const { next } = await run("/api/health");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("lets /api/debug/client-errors through with zero users (crash reporting must work pre-login)", async () => {
    const { next } = await run("/api/debug/client-errors");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("REFUSES an unrelated route with zero users instead of the old blanket bypass -- this is the actual fix", async () => {
    const { next, res } = await run("/api/debug/system");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SETUP_REQUIRED" }),
    );
  });

  it("still refuses an unrelated route with zero users even for a path that looks like a debug subpath", async () => {
    const { next, res } = await run("/api/players");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("once a user exists, an unauthenticated request to a normal route still gets the ordinary AUTH_REQUIRED 401 -- unaffected by this change", async () => {
    const { next, res } = await run("/api/players", { needsUser: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });
});

describe("POST /api/auth/setup — the setup-token gate", () => {
  beforeEach(async () => {
    settings.clear();
    db.data.users = [];
    await authService.init();
  });

  it("refuses a missing token before touching anything else", async () => {
    const req = makeReq(
      { username: "op", password: "correct horse battery" },
      "10.0.0.1",
    );
    const res = createResponse();
    await runRoute("/setup", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SETUP_TOKEN_REQUIRED" }),
    );
    expect(db.data.users.length).toBe(0);
  });

  it("refuses a wrong token", async () => {
    await getOrCreateSetupToken();
    const req = makeReq(
      {
        username: "op",
        password: "correct horse battery",
        setupToken: "definitely-not-it",
      },
      "10.0.0.2",
    );
    const res = createResponse();
    await runRoute("/setup", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db.data.users.length).toBe(0);
  });

  it("validates the panel port before creating the admin account", async () => {
    const token = await getOrCreateSetupToken();
    const req = makeReq(
      {
        username: "op",
        password: "correct horse battery",
        setupToken: token,
        panelPort: "not-a-port",
      },
      "10.0.0.2",
    );
    const res = createResponse();
    await runRoute("/setup", "post", req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SETUP_PANEL_PORT_INVALID" }),
    );
    expect(db.data.users.length).toBe(0);
  });

  it("accepts the correct token exactly once, and clearSetupToken() makes reuse fail on a second attempt", async () => {
    const token = await getOrCreateSetupToken();

    const firstReq = makeReq(
      { username: "opuser", password: "correct horse battery", setupToken: token },
      "10.0.0.3",
    );
    const firstRes = createResponse();
    await runRoute("/setup", "post", firstReq, firstRes);
    expect(firstRes.status).toHaveBeenCalledWith(201);
    expect(firstRes.clearCookie).toHaveBeenCalledWith(
      "refreshToken",
      expect.objectContaining({ path: "/api/auth" }),
    );
    expect(db.data.users.length).toBe(1);
    expect(settings.get("setupToken")).toBeNull();

    const secondReq = makeReq(
      { username: "second", password: "another password", setupToken: token },
      "10.0.0.3",
    );
    const secondRes = createResponse();
    await runRoute("/setup", "post", secondReq, secondRes);
    expect(secondRes.status).toHaveBeenCalledWith(400);
    expect(db.data.users.length).toBe(1);
  });
});

describe("authService.bootstrapAdminFromExternalIdentity() — the OIDC bootstrap door", () => {
  beforeEach(() => {
    settings.clear();
    db.data.users = [];
  });

  const identity = {
    issuer: "https://idp.example.com",
    subject: "sub-123",
    email: "op@example.com",
    username: "opidc",
  };

  it("refuses a missing setup token", async () => {
    await expect(
      authService.bootstrapAdminFromExternalIdentity({ ...identity }),
    ).rejects.toThrow(/setup token/i);
    expect(db.data.users.length).toBe(0);
  });

  it("refuses a wrong setup token", async () => {
    await getOrCreateSetupToken();
    await expect(
      authService.bootstrapAdminFromExternalIdentity({
        ...identity,
        setupToken: "wrong",
      }),
    ).rejects.toThrow(/setup token/i);
    expect(db.data.users.length).toBe(0);
  });

  it("accepts the correct token exactly once, and a second call (even with the same identity) fails once a user exists", async () => {
    const token = await getOrCreateSetupToken();

    const created = await authService.bootstrapAdminFromExternalIdentity({
      ...identity,
      setupToken: token,
    });
    expect(created.role).toBe("admin");
    expect(db.data.users.length).toBe(1);
    expect(settings.get("setupToken")).toBeNull();

    await expect(
      authService.bootstrapAdminFromExternalIdentity({
        ...identity,
        setupToken: token,
      }),
    ).rejects.toThrow(/Setup already completed/i);
    expect(db.data.users.length).toBe(1);
  });
});
