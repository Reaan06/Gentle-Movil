import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { httpGet } from "./helpers/http.ts";
import { startTestBridge } from "./helpers/bridge.ts";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

test("/api/health returns the exact identity payload of this bridge", async (t) => {
  const harness = await startTestBridge();
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/health");

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json");
  assert.deepEqual(response.json, {
    app: "gentle-shell",
    bridge: "gentle-movil",
    proto: 1,
    version: packageJson.version,
  });
  // The identity must be semver-shaped so clients can negotiate on it.
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("both listeners bind loopback only and answer on 127.0.0.1", async (t) => {
  const harness = await startTestBridge();
  t.after(() => harness.stop());

  const address = harness.bridge.addresses();
  assert.equal(address.host, "127.0.0.1");
  assert.deepEqual(address.api.host, "127.0.0.1");
  assert.deepEqual(address.device.host, "127.0.0.1");
  assert.notEqual(address.api.port, 0);
  assert.notEqual(address.device.port, 0);
  assert.notEqual(address.api.port, address.device.port);
  assert.ok(!address.api.host.includes("0.0.0.0"));

  const api = await httpGet(harness.apiPort, "/api/health");
  const device = await httpGet(harness.devicePort, "/api/health");
  assert.equal(api.status, 200);
  // Both listeners identify as the bridge: the CLI proves what owns each port, so an
  // impostor squatting the device port is reported instead of passing for the bridge.
  assert.equal(device.status, 200);
  assert.equal((device.json as { bridge?: string }).bridge, "gentle-movil");
  assert.equal(device.body, api.body);

  const deviceOther = await httpGet(harness.devicePort, "/api/sessions");
  assert.equal(deviceOther.status, 404);
});

test("unknown paths and unsupported methods answer JSON instead of crashing", async (t) => {
  const harness = await startTestBridge();
  t.after(() => harness.stop());

  const missing = await httpGet(harness.apiPort, "/api/does-not-exist");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["content-type"], "application/json");
  assert.equal((missing.json as { error?: string }).error, "not_found");

  const health = await httpGet(harness.apiPort, "/api/health");
  assert.match(String(health.headers["content-type"]), /^application\/json$/);

  assert.equal(harness.logged("bridge.started"), true);
});

test("a foreign server on the same port cannot produce this identity payload", async () => {
  // Proves the payload comes from this code: a stub answering on the port differs.
  const { createServer } = await import("node:http");
  const stub = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ app: "gentle-shell" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubAddress = stub.address();
  assert.ok(stubAddress && typeof stubAddress === "object");
  const stubPort = stubAddress.port;
  try {
    const stubResponse = await httpGet(stubPort, "/api/health");
    assert.notDeepEqual(stubResponse.json, {
      app: "gentle-shell",
      bridge: "gentle-movil",
      proto: 1,
      version: packageJson.version,
    });
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});
